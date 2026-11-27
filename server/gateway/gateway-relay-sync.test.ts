import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprovalHost } from "../approvals/host.ts";
import { createIsolationHost } from "../isolation/host.ts";
import { createMemorySkillHost } from "../memory-skill/host.ts";
import { createPatrolHost } from "../patrol/host.ts";
import { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";
import { PortalEngine } from "../portal/engine.ts";
import { createTicketHost } from "../tickets/host.ts";
import { FeishuAdapter } from "./adapters.ts";
import { ChannelGatewayEngine } from "./engine.ts";
import type { GatewayThreadSink } from "./thread-sync.ts";

interface RecordedThreadMessage {
  role: "user" | "assistant" | "failure";
  text: string;
  source?: string;
  at: number;
}

describe("add-relay-bot-driver Steps 4 & 6: Feishu gateway RelayDriver dispatch and Web thread sync", () => {
  let tmpDir: string;
  let cleanupFns: Array<() => void>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-gw-relay-sync-"));
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupHarness(options: {
    fetchImpl: typeof fetch;
    feishuSendReply?: (input: { appId: string; chatId: string; replyToMessageId: string; text: string }) => Promise<void>;
  }) {
    const tickets = createTicketHost(tmpDir);
    const approvals = createApprovalHost(tmpDir);
    const patrol = createPatrolHost(tmpDir, { tickets: tickets.engine, approvals: approvals.engine });
    const memorySkill = createMemorySkillHost(tmpDir);
    const isolation = createIsolationHost(tmpDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
    const llmProxy = new ControlPlaneLlmProxy({ vault: approvals.engine.vault, fetchImpl: options.fetchImpl });
    const portal = new PortalEngine({
      dbPath: join(tmpDir, "portal.sqlite"),
      tickets: tickets.engine,
      approvals: approvals.engine,
      patrol: patrol.engine,
      memorySkill: memorySkill.engine,
      isolation: isolation.engine,
      llmProxy,
      autoBootstrapLlmEnv: false,
      bootstrapAdmin: { username: "admin", password: "AdminPassword#1" },
    });

    llmProxy.registerProvider({
      id: "deepseek-main",
      name: "DeepSeek Relay",
      baseUrl: "https://relay.example.test/v1",
      apiKey: "sk-relay-secret",
      defaultModel: "deepseek-v4-1-flash",
      fastModel: "deepseek-v4-1-flash",
      priority: 1,
      enabled: true,
    });

    const threads = new Map<string, { botId: string; title: string; messages: RecordedThreadMessage[] }>();
    const orderLog: string[] = [];
    let threadSeq = 0;

    const threadSink: GatewayThreadSink = {
      hasThread(botId, threadId) {
        return threads.get(threadId)?.botId === botId;
      },
      createThread(botId, title) {
        const id = `thread_feishu_${++threadSeq}`;
        threads.set(id, { botId, title, messages: [] });
        return id;
      },
      appendUserMessage(threadId, input) {
        orderLog.push(`thread:user:${input.text}`);
        threads.get(threadId)?.messages.push({
          role: "user",
          text: input.text,
          source: input.source,
          at: input.at,
        });
      },
      appendAssistantMessage(threadId, input) {
        orderLog.push(`thread:assistant:${input.text}`);
        threads.get(threadId)?.messages.push({
          role: "assistant",
          text: input.text,
          at: input.at,
        });
      },
      appendFailureMessage(threadId, input) {
        orderLog.push(`thread:failure:${input.error}`);
        threads.get(threadId)?.messages.push({
          role: "failure",
          text: input.error,
          at: input.at,
        });
      },
    };

    const feishuReplies: Array<{ chatId: string; replyToMessageId: string; text: string }> = [];
    const feishuAdapter = new FeishuAdapter({
      replySender: async (input) => {
        orderLog.push(`feishu:reply:${input.text}`);
        feishuReplies.push({ chatId: input.chatId, replyToMessageId: input.replyToMessageId, text: input.text });
        if (options.feishuSendReply) {
          await options.feishuSendReply(input);
        }
      },
    });

    // No custom dispatchToBot: exercises the real default RelayDriver path!
    const gateway = new ChannelGatewayEngine({
      dataDir: tmpDir,
      portal,
      threadSink,
      feishuAdapter,
    });

    cleanupFns.push(
      () => gateway.close(),
      () => portal.close(),
      () => isolation.close(),
      () => memorySkill.close(),
      () => patrol.close(),
      () => approvals.close(),
      () => tickets.close(),
    );

    const admin = portal.loginAdmin("admin", "AdminPassword#1").session;
    const customer = portal.createPortalUserAsAdmin(admin, {
      username: "latiao_user",
      password: "UserPass#123",
      role: "customer",
      tenantId: "tenant_latiao",
      autoSwitchSession: true,
    }).customerSession!.session;

    portal.bindFeishuIdentity(customer, "ou_latiao_owner");
    portal.createChannelBinding(customer, {
      botId: "bot_latiao",
      platform: "feishu",
      platformAppId: "cli_latiao_app",
      platformSecret: "secret_latiao",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      label: "辣条私聊",
    });

    return { portal, gateway, threads, feishuReplies, orderLog };
  }

  it("routes 3 Feishu DM messages through RelayDriver, reuses one Web thread, dual-writes in order, and deduplicates", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const { gateway, threads, feishuReplies, orderLog } = setupHarness({
      fetchImpl: async (_url, init) => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
        const userText = body.messages.at(-1)?.content ?? "";
        await new Promise((r) => setTimeout(r, 15));
        activeCalls -= 1;
        return new Response(
          JSON.stringify({
            id: `cmpl_${userText}`,
            object: "chat.completion",
            model: "deepseek-v4-1-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `DeepSeek回复:${userText}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await gateway.start();

    // Send 3 messages (including out-of-order concurrent arrival + 1 duplicate event_id)
    const p1 = gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_dm_1",
      messageId: "om_1",
      appId: "cli_latiao_app",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      senderId: "ou_latiao_owner",
      text: "第一条消息",
      mentionedBot: false,
      rawTimestampMs: 1000,
    });
    const p3 = gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_dm_3",
      messageId: "om_3",
      appId: "cli_latiao_app",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      senderId: "ou_latiao_owner",
      text: "第三条消息",
      mentionedBot: false,
      rawTimestampMs: 3000,
    });
    const p2 = gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_dm_2",
      messageId: "om_2",
      appId: "cli_latiao_app",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      senderId: "ou_latiao_owner",
      text: "第二条消息",
      mentionedBot: false,
      rawTimestampMs: 2000,
    });
    const pDup = gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_dm_1",
      messageId: "om_1",
      appId: "cli_latiao_app",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      senderId: "ou_latiao_owner",
      text: "第一条消息",
      mentionedBot: false,
      rawTimestampMs: 1000,
    });

    const [r1, r3, r2, rDup] = await Promise.all([p1, p3, p2, pDup]);
    expect(r1.status).toBe("routed");
    expect(r2.status).toBe("routed");
    expect(r3.status).toBe("routed");
    expect(rDup.status).toBe("duplicate");

    // Never ran concurrent model calls on the same thread
    expect(maxConcurrentCalls).toBe(1);

    // Reused a single Web thread for (bot_latiao, ou_latiao_owner, oc_dm_latiao)
    expect(threads.size).toBe(1);
    const threadId = r1.threadId!;
    expect(r2.threadId).toBe(threadId);
    expect(r3.threadId).toBe(threadId);

    const msgs = threads.get(threadId)!.messages;
    expect(msgs).toHaveLength(6);
    expect(msgs.filter((m) => m.role === "user").map((m) => ({ text: m.text, source: m.source }))).toEqual([
      { text: "第一条消息", source: "feishu" },
      { text: "第二条消息", source: "feishu" },
      { text: "第三条消息", source: "feishu" },
    ]);
    expect(msgs.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
      "DeepSeek回复:第一条消息",
      "DeepSeek回复:第二条消息",
      "DeepSeek回复:第三条消息",
    ]);

    // Feishu received 3 replies in exact order, never placeholder "[bot_latiao] 已收到消息"
    expect(feishuReplies.map((r) => r.text)).toEqual([
      "DeepSeek回复:第一条消息",
      "DeepSeek回复:第二条消息",
      "DeepSeek回复:第三条消息",
    ]);

    // Dual-write order: thread user -> thread assistant -> feishu reply
    expect(orderLog.slice(0, 3)).toEqual([
      "thread:user:第一条消息",
      "thread:assistant:DeepSeek回复:第一条消息",
      "feishu:reply:DeepSeek回复:第一条消息",
    ]);

    await gateway.stop();
  });

  it("writes failure record to Web thread and sends 处理失败，请重试 to Feishu when relay fails", async () => {
    const { gateway, threads, feishuReplies } = setupHarness({
      fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
    });

    await gateway.start();
    const out = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_fail_1",
      messageId: "om_fail_1",
      appId: "cli_latiao_app",
      chatId: "oc_dm_latiao",
      chatType: "p2p",
      senderId: "ou_latiao_owner",
      text: "帮我查一下",
      mentionedBot: false,
      rawTimestampMs: 5000,
    });

    expect(out.status).toBe("failed");
    const msgs = threads.get(out.threadId!)!.messages;
    expect(msgs.some((m) => m.role === "user" && m.source === "feishu")).toBe(true);
    expect(msgs.some((m) => m.role === "failure")).toBe(true);
    expect(feishuReplies.at(-1)?.text).toBe("处理失败，请重试");

    await gateway.stop();
  });
});
