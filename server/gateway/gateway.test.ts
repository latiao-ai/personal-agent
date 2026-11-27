import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprovalHost } from "../approvals/host.ts";
import { createIsolationHost } from "../isolation/host.ts";
import { createMemorySkillHost } from "../memory-skill/host.ts";
import { createPatrolHost } from "../patrol/host.ts";
import { PortalEngine } from "../portal/engine.ts";
import { createTicketHost } from "../tickets/host.ts";
import { WeComAdapter, WeixinAdapter } from "./adapters.ts";
import { ChannelGatewayEngine } from "./engine.ts";

describe("add-unified-login: multi-platform resident gateway (Feishu + Weixin iLink)", () => {
  let tmpDir: string;
  let portal: PortalEngine;
  let gateway: ChannelGatewayEngine;
  let cleanupFns: Array<() => void>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-gateway-"));
    const tickets = createTicketHost(tmpDir);
    const approvals = createApprovalHost(tmpDir);
    const patrol = createPatrolHost(tmpDir, { tickets: tickets.engine, approvals: approvals.engine });
    const memorySkill = createMemorySkillHost(tmpDir);
    const isolation = createIsolationHost(tmpDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
    portal = new PortalEngine({
      dbPath: join(tmpDir, "portal.sqlite"),
      tickets: tickets.engine,
      approvals: approvals.engine,
      patrol: patrol.engine,
      memorySkill: memorySkill.engine,
      isolation: isolation.engine,
      bootstrapAdmin: { username: "admin", password: "AdminPassword#1" },
    });

    gateway = new ChannelGatewayEngine({
      dataDir: tmpDir,
      portal,
      dispatchToBot: async (req) => `reply-from-${req.botId}:${req.text}`,
    });
    await gateway.start();

    cleanupFns = [
      () => gateway.close(),
      () => portal.close(),
      () => isolation.close(),
      () => memorySkill.close(),
      () => patrol.close(),
      () => approvals.close(),
      () => tickets.close(),
    ];
  });

  afterEach(async () => {
    await gateway.stop();
    for (const fn of cleanupFns) fn();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupCustomer(username: string, tenantId: string) {
    const admin = portal.loginAdmin("admin", "AdminPassword#1").session;
    const created = portal.createPortalUserAsAdmin(admin, {
      username,
      password: "UserPass#123",
      role: "customer",
      tenantId,
      autoSwitchSession: true,
    });
    return created.customerSession!.session;
  }

  it("routes any bound non-manager Bot in Feishu groups, blocks duplicate chat bindings, and honors unbind", async () => {
    const session = setupCustomer("alice", "tenant_alice");
    portal.bindFeishuIdentity(session, "ou_alice");

    // Bind non-manager bot "dr-eggbot" to two internal groups
    const b1 = portal.createChannelBinding(session, {
      botId: "dr-eggbot",
      platform: "feishu",
      platformAppId: "cli_app_1",
      platformSecret: "secret_value_never_in_db",
      chatId: "oc_group_1",
      chatType: "group",
      label: "内部测试群 1",
    });
    portal.createChannelBinding(session, {
      botId: "dr-eggbot",
      platform: "feishu",
      platformAppId: "cli_app_1",
      chatId: "oc_group_2",
      chatType: "group",
      label: "内部测试群 2",
    });

    // Secret went to ControlPlaneVault, not plaintext binding
    expect(portal.approvals.vault.listSecretNames("tenant_alice")).toContain("channel:feishu:cli_app_1:app_secret");

    // Binding a second bot to the same chat is rejected (409)
    expect(() =>
      portal.createChannelBinding(session, {
        botId: "bot_chief_of_staff",
        platform: "feishu",
        platformAppId: "cli_app_2",
        chatId: "oc_group_1",
        chatType: "group",
      }),
    ).toThrow(/先解绑/);

    // Group @-mention in group 1 and group 2 both route to dr-eggbot
    const out1 = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_1",
      messageId: "om_1",
      appId: "cli_app_1",
      chatId: "oc_group_1",
      chatType: "group",
      senderId: "ou_alice",
      text: "@dr-eggbot 帮我查一下",
      mentionedBot: true,
    });
    expect(out1.status).toBe("routed");
    expect(out1.botId).toBe("dr-eggbot");
    expect(gateway.feishu.sentReplies).toHaveLength(1);
    expect(gateway.feishu.sentReplies[0]?.text).toContain("reply-from-dr-eggbot");

    // Duplicate event_id is ignored (no duplicate reply)
    const dup = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_1",
      messageId: "om_1",
      appId: "cli_app_1",
      chatId: "oc_group_1",
      chatType: "group",
      senderId: "ou_alice",
      text: "@dr-eggbot 帮我查一下",
      mentionedBot: true,
    });
    expect(dup.status).toBe("duplicate");
    expect(gateway.feishu.sentReplies).toHaveLength(1);

    const out2 = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_2",
      messageId: "om_2",
      appId: "cli_app_1",
      chatId: "oc_group_2",
      chatType: "group",
      senderId: "ou_alice",
      text: "@dr-eggbot 第二个群",
      mentionedBot: true,
    });
    expect(out2.status).toBe("routed");
    expect(gateway.feishu.sentReplies).toHaveLength(2);

    // Unbind group 1 -> subsequent @ is rejected and logged
    portal.unbindChannelBinding(session, b1.binding.id);
    const afterUnbind = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_3",
      messageId: "om_3",
      appId: "cli_app_1",
      chatId: "oc_group_1",
      chatType: "group",
      senderId: "ou_alice",
      text: "@dr-eggbot 解绑后测试",
      mentionedBot: true,
    });
    expect(afterUnbind.status).toBe("rejected");
    expect(afterUnbind.reason).toBe("no_active_binding");
  });

  it("enforces tenant allowlist isolation, unbound sender rejection, and unknown-chat rejection", async () => {
    const sessA = setupCustomer("tenant_a_user", "tenant_a");
    const sessB = setupCustomer("tenant_b_user", "tenant_b");
    portal.bindFeishuIdentity(sessA, "ou_a1");
    portal.bindFeishuIdentity(sessB, "ou_b1");

    portal.createChannelBinding(sessA, {
      botId: "bot_a",
      platform: "feishu",
      platformAppId: "cli_a",
      chatId: "oc_a",
      chatType: "group",
    });
    portal.createChannelBinding(sessB, {
      botId: "bot_b",
      platform: "feishu",
      platformAppId: "cli_b",
      chatId: "oc_b",
      chatType: "group",
    });

    // Tenant A changes allowlist -> Tenant B allowlist stays untouched
    portal.setTenantChannelAllowlist(sessA, "feishu", ["ou_a_only"]);
    expect(portal.getTenantChannelAllowlist(sessB, "feishu").allowedSenderIds).toEqual([]);

    // Tenant A rejects ou_a1 now because allowlist only permits ou_a_only
    const deniedA = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_a_deny",
      messageId: "om_a_deny",
      appId: "cli_a",
      chatId: "oc_a",
      chatType: "group",
      senderId: "ou_a1",
      text: "@bot_a hi",
      mentionedBot: true,
    });
    expect(deniedA.status).toBe("rejected");
    expect(deniedA.reason).toBe("sender_not_allowlisted");

    // Tenant B still routes ou_b1 normally
    const okB = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_b_ok",
      messageId: "om_b_ok",
      appId: "cli_b",
      chatId: "oc_b",
      chatType: "group",
      senderId: "ou_b1",
      text: "@bot_b hi",
      mentionedBot: true,
    });
    expect(okB.status).toBe("routed");

    // Unbound Feishu sender in tenant B is rejected
    const unbound = await gateway.handleInbound({
      platform: "feishu",
      eventId: "evt_b_unbound",
      messageId: "om_b_unbound",
      appId: "cli_b",
      chatId: "oc_b",
      chatType: "group",
      senderId: "ou_stranger",
      text: "@bot_b hi",
      mentionedBot: true,
    });
    expect(unbound.status).toBe("rejected");
    expect(unbound.reason).toBe("feishu_identity_unbound");
  });

  it("supports Personal WeChat iLink DM, keeps WeixinIdentity separate, and leaves WeCom as placeholder", async () => {
    const session = setupCustomer("wx_user", "tenant_wx");
    const qr = gateway.weixin.startIlinkQrLogin();
    expect(qr.groupSupportNote).toContain("私聊为主");
    const confirmed = gateway.weixin.confirmIlinkQrLogin(qr.sessionId, "bot_wx_01@im.bot");
    expect(confirmed?.status).toBe("confirmed");

    portal.bindWeixinIdentity(session, {
      weixinOpenId: "wx_sender_1",
      ilinkAccountId: confirmed!.ilinkAccountId!,
    });
    // Stored in weixin_identities, NOT user_identities
    expect(portal.listFeishuIdentities(session)).toHaveLength(0);
    expect(portal.listWeixinIdentities(session)).toHaveLength(1);

    portal.createChannelBinding(session, {
      botId: "bot_wx_helper",
      platform: "weixin",
      platformAppId: confirmed!.ilinkAccountId!,
      platformSecret: "ilink_secret_token",
      chatId: "wx_dm_1",
      chatType: "p2p",
    });

    const dm = await gateway.handleInbound({
      platform: "weixin",
      eventId: "wx_evt_1",
      messageId: "wx_msg_1",
      appId: "bot_wx_01@im.bot",
      chatId: "wx_dm_1",
      chatType: "p2p",
      senderId: "wx_sender_1",
      text: "你好微信助手",
      mentionedBot: false,
    });
    expect(dm.status).toBe("routed");
    expect(gateway.weixin.sentReplies).toHaveLength(1);
    expect(WeixinAdapter.GROUP_LIMITATION_NOTE).toContain("私聊为主");

    // WeComAdapter is strictly a placeholder
    const wecom = new WeComAdapter();
    expect(wecom.getStatus().state).toBe("placeholder");
    await expect(wecom.sendReply()).rejects.toThrow(/wecom_not_implemented/);
  });

  it("detects conflicting external consumers (feishu_gateway.py / lark-cli) and handles reconnect", async () => {
    const conflictingGateway = new ChannelGatewayEngine({
      dataDir: tmpDir,
      portal,
      detectExternalConsumers: () => [{ processName: "lark-cli", detail: "app_id=cli_123" }],
    });
    await expect(conflictingGateway.start()).rejects.toThrow(/gateway_consumer_conflict/);
    conflictingGateway.close();

    // Exponential backoff reconnect state transition
    const d1 = gateway.feishu.markReconnecting("network_down");
    expect(d1).toBe(2000);
    expect(gateway.feishu.getStatus().state).toBe("reconnecting");
    const d2 = gateway.feishu.markReconnecting("still_down");
    expect(d2).toBe(5000);
    gateway.feishu.markReconnected();
    expect(gateway.feishu.getStatus().state).toBe("online");
  });
});
