import { randomBytes, randomUUID } from "node:crypto";

import type {
  GatewayAdapterState,
  GatewayAdapterStatus,
  GatewayPlatformName,
  NormalizedInboundMessage,
  WeixinIlinkQrSession,
} from "../../shared/gateway.ts";
import type { ChannelBinding } from "../../shared/portal.ts";

export type InboundMessageHandler = (message: NormalizedInboundMessage) => Promise<void> | void;

export interface ChannelAdapter {
  readonly platform: GatewayPlatformName;
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(bindings: ChannelBinding[]): void;
  sendReply(target: { chatId: string; replyToMessageId: string; appId: string; text: string }): Promise<void>;
  getStatus(): GatewayAdapterStatus;
  onMessage(handler: InboundMessageHandler): () => void;
}

export interface AdapterReplyRecord {
  platform: "feishu" | "weixin";
  appId: string;
  chatId: string;
  replyToMessageId: string;
  text: string;
  at: number;
}

export type ReplySender = (record: AdapterReplyRecord) => Promise<void> | void;

/**
 * Feishu long-connection (WebSocket) adapter following Hermes gateway layering.
 * Permissions required: im:message, im.message.receive_v1, im:message:send_as_bot,
 * im:message:send (card callbacks), im:resource, im:chat, card.action.trigger.
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly platform = "feishu" as const;
  private state: GatewayAdapterState = "offline";
  private activeBindings: ChannelBinding[] = [];
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private readonly listeners = new Set<InboundMessageHandler>();
  private readonly replySender?: ReplySender;
  readonly sentReplies: AdapterReplyRecord[] = [];
  private reconnectDelayMs = 2_000;
  private readonly now: () => number;

  constructor(options?: { replySender?: ReplySender; now?: () => number }) {
    this.replySender = options?.replySender;
    this.now = options?.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.state = "online";
    this.lastError = null;
    this.reconnectDelayMs = 2_000;
  }

  async stop(): Promise<void> {
    this.state = "offline";
  }

  reload(bindings: ChannelBinding[]): void {
    this.activeBindings = bindings.filter((b) => b.platform === "feishu" && b.status === "active");
  }

  /** Simulates or handles a WebSocket disconnect and exponential backoff reconnect (2s->5s->10s->30s->60s). */
  markReconnecting(reason: string): number {
    this.state = "reconnecting";
    this.lastError = reason;
    const delay = this.reconnectDelayMs;
    const ladder = [2_000, 5_000, 10_000, 30_000, 60_000];
    const nextIdx = Math.min(ladder.indexOf(delay) + 1, ladder.length - 1);
    this.reconnectDelayMs = ladder[nextIdx] ?? 60_000;
    return delay;
  }

  markReconnected(): void {
    this.state = "online";
    this.lastError = null;
    this.reconnectDelayMs = 2_000;
  }

  async ingestEvent(message: Omit<NormalizedInboundMessage, "platform">): Promise<void> {
    this.lastEventAt = this.now();
    const normalized: NormalizedInboundMessage = { ...message, platform: "feishu" };
    for (const listener of this.listeners) {
      await listener(normalized);
    }
  }

  async sendReply(target: { chatId: string; replyToMessageId: string; appId: string; text: string }): Promise<void> {
    const record: AdapterReplyRecord = {
      platform: "feishu",
      appId: target.appId,
      chatId: target.chatId,
      replyToMessageId: target.replyToMessageId,
      text: target.text,
      at: this.now(),
    };
    this.sentReplies.push(record);
    if (this.replySender) {
      await this.replySender(record);
    }
  }

  getStatus(): GatewayAdapterStatus {
    return {
      platform: "feishu",
      state: this.state,
      activeBindings: this.activeBindings.length,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      note: "WebSocket 长连接模式（支持私聊与内部群 @ 回复）",
    };
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
}

const ILINK_QR_TTL_MS = 5 * 60_000;

/**
 * Personal WeChat (Weixin) adapter via Tencent iLink Bot API (long-polling + QR bind).
 * Generates an iLink bot identity (xxx@im.bot); DM-first (ordinary WeChat groups are not promised).
 */
export class WeixinAdapter implements ChannelAdapter {
  readonly platform = "weixin" as const;
  private state: GatewayAdapterState = "offline";
  private activeBindings: ChannelBinding[] = [];
  private lastEventAt: number | null = null;
  private lastError: string | null = null;
  private readonly listeners = new Set<InboundMessageHandler>();
  private readonly replySender?: ReplySender;
  readonly sentReplies: AdapterReplyRecord[] = [];
  private readonly qrSessions = new Map<string, WeixinIlinkQrSession>();
  private readonly now: () => number;

  static readonly GROUP_LIMITATION_NOTE = "个人微信以私聊为主（iLink 机器人一般不能进普通微信群，不承诺群聊回复）";

  constructor(options?: { replySender?: ReplySender; now?: () => number }) {
    this.replySender = options?.replySender;
    this.now = options?.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.state = "online";
    this.lastError = null;
  }

  async stop(): Promise<void> {
    this.state = "offline";
  }

  reload(bindings: ChannelBinding[]): void {
    this.activeBindings = bindings.filter((b) => b.platform === "weixin" && b.status === "active");
  }

  startIlinkQrLogin(): WeixinIlinkQrSession {
    const now = this.now();
    const sessionId = `ilink_qr_${randomBytes(12).toString("hex")}`;
    const session: WeixinIlinkQrSession = {
      sessionId,
      qrUrl: `https://ilink.weixin.qq.com/bot/qr?session=${encodeURIComponent(sessionId)}`,
      status: "pending",
      ilinkAccountId: null,
      createdAt: now,
      expiresAt: now + ILINK_QR_TTL_MS,
      groupSupportNote: WeixinAdapter.GROUP_LIMITATION_NOTE,
    };
    this.qrSessions.set(sessionId, session);
    return { ...session };
  }

  confirmIlinkQrLogin(sessionId: string, ilinkAccountId?: string): WeixinIlinkQrSession | null {
    const existing = this.qrSessions.get(sessionId);
    if (!existing) return null;
    if (this.now() > existing.expiresAt) {
      existing.status = "expired";
      return { ...existing };
    }
    const accountId = ilinkAccountId?.trim() || `bot_${randomUUID().slice(0, 8)}@im.bot`;
    existing.status = "confirmed";
    existing.ilinkAccountId = accountId;
    return { ...existing };
  }

  getIlinkQrSession(sessionId: string): WeixinIlinkQrSession | null {
    const existing = this.qrSessions.get(sessionId);
    if (!existing) return null;
    if (existing.status === "pending" && this.now() > existing.expiresAt) {
      existing.status = "expired";
    }
    return { ...existing };
  }

  async ingestEvent(message: Omit<NormalizedInboundMessage, "platform">): Promise<void> {
    this.lastEventAt = this.now();
    const normalized: NormalizedInboundMessage = { ...message, platform: "weixin" };
    for (const listener of this.listeners) {
      await listener(normalized);
    }
  }

  async sendReply(target: { chatId: string; replyToMessageId: string; appId: string; text: string }): Promise<void> {
    const record: AdapterReplyRecord = {
      platform: "weixin",
      appId: target.appId,
      chatId: target.chatId,
      replyToMessageId: target.replyToMessageId,
      text: target.text,
      at: this.now(),
    };
    this.sentReplies.push(record);
    if (this.replySender) {
      await this.replySender(record);
    }
  }

  getStatus(): GatewayAdapterStatus {
    return {
      platform: "weixin",
      state: this.state,
      activeBindings: this.activeBindings.length,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      note: WeixinAdapter.GROUP_LIMITATION_NOTE,
    };
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
}

/**
 * Enterprise WeChat (WeCom) placeholder adapter — explicitly out of scope for add-unified-login.
 * Does not connect to wss://openws.work.weixin.qq.com.
 */
export class WeComAdapter implements ChannelAdapter {
  readonly platform = "wecom" as const;

  async start(): Promise<void> {
    // Intentionally a no-op placeholder.
  }

  async stop(): Promise<void> {
    // Intentionally a no-op placeholder.
  }

  reload(_bindings: ChannelBinding[]): void {
    // Intentionally a no-op placeholder.
  }

  async sendReply(): Promise<void> {
    throw new Error("wecom_not_implemented: 企业微信（WeCom）适配器本次为占位，暂未接通");
  }

  getStatus(): GatewayAdapterStatus {
    return {
      platform: "wecom",
      state: "placeholder",
      activeBindings: 0,
      lastEventAt: null,
      lastError: null,
      note: "企业微信（WeCom）本次仅留占位接口，未接通",
    };
  }

  onMessage(): () => void {
    return () => {};
  }
}
