import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  GatewayHealthSnapshot,
  GatewayLogEntry,
  GatewayPlatformName,
  NormalizedInboundMessage,
} from "../../shared/gateway.ts";
import type { PortalEngine } from "../portal/engine.ts";
import { FeishuAdapter, WeComAdapter, WeixinAdapter } from "./adapters.ts";

export interface BotDispatchRequest {
  tenantId: string;
  botId: string;
  platform: "feishu" | "weixin";
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  userId: string;
  text: string;
}

export type BotDispatcher = (request: BotDispatchRequest) => Promise<string | null> | string | null;

export interface ExternalConsumerConflict {
  processName: string;
  detail: string;
}

export interface ChannelGatewayOptions {
  dataDir: string;
  portal: PortalEngine;
  dispatchToBot?: BotDispatcher;
  feishuAdapter?: FeishuAdapter;
  weixinAdapter?: WeixinAdapter;
  detectExternalConsumers?: () => ExternalConsumerConflict[];
  now?: () => number;
}

export interface GatewayDispatchOutcome {
  status: "routed" | "duplicate" | "rejected";
  reason?: string;
  tenantId?: string;
  botId?: string;
  replyText?: string;
}

const MAX_LOG_ENTRIES = 500;

/**
 * Control-plane resident multi-platform messaging gateway (Hermes-style layering with multi-tenant isolation).
 * One process hosts FeishuAdapter + WeixinAdapter (+ WeComAdapter placeholder), enforces unique consumer
 * locking, deduplicates by event_id, and routes strictly by ChannelBinding + tenant_id + identity/allowlist.
 */
export class ChannelGatewayEngine {
  readonly portal: PortalEngine;
  readonly feishu: FeishuAdapter;
  readonly weixin: WeixinAdapter;
  readonly wecom: WeComAdapter;
  private readonly lockFilePath: string;
  private readonly db: DatabaseSync;
  private readonly dispatchToBot: BotDispatcher;
  private readonly detectExternalConsumers?: () => ExternalConsumerConflict[];
  private readonly now: () => number;
  private readonly logs: GatewayLogEntry[] = [];
  private readonly unsubscribes: Array<() => void> = [];

  private running = false;
  private startedAt: number | null = null;
  private routedCount = 0;
  private rejectedCount = 0;
  private duplicateCount = 0;

  constructor(options: ChannelGatewayOptions) {
    this.portal = options.portal;
    this.now = options.now ?? Date.now;
    this.feishu = options.feishuAdapter ?? new FeishuAdapter({ now: this.now });
    this.weixin = options.weixinAdapter ?? new WeixinAdapter({ now: this.now });
    this.wecom = new WeComAdapter();
    this.detectExternalConsumers = options.detectExternalConsumers;
    this.dispatchToBot =
      options.dispatchToBot ??
      (async (req) => `[${req.botId}] 已收到消息：${req.text}`);

    this.lockFilePath = join(options.dataDir, "gateway-consumer.lock");
    const dbPath = join(options.dataDir, "gateway-deliveries.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gateway_events (
        platform TEXT NOT NULL,
        event_id TEXT NOT NULL,
        tenant_id TEXT,
        bot_id TEXT,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (platform, event_id)
      );
    `);

    this.unsubscribes.push(
      this.feishu.onMessage(async (msg) => {
        await this.handleInbound(msg);
      }),
      this.weixin.onMessage(async (msg) => {
        await this.handleInbound(msg);
      }),
      this.portal.onChannelBindingsChanged(() => {
        this.reloadBindings();
      }),
    );
  }

  private pushLog(entry: Omit<GatewayLogEntry, "id" | "at">): void {
    this.logs.unshift({
      id: `gwlog_${randomUUID()}`,
      at: this.now(),
      ...entry,
    });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.length = MAX_LOG_ENTRIES;
    }
  }

  private acquireUniqueConsumerLock(): void {
    const conflicts = this.detectExternalConsumers?.() ?? [];
    if (conflicts.length > 0) {
      const summary = conflicts.map((c) => `${c.processName}(${c.detail})`).join(", ");
      this.pushLog({
        level: "error",
        platform: "feishu",
        eventType: "consumer_conflict",
        message: `检测到冲突的长连接消费者，请先停止旧进程：${summary}`,
      });
      throw new Error(`gateway_consumer_conflict: 检测到冲突消费者 ${summary}，请先停止手动脚本或 lark-cli`);
    }
    if (existsSync(this.lockFilePath)) {
      try {
        const existing = JSON.parse(readFileSync(this.lockFilePath, "utf8")) as { pid?: number };
        if (typeof existing.pid === "number" && existing.pid !== process.pid && isPidAlive(existing.pid)) {
          throw new Error(
            `gateway_consumer_conflict: 已有常驻网关进程运行中 (PID=${existing.pid})，拒绝启动第二个消费者`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("gateway_consumer_conflict:")) {
          throw err;
        }
      }
    }
    writeFileSync(
      this.lockFilePath,
      JSON.stringify({ pid: process.pid, startedAt: this.now(), consumer: "openmausbot-resident-gateway" }),
      { mode: 0o600 },
    );
  }

  private releaseUniqueConsumerLock(): void {
    if (!existsSync(this.lockFilePath)) return;
    try {
      const existing = JSON.parse(readFileSync(this.lockFilePath, "utf8")) as { pid?: number };
      if (existing.pid === process.pid) {
        unlinkSync(this.lockFilePath);
      }
    } catch {
      // Best-effort cleanup on shutdown.
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.acquireUniqueConsumerLock();
    this.reloadBindings();
    await this.feishu.start();
    await this.weixin.start();
    await this.wecom.start();
    this.running = true;
    this.startedAt = this.now();
    this.pushLog({
      level: "info",
      platform: "feishu",
      eventType: "gateway_started",
      message: `常驻多平台网关已启动（PID=${process.pid}，声明唯一消费者）`,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.feishu.stop();
    await this.weixin.stop();
    await this.wecom.stop();
    this.running = false;
    this.releaseUniqueConsumerLock();
    this.pushLog({
      level: "info",
      platform: "feishu",
      eventType: "gateway_stopped",
      message: "常驻多平台网关已停止",
    });
  }

  close(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.releaseUniqueConsumerLock();
    this.db.close();
  }

  reloadBindings(): void {
    const active = this.portal.store.listChannelBindings({ status: "active" });
    this.feishu.reload(active);
    this.weixin.reload(active);
    this.wecom.reload(active);
    this.pushLog({
      level: "info",
      platform: "feishu",
      eventType: "bindings_reloaded",
      message: `已热加载 ${active.length} 条活跃消息平台绑定`,
    });
  }

  /** Routes a normalized inbound message strictly by ChannelBinding -> tenant_id -> identity/allowlist -> bot. */
  async handleInbound(message: NormalizedInboundMessage): Promise<GatewayDispatchOutcome> {
    // 1. Event-level deduplication (prevents duplicate replies on Feishu/Weixin redelivery).
    const existingEvent = this.db
      .prepare(`SELECT status FROM gateway_events WHERE platform = ? AND event_id = ?`)
      .get(message.platform, message.eventId) as { status?: string } | undefined;
    if (existingEvent) {
      this.duplicateCount += 1;
      this.pushLog({
        level: "info",
        platform: message.platform,
        eventType: "duplicate_event_ignored",
        chatId: message.chatId,
        message: `忽略重复事件 ${message.eventId}`,
      });
      return { status: "duplicate", reason: "duplicate_event_id" };
    }

    // 2. Group @-mention gating (group chats require explicit @bot; Weixin group is not promised).
    if (message.chatType === "group" && !message.mentionedBot) {
      return this.rejectEvent(message, "group_mention_required", "群聊未 @ 机器人，已忽略");
    }

    // 3. Lookup active ChannelBinding by (platform, chatId).
    const binding = this.portal.store.findActiveChannelBinding(message.platform, message.chatId);
    if (!binding) {
      return this.rejectEvent(
        message,
        "no_active_binding",
        `会话 ${message.chatId} 未绑定活跃 Bot，拒绝转发`,
      );
    }

    // 4. Verify platform appId matches binding (prevents spoofed cross-app injection).
    if (binding.platformAppId !== message.appId) {
      return this.rejectEvent(
        message,
        "app_id_mismatch",
        `消息应用 ${message.appId} 与绑定应用 ${binding.platformAppId} 不匹配`,
        binding.tenantId,
        binding.botId,
      );
    }

    // 5. Verify tenant VM exists and bot is enabled for this tenant.
    const vm = this.portal.isolation.store.getTenantVm(binding.tenantId);
    if (!vm) {
      return this.rejectEvent(
        message,
        "tenant_not_found",
        `绑定租户 ${binding.tenantId} 不存在`,
        binding.tenantId,
        binding.botId,
      );
    }
    const botStates = this.portal.store.getBotStates(binding.tenantId);
    if (botStates.get(binding.botId)?.enabled === false) {
      return this.rejectEvent(
        message,
        "bot_disabled",
        `Bot ${binding.botId} 已被客户停用`,
        binding.tenantId,
        binding.botId,
      );
    }

    // 6. Verify per-tenant allowlist (stored in DB, strictly isolated by tenant_id).
    const allowlist = this.portal.store.getTenantChannelAllowlist(binding.tenantId, message.platform);
    if (allowlist && allowlist.allowedSenderIds.length > 0 && !allowlist.allowedSenderIds.includes(message.senderId)) {
      return this.rejectEvent(
        message,
        "sender_not_allowlisted",
        `发送者 ${message.senderId} 不在租户 ${binding.tenantId} 的白名单内`,
        binding.tenantId,
        binding.botId,
      );
    }

    // 7. Verify sender identity linking (UserIdentity for Feishu, WeixinIdentity for Weixin).
    let resolvedUserId: string;
    if (message.platform === "feishu") {
      const identity = this.portal.store.findFeishuIdentity(binding.tenantId, message.senderId);
      if (!identity) {
        return this.rejectEvent(
          message,
          "feishu_identity_unbound",
          `飞书账号 ${message.senderId} 尚未在门户绑定租户 ${binding.tenantId}`,
          binding.tenantId,
          binding.botId,
        );
      }
      resolvedUserId = identity.userId;
    } else {
      const identity = this.portal.store.findWeixinIdentity(binding.tenantId, message.senderId);
      if (!identity) {
        return this.rejectEvent(
          message,
          "weixin_identity_unbound",
          `微信账号 ${message.senderId} 尚未在门户绑定租户 ${binding.tenantId}`,
          binding.tenantId,
          binding.botId,
        );
      }
      resolvedUserId = identity.userId;
    }

    // 8. Record event as accepted & dispatch to the target Bot in this tenant.
    this.recordEvent(message.platform, message.eventId, binding.tenantId, binding.botId, "routed");
    const replyText = await this.dispatchToBot({
      tenantId: binding.tenantId,
      botId: binding.botId,
      platform: message.platform,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
      userId: resolvedUserId,
      text: message.text,
    });

    if (replyText) {
      const adapter = message.platform === "feishu" ? this.feishu : this.weixin;
      await adapter.sendReply({
        appId: binding.platformAppId,
        chatId: message.chatId,
        replyToMessageId: message.messageId,
        text: replyText,
      });
    }

    this.routedCount += 1;
    this.pushLog({
      level: "info",
      platform: message.platform,
      eventType: "message_routed",
      tenantId: binding.tenantId,
      botId: binding.botId,
      chatId: message.chatId,
      message: `消息 ${message.messageId} 已路由至 Bot ${binding.botId}（租户 ${binding.tenantId}）`,
    });

    return {
      status: "routed",
      tenantId: binding.tenantId,
      botId: binding.botId,
      replyText: replyText ?? undefined,
    };
  }

  private rejectEvent(
    message: NormalizedInboundMessage,
    reason: string,
    detail: string,
    tenantId?: string,
    botId?: string,
  ): GatewayDispatchOutcome {
    this.recordEvent(message.platform, message.eventId, tenantId ?? null, botId ?? null, `rejected:${reason}`);
    this.rejectedCount += 1;
    this.pushLog({
      level: "warn",
      platform: message.platform,
      eventType: reason,
      tenantId,
      botId,
      chatId: message.chatId,
      message: detail,
    });
    return { status: "rejected", reason, tenantId, botId };
  }

  private recordEvent(
    platform: GatewayPlatformName,
    eventId: string,
    tenantId: string | null,
    botId: string | null,
    status: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO gateway_events (platform, event_id, tenant_id, bot_id, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(platform, eventId, tenantId, botId, status, this.now());
  }

  getHealthSnapshot(): GatewayHealthSnapshot {
    return {
      running: this.running,
      pid: process.pid,
      startedAt: this.startedAt,
      uniqueConsumerLock: this.running ? this.lockFilePath : null,
      adapters: [this.feishu.getStatus(), this.weixin.getStatus(), this.wecom.getStatus()],
      routedCount: this.routedCount,
      rejectedCount: this.rejectedCount,
      duplicateCount: this.duplicateCount,
    };
  }

  listLogs(filter?: { tenantId?: string; limit?: number }): GatewayLogEntry[] {
    const limit = filter?.limit ?? 100;
    const filtered = filter?.tenantId
      ? this.logs.filter((entry) => entry.tenantId === filter.tenantId)
      : this.logs;
    return filtered.slice(0, limit);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
