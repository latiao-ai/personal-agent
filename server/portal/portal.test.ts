import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalEngine } from "../approvals/engine.ts";
import { IsolationEngine } from "../isolation/engine.ts";
import { MemorySkillEngine } from "../memory-skill/engine.ts";
import { PatrolEngine } from "../patrol/engine.ts";
import { createPortalRoutes } from "../routes/portal.ts";
import { TicketEngine } from "../tickets/engine.ts";
import { PortalEngine } from "./engine.ts";

interface Harness {
  dir: string;
  tickets: TicketEngine;
  approvals: ApprovalEngine;
  patrol: PatrolEngine;
  memorySkill: MemorySkillEngine;
  isolation: IsolationEngine;
  portal: PortalEngine;
  callRoute: (
    method: string,
    pathWithQuery: string,
    options?: { body?: unknown; token?: string; cookie?: string },
  ) => Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }>;
  close: () => void;
}

function createTestHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "omb-portal-test-"));
  const allowlist = new Set(["ou_boss_a", "ou_ops_a", "ou_boss_b"]);
  const tickets = new TicketEngine({
    dbPath: join(dir, "tickets.sqlite"),
    allowlist,
  });
  const approvals = new ApprovalEngine({
    dbPath: join(dir, "approvals.sqlite"),
  });
  const patrol = new PatrolEngine({
    dbPath: join(dir, "patrol.sqlite"),
    tickets,
    approvals,
  });
  const memorySkill = new MemorySkillEngine({
    dbPath: join(dir, "memory-skill.sqlite"),
  });
  const isolation = new IsolationEngine({
    dbPath: join(dir, "isolation.sqlite"),
    dataDir: join(dir, "isolation-data"),
    memorySkill,
    vault: approvals.vault,
  });
  const portal = new PortalEngine({
    dbPath: join(dir, "portal.sqlite"),
    tickets,
    approvals,
    patrol,
    memorySkill,
    isolation,
    bootstrapAdmin: { username: "ops_admin", password: "super-secret-password", displayName: "主管理员" },
  });

  // Provision two isolated tenants: tenant_a (boss + ops) and tenant_b (boss_b)
  isolation.provisionTenant({ tenantId: "tenant_a", openIds: ["ou_boss_a", "ou_ops_a"] });
  isolation.provisionTenant({ tenantId: "tenant_b", openIds: ["ou_boss_b"] });
  portal.registerTenantMember({ tenantId: "tenant_a", openId: "ou_boss_a", displayName: "A老板", role: "admin" });
  portal.registerTenantMember({ tenantId: "tenant_a", openId: "ou_ops_a", displayName: "A运营", role: "member" });
  portal.registerTenantMember({ tenantId: "tenant_b", openId: "ou_boss_b", displayName: "B老板", role: "admin" });

  isolation.registerBot({ tenantId: "tenant_a", botId: "bot_buy_a", role: "purchasing" });
  isolation.registerBot({ tenantId: "tenant_a", botId: "bot_patrol_a", role: "patrol" });
  isolation.registerBot({ tenantId: "tenant_b", botId: "bot_buy_b", role: "purchasing" });

  for (const tid of ["tenant_a", "tenant_b"]) {
    approvals.setBudgetPolicy(tid, {
      tokenPerTx: 10,
      tokenDaily: 100,
      tokenMonthly: 2000,
      businessPerTx: 5000,
      businessDaily: 20000,
      businessMonthly: 100000,
      currency: "CNY",
    });
  }

  const routes = createPortalRoutes({ portal });

  async function callRoute(
    method: string,
    pathWithQuery: string,
    options: { body?: unknown; token?: string; cookie?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
    const url = new URL(`http://127.0.0.1${pathWithQuery}`);
    let status = 200;
    let payload: unknown = {};
    const headers: Record<string, string> = {};
    const reqHeaders: Record<string, string> = {};
    if (options.token) reqHeaders.authorization = `Bearer ${options.token}`;
    if (options.cookie) reqHeaders.cookie = options.cookie;

    const req = { headers: reqHeaders, on: () => {} } as unknown as IncomingMessage;
    const res = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = String(value);
      },
    } as unknown as ServerResponse;

    await routes({
      req,
      res,
      url,
      path: url.pathname,
      method,
      auth: { kind: "loopback", scopes: [], trust: "service" },
      json: (_r, s, data) => {
        status = s;
        payload = data;
      },
      readBody: async () => options.body ?? {},
    });

    return { status, body: (payload ?? {}) as Record<string, unknown>, headers };
  }

  return {
    dir,
    tickets,
    approvals,
    patrol,
    memorySkill,
    isolation,
    portal,
    callRoute,
    close: () => {
      portal.close();
      isolation.close();
      memorySkill.close();
      patrol.close();
      approvals.close();
      tickets.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function qrLogin(h: Harness, openId: string): Promise<string> {
  const start = await h.callRoute("POST", "/api/portal/auth/qr/start");
  expect(start.status).toBe(200);
  const qrToken = (start.body.challenge as { qrToken: string }).qrToken;

  const confirm = await h.callRoute("POST", "/api/portal/auth/qr/confirm", {
    body: { qrToken, openId },
  });
  expect(confirm.status).toBe(200);

  const exchanged = await h.callRoute("POST", "/api/portal/auth/qr/exchange", {
    body: { qrToken, cookie: false },
  });
  expect(exchanged.status).toBe(200);
  return String(exchanged.body.token);
}

async function adminLogin(h: Harness, username = "ops_admin", password = "super-secret-password"): Promise<string> {
  const res = await h.callRoute("POST", "/api/admin/auth/login", {
    body: { username, password, cookie: false },
  });
  expect(res.status).toBe(200);
  return String(res.body.token);
}

describe("add-customer-portal: Customer Web Portal + Admin Console", () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) {
      harnesses.pop()!.close();
    }
  });

  function setup(): Harness {
    const h = createTestHarness();
    harnesses.push(h);
    return h;
  }

  it("1. 客户飞书扫码登录与严格服务端租户隔离（跨租户直接调接口全返回 403）", async () => {
    const h = setup();
    const tokenA = await qrLogin(h, "ou_boss_a");
    const tokenB = await qrLogin(h, "ou_boss_b");

    // Seed tenant B ticket, approval card, and long-term memory
    const tkB = h.tickets.intake({
      source: "feishu_dm",
      initiator: "ou_boss_b",
      text: "帮我给供应商下单采购 500 件",
      toolAllowlist: ["place_order"],
      botId: "bot_buy_b",
    });
    expect(tkB.outcome).toBe("created");
    const ticketBId = tkB.outcome === "created" ? tkB.ticket.id : "";

    const evalB = await h.approvals.evaluate({
      tenantId: "tenant_b",
      ticketId: ticketBId,
      initiator: "ou_boss_b",
      approver: "ou_boss_b",
      actionSummary: "向供应商B采购500件",
      actionCategory: "high_risk_spend",
      toolName: "place_order",
      toolAllowlist: ["place_order"],
      tokenCost: 0.5,
      businessCost: 3000,
      currency: "CNY",
    });
    expect(evalB.decision).toBe("ask_human");
    const cardBId = evalB.card!.id;

    h.memorySkill.writeLongTerm({
      tenantId: "tenant_b",
      category: "preference",
      content: "租户B机密采购偏好：仅使用供应商B",
      sourceTrust: "owner_chat",
      confirmedBy: "ou_boss_b",
    });

    // Tenant A sees only Tenant A bots and cannot see Tenant B data
    const botsA = await h.callRoute("GET", "/api/portal/bots", { token: tokenA });
    expect(botsA.status).toBe(200);
    expect((botsA.body.bots as Array<{ botId: string }>).map((b) => b.botId)).toEqual(["bot_buy_a", "bot_patrol_a"]);

    const botsB = await h.callRoute("GET", "/api/portal/bots", { token: tokenB });
    expect((botsB.body.bots as Array<{ botId: string }>).map((b) => b.botId)).toEqual(["bot_buy_b"]);

    // Cross-tenant direct API calls by Tenant A MUST ALL return 403
    expect((await h.callRoute("GET", `/api/portal/tickets/${ticketBId}`, { token: tokenA })).status).toBe(403);
    expect((await h.callRoute("GET", `/api/portal/approvals/${cardBId}`, { token: tokenA })).status).toBe(403);
    expect((await h.callRoute("GET", "/api/portal/spend?tenantId=tenant_b", { token: tokenA })).status).toBe(403);
    expect((await h.callRoute("GET", "/api/portal/memory-skill?tenantId=tenant_b", { token: tokenA })).status).toBe(403);
    expect((await h.callRoute("GET", "/api/portal/export?tenantId=tenant_b", { token: tokenA })).status).toBe(403);

    // Tenant A self-export contains ONLY tenant_a data (no tenant_b tickets, approvals, or memories)
    const expA = await h.callRoute("GET", "/api/portal/export", { token: tokenA });
    expect(expA.status).toBe(200);
    const expObj = expA.body.export as { tickets: unknown[]; approvals: unknown[]; memories: unknown[] };
    expect(expObj.tickets).toEqual([]);
    expect(expObj.approvals).toEqual([]);
    expect(expObj.memories).toEqual([]);
    const expStr = JSON.stringify(expObj);
    expect(expStr).toContain("tenant_a");
    expect(expStr).not.toContain("租户B机密采购偏好");
    expect(expStr).not.toContain("向供应商B采购500件");
  });

  it("2. 同租户角色隔离：老板(admin)能改预算与审批人，运营(member)改返回 403", async () => {
    const h = setup();
    const bossToken = await qrLogin(h, "ou_boss_a");
    const opsToken = await qrLogin(h, "ou_ops_a");

    // Both see the same tenant_a bots
    const botsOps = await h.callRoute("GET", "/api/portal/bots", { token: opsToken });
    expect(botsOps.status).toBe(200);
    expect((botsOps.body.bots as unknown[]).length).toBe(2);

    // Ops (member) attempts to raise budget -> 403
    const opsBudget = await h.callRoute("PUT", "/api/portal/budget", {
      token: opsToken,
      body: { businessDaily: 99999 },
    });
    expect(opsBudget.status).toBe(403);

    // Ops (member) attempts to change approvers -> 403
    const opsApprovers = await h.callRoute("PUT", "/api/portal/settings/approvers", {
      token: opsToken,
      body: { approverOpenIds: ["ou_ops_a"] },
    });
    expect(opsApprovers.status).toBe(403);

    // Boss (admin) updates budget & approvers -> 200 + audit before/after
    const bossBudget = await h.callRoute("PUT", "/api/portal/budget", {
      token: bossToken,
      body: { businessDaily: 25000, tokenDaily: 200 },
    });
    expect(bossBudget.status).toBe(200);

    const bossApprovers = await h.callRoute("PUT", "/api/portal/settings/approvers", {
      token: bossToken,
      body: { approverOpenIds: ["ou_boss_a", "ou_ops_a"] },
    });
    expect(bossApprovers.status).toBe(200);

    const auditRes = await h.callRoute("GET", "/api/portal/audit", { token: bossToken });
    const actions = (auditRes.body.audit as Array<{ action: string; before: unknown; after: unknown }>).map(
      (a) => a.action,
    );
    expect(actions).toContain("budget_policy_updated");
    expect(actions).toContain("approvers_updated");
    expect(actions).toContain("member_privilege_denied");
  });

  it("3. 客户修改 Bot 开关、巡检频率与定时任务，以及直接调接口改核心技能被 403 拦截", async () => {
    const h = setup();
    const bossToken = await qrLogin(h, "ou_boss_a");

    // Disable bot_buy_a -> recorded in audit, running tickets unaffected
    const tkRunning = h.tickets.intake({
      source: "feishu_dm",
      initiator: "ou_boss_a",
      text: "采购补货 100 件",
      botId: "bot_buy_a",
    });
    expect(tkRunning.outcome).toBe("created");
    const toggleRes = await h.callRoute("PATCH", "/api/portal/bots/bot_buy_a", {
      token: bossToken,
      body: { enabled: false },
    });
    expect(toggleRes.status).toBe(200);
    expect((toggleRes.body.bot as { enabled: boolean }).enabled).toBe(false);
    expect(h.portal.isBotEnabled("tenant_a", "bot_buy_a")).toBe(false);
    expect(h.tickets.getTicket(tkRunning.outcome === "created" ? tkRunning.ticket.id : "")?.status).toBe("ready");

    // Update patrol frequency from 2/day to 1/day
    const schedRes = await h.callRoute("PUT", "/api/portal/schedule", {
      token: bossToken,
      body: { patrolFrequencyPerDay: 1, dailyDigestTime: "18:30", patrolEnabled: true },
    });
    expect(schedRes.status).toBe(200);
    const sched = schedRes.body.schedule as { patrolFrequencyPerDay: number; dailyDigestTime: string; effectiveNote: string };
    expect(sched.patrolFrequencyPerDay).toBe(1);
    expect(sched.dailyDigestTime).toBe("18:30");
    expect(sched.effectiveNote).toContain("下次");

    // Create a core skill (procurement) in MVP5 and attempt direct customer mutation -> 403
    const createdSkill = h.memorySkill.createSkill({
      tenantId: "tenant_a",
      name: "采购下单核心技能",
      description: "受控采购技能",
      triggerPhrases: ["自动采购"],
      coreCategory: "procurement",
      spec: {
        inputs: "SKU与数量",
        outputs: "采购单",
        tools: ["place_order"],
        boundaries: "需审批",
        failureHandling: "终止并通知",
      },
      actor: "ops_admin",
      actorType: "human",
    });
    expect(createdSkill.ok).toBe(true);
    const coreSkillId = createdSkill.ok ? createdSkill.skill.id : "";
    const originalHash = createdSkill.ok ? createdSkill.skill.contentHash : "";

    const mutateRes = await h.callRoute("PATCH", `/api/portal/skills/${coreSkillId}`, {
      token: bossToken,
      body: { description: "试图绕过审批" },
    });
    expect(mutateRes.status).toBe(403);
    expect(h.memorySkill.store.getSkill("tenant_a", coreSkillId)?.contentHash).toBe(originalHash);
    expect(h.memorySkill.listSkillLockDenials("tenant_a").length).toBeGreaterThanOrEqual(1);
  });

  it("4. 双通道审批：飞书/网页同步失效、并发点击仅生效一次、非审批人 403、多端一致", async () => {
    const h = setup();
    const bossToken = await qrLogin(h, "ou_boss_a");
    const opsToken = await qrLogin(h, "ou_ops_a");
    const syncEvents: Array<{ cardId: string; status: string; channel: string | null }> = [];
    const unsub = h.portal.onApprovalCardEvent((ev) => {
      syncEvents.push({ cardId: ev.card.id, status: ev.card.status, channel: ev.channel });
    });

    // Scenario A: Feishu approves -> Web immediately sees approved & banner, re-click is idempotent
    const eval1 = await h.approvals.evaluate({
      tenantId: "tenant_a",
      ticketId: "tkt_dual_1",
      initiator: "ou_boss_a",
      approver: "ou_boss_a",
      actionSummary: "采购 SKU-01 200件",
      actionCategory: "high_risk_spend",
      toolName: "place_order",
      toolAllowlist: ["place_order"],
      tokenCost: 0.2,
      businessCost: 1200,
    });
    const card1Id = eval1.card!.id;

    // Non-approver (ops) trying to approve on Web -> 403, card remains pending
    const unauthWeb = await h.callRoute("POST", `/api/portal/approvals/${card1Id}/decide`, {
      token: opsToken,
      body: { action: "allow_once" },
    });
    expect(unauthWeb.status).toBe(403);
    expect(h.approvals.getCard(card1Id)?.status).toBe("pending");

    // Boss approves on Feishu
    const feishuApprove = h.approvals.handleCardCallback({
      cardId: card1Id,
      operatorOpenId: "ou_boss_a",
      action: "allow_once",
      channel: "feishu",
    });
    expect(feishuApprove.ok).toBe(true);
    expect(feishuApprove.outcome).toBe("approved");

    // Web (phone/iPad/desktop sessions) immediately sees "已由 ou_boss_a 在飞书批准"
    const webView = await h.callRoute("GET", `/api/portal/approvals/${card1Id}`, { token: bossToken });
    expect(webView.status).toBe(200);
    const approval1 = webView.body.approval as { status: string; statusBanner: string; canAct: boolean; decisionChannel: string };
    expect(approval1.status).toBe("approved");
    expect(approval1.decisionChannel).toBe("feishu");
    expect(approval1.statusBanner).toContain("在飞书批准");
    expect(approval1.canAct).toBe(false);

    // Re-click on Web is idempotent (already_processed)
    const webReclick = await h.callRoute("POST", `/api/portal/approvals/${card1Id}/decide`, {
      token: bossToken,
      body: { action: "deny" },
    });
    expect(webReclick.status).toBe(200);
    expect((webReclick.body.result as { outcome: string }).outcome).toBe("already_processed");

    // Spend ledger reflects the approved spend accurately
    const spendRes = await h.callRoute("GET", "/api/portal/spend", { token: bossToken });
    expect(spendRes.status).toBe(200);
    const spend = spendRes.body.spend as { tokenSpend: { day: number }; businessSpend: { day: number } };
    expect(spend.tokenSpend.day).toBeCloseTo(0.2);
    expect(spend.businessSpend.day).toBeCloseTo(1200);

    // Scenario B: Web denies -> Feishu immediately notified & sees "已由 ou_boss_a 在网页拒绝"
    const eval2 = await h.approvals.evaluate({
      tenantId: "tenant_a",
      ticketId: "tkt_dual_2",
      initiator: "ou_boss_a",
      approver: "ou_boss_a",
      actionSummary: "删除历史草稿数据",
      actionCategory: "delete_data",
      toolName: "delete_records",
      toolAllowlist: ["delete_records"],
      tokenCost: 0.1,
      businessCost: 0,
    });
    const card2Id = eval2.card!.id;
    const webDeny = await h.callRoute("POST", `/api/portal/approvals/${card2Id}/decide`, {
      token: bossToken,
      body: { action: "deny" },
    });
    expect(webDeny.status).toBe(200);
    expect((webDeny.body.card as { statusBanner: string }).statusBanner).toContain("在网页拒绝");
    expect(syncEvents.some((e) => e.cardId === card2Id && e.status === "denied" && e.channel === "web")).toBe(true);

    // Scenario C: Simultaneous dual-channel clicks -> only ONE wins
    const eval3 = await h.approvals.evaluate({
      tenantId: "tenant_a",
      ticketId: "tkt_dual_3",
      initiator: "ou_boss_a",
      approver: "ou_boss_a",
      actionSummary: "并发测试付款",
      actionCategory: "high_risk_spend",
      toolName: "make_payment",
      toolAllowlist: ["make_payment"],
      tokenCost: 0.1,
      businessCost: 500,
    });
    const card3Id = eval3.card!.id;
    const [rWeb, rFeishu] = await Promise.all([
      h.callRoute("POST", `/api/portal/approvals/${card3Id}/decide`, {
        token: bossToken,
        body: { action: "allow_once" },
      }),
      Promise.resolve(
        h.approvals.handleCardCallback({
          cardId: card3Id,
          operatorOpenId: "ou_boss_a",
          action: "deny",
          channel: "feishu",
        }),
      ),
    ]);
    const webOutcome = (rWeb.body.result as { outcome: string }).outcome;
    const outcomes = [webOutcome, rFeishu.outcome];
    expect(outcomes.filter((o) => o === "approved" || o === "denied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_processed")).toHaveLength(1);

    const audit3 = h.approvals.listAudit({ ticketId: "tkt_dual_3" });
    const decisive = audit3.filter((a) => a.decision === "approved" || a.decision === "denied");
    expect(decisive).toHaveLength(1);
    expect(decisive[0]!.channel === "web" || decisive[0]!.channel === "feishu").toBe(true);

    unsub();
  });

  it("5. 管理后台：独立登录、客户被拒(403)、核心技能改哈希须走审批、销户先导出再删除、管理员可吊销", async () => {
    const h = setup();
    const custToken = await qrLogin(h, "ou_boss_a");
    const admToken = await adminLogin(h);

    // Customer trying to access admin API or login via QR payload -> 403
    expect((await h.callRoute("GET", "/api/admin/tenants", { token: custToken })).status).toBe(403);
    expect(
      (await h.callRoute("POST", "/api/admin/auth/login", { body: { openId: "ou_boss_a" } })).status,
    ).toBe(403);

    // Admin sees all tenants & VM states without exposing raw Vault secrets
    h.approvals.vault.setSecret("tenant_a", "erp_api_key", "RAW_SECRET_NEVER_EXPOSE");
    const tenantsRes = await h.callRoute("GET", "/api/admin/tenants", { token: admToken });
    expect(tenantsRes.status).toBe(200);
    expect(JSON.stringify(tenantsRes.body)).not.toContain("RAW_SECRET_NEVER_EXPOSE");
    const tenantIds = (tenantsRes.body.tenants as Array<{ tenantId: string }>).map((t) => t.tenantId);
    expect(tenantIds).toContain("tenant_a");
    expect(tenantIds).toContain("tenant_b");

    // Admin direct mutation of core skill without approval -> 403
    const coreCreated = h.memorySkill.createSkill({
      tenantId: "tenant_a",
      name: "付款核心技能",
      description: "v1",
      triggerPhrases: ["执行付款"],
      coreCategory: "payment",
      spec: {
        inputs: "付款单",
        outputs: "回执",
        tools: ["make_payment"],
        boundaries: "人工审批",
        failureHandling: "回滚",
      },
      actor: "ops_admin",
      actorType: "human",
    });
    const skillId = coreCreated.ok ? coreCreated.skill.id : "";
    const prevHash = coreCreated.ok ? coreCreated.skill.contentHash : "";

    const directPatch = await h.callRoute("PATCH", `/api/admin/core-skills/${skillId}`, {
      token: admToken,
      body: { tenantId: "tenant_a", description: "直接改" },
    });
    expect(directPatch.status).toBe(403);

    // Proper approval flow + secondary confirmation updates hash & records audit
    const reqRes = await h.callRoute("POST", "/api/admin/core-skills/requests", {
      token: admToken,
      body: {
        tenantId: "tenant_a",
        skillId,
        reason: "升级风控规则 v2",
        patch: { description: "v2 风控增强" },
      },
    });
    expect(reqRes.status).toBe(201);
    const reqId = (reqRes.body.request as { id: string }).id;

    // Without confirm: true -> 400
    expect(
      (
        await h.callRoute("POST", `/api/admin/core-skills/requests/${reqId}/approve`, {
          token: admToken,
          body: { confirm: false },
        })
      ).status,
    ).toBe(400);

    const approveRes = await h.callRoute("POST", `/api/admin/core-skills/requests/${reqId}/approve`, {
      token: admToken,
      body: { confirm: true },
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.newHash).not.toBe(prevHash);
    expect(h.memorySkill.store.getSkill("tenant_a", skillId)?.contentHash).toBe(approveRes.body.newHash);

    // Admin offboarding: exports ONLY tenant_b, then deletes completely with receipt
    h.isolation.writeTenantFile("tenant_b", "secret.txt", "tenant-b-only");
    h.isolation.writeTenantFile("tenant_a", "secret.txt", "tenant-a-only");
    const offboardRes = await h.callRoute("POST", "/api/admin/tenants/tenant_b/offboard", {
      token: admToken,
      body: { confirm: true },
    });
    expect(offboardRes.status).toBe(200);
    const expStr = JSON.stringify(offboardRes.body.exportBundle);
    expect(expStr).toContain("tenant-b-only");
    expect(expStr).not.toContain("tenant-a-only");
    expect(offboardRes.body.deletionReceipt).toBeTruthy();
    expect(h.isolation.getTenantVm("tenant_b")).toBeNull();

    // Admin account revocation immediately invalidates its session
    const secondAdmin = await h.callRoute("POST", "/api/admin/accounts", {
      token: admToken,
      body: { username: "ops_sub", password: "sub-password-123", displayName: "值班运营" },
    });
    expect(secondAdmin.status).toBe(201);
    const subId = (secondAdmin.body.account as { id: string }).id;
    const subToken = await adminLogin(h, "ops_sub", "sub-password-123");
    expect((await h.callRoute("GET", "/api/admin/auth/me", { token: subToken })).status).toBe(200);

    const revokeRes = await h.callRoute("POST", `/api/admin/accounts/${subId}/revoke`, { token: admToken });
    expect(revokeRes.status).toBe(200);
    expect((await h.callRoute("GET", "/api/admin/auth/me", { token: subToken })).status).toBe(401);
  });
});
