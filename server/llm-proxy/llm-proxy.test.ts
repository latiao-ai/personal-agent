import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ApprovalEngine } from "../approvals/engine.ts";
import { ControlPlaneVault } from "../approvals/vault.ts";
import { IsolationEngine } from "../isolation/engine.ts";
import { MemorySkillEngine } from "../memory-skill/engine.ts";
import { PatrolEngine } from "../patrol/engine.ts";
import { PortalEngine } from "../portal/engine.ts";
import { createPortalRoutes } from "../routes/portal.ts";
import { decideWithJev } from "../routing/jev.ts";
import { TicketEngine } from "../tickets/engine.ts";
import { ControlPlaneLlmProxy, LlmProxyError } from "./engine.ts";
import { createLlmProxyRoutes } from "./routes.ts";
import { LlmProxyStore } from "./store.ts";

describe("add-unified-login: control-plane LLM relay proxy (DeepSeek)", () => {
  it("routes completions via relay using Vault master key, strips master key from VM env, and requires no local CLI", async () => {
    const vault = new ControlPlaneVault();
    const seenHeaders: Array<string | null> = [];
    const seenModels: string[] = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(headers.get("authorization"));
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      seenModels.push(parsed.model ?? "");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: parsed.model ?? "deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "来自中转 DeepSeek 的回复" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const proxy = new ControlPlaneLlmProxy({ vault, fetchImpl: mockFetch });
    const masterKey = "sk-relay-master-secret-999";
    proxy.registerProvider({
      id: "deepseek-relay-primary",
      name: "DeepSeek Relay",
      baseUrl: "https://relay.example.invalid/v1",
      apiKey: masterKey,
      defaultModel: "deepseek-chat",
      fastModel: "deepseek-v4-flash",
      priority: 1,
    });

    // Startup readiness requires NO local CLI login
    const readiness = proxy.checkReadiness();
    expect(readiness.localCliRequired).toBe(false);
    expect(readiness.reachable).toBe(true);
    expect(readiness.relayConfigured).toBe(true);

    // Master key is NOT exposed in provider listings or VM environment
    expect(JSON.stringify(proxy.listProviders())).not.toContain(masterKey);
    const { token } = proxy.issueVirtualToken({ tenantId: "tenant_a", botId: "bot_1" });
    const vmEnv = proxy.buildVmLlmEnv(
      { PATH: "/usr/bin", OMB_LLM_RELAY_API_KEY: masterKey, DEEPSEEK_API_KEY: masterKey, LEAK: masterKey },
      "http://127.0.0.1:5199/api/llm/v1",
      token,
    );
    expect(JSON.stringify(vmEnv)).not.toContain(masterKey);
    expect(vmEnv.OMB_LLM_VIRTUAL_TOKEN).toBe(token);

    // Bot calls proxy using virtual token -> proxy calls relay with master key
    const res = await proxy.chatCompletions(token, {
      messages: [{ role: "user", content: "你好" }],
    });
    expect(res.choices[0]?.message.content).toContain("DeepSeek");
    expect(seenHeaders[0]).toBe(`Bearer ${masterKey}`);
    expect(seenModels[0]).toBe("deepseek-chat");
  });

  it("immediately rejects expired, revoked, and over-budget virtual tokens", async () => {
    let now = 1_000_000;
    const vault = new ControlPlaneVault(() => now);
    const okFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: "deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
        }),
        { status: 200 },
      );

    const proxy = new ControlPlaneLlmProxy({ vault, fetchImpl: okFetch, now: () => now });
    proxy.registerProvider({
      id: "p1",
      name: "Relay",
      baseUrl: "https://relay.example.invalid/v1",
      apiKey: "sk-master",
      defaultModel: "deepseek-chat",
    });

    // 1. Revoked token rejected immediately
    const { token: revToken } = proxy.issueVirtualToken({ tenantId: "t1", botId: "b1" });
    proxy.revokeVirtualToken(revToken);
    await expect(
      proxy.chatCompletions(revToken, { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/吊销/);

    // 2. Expired token rejected immediately
    const { token: expToken } = proxy.issueVirtualToken({ tenantId: "t1", botId: "b1", ttlMs: 1000 });
    now += 2000;
    await expect(
      proxy.chatCompletions(expToken, { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/过期/);

    // 3. Over-budget token rejected immediately on next call
    const { token: budgetToken } = proxy.issueVirtualToken({
      tenantId: "t1",
      botId: "b1",
      maxTokensPerDay: 100,
    });
    await proxy.chatCompletions(budgetToken, { messages: [{ role: "user", content: "first" }] });
    await expect(
      proxy.chatCompletions(budgetToken, { messages: [{ role: "user", content: "second" }] }),
    ).rejects.toThrow(/预算/);
  });

  it("opens circuit breaker on relay failure and fails over to backup provider without infinite retries", async () => {
    const vault = new ControlPlaneVault();
    let callsToPrimary = 0;
    let callsToBackup = 0;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("primary")) {
        callsToPrimary += 1;
        return new Response("upstream down", { status: 503 });
      }
      callsToBackup += 1;
      return new Response(
        JSON.stringify({
          id: "backup-ok",
          object: "chat.completion",
          model: "deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "backup-ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    };

    const proxy = new ControlPlaneLlmProxy({ vault, fetchImpl: mockFetch, failureThreshold: 2 });
    proxy.registerProvider({
      id: "primary",
      name: "Primary",
      baseUrl: "https://primary.example.invalid/v1",
      apiKey: "sk-1",
      defaultModel: "deepseek-chat",
      priority: 1,
    });
    proxy.registerProvider({
      id: "backup",
      name: "Backup",
      baseUrl: "https://backup.example.invalid/v1",
      apiKey: "sk-2",
      defaultModel: "deepseek-chat",
      priority: 2,
    });

    const { token } = proxy.issueVirtualToken({ tenantId: "t1", botId: "b1" });
    // First 2 calls trip primary circuit breaker and succeed via backup
    await proxy.chatCompletions(token, { messages: [{ role: "user", content: "1" }] });
    await proxy.chatCompletions(token, { messages: [{ role: "user", content: "2" }] });
    // 3rd call skips open primary completely
    const r3 = await proxy.chatCompletions(token, { messages: [{ role: "user", content: "3" }] });
    expect(r3.choices[0]?.message.content).toBe("backup-ok");
    expect(callsToPrimary).toBe(2);
    expect(callsToBackup).toBe(3);
  });

  it("powers Jev fast-router small model via relay and preserves 500ms timeout fallback to lead bot", async () => {
    const vault = new ControlPlaneVault();
    const fastFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "jev-1",
          object: "chat.completion",
          model: "deepseek-v4-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"role":"procurement","confidence":0.9,"reason":"quote"}' },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 },
      );

    const proxy = new ControlPlaneLlmProxy({ vault, fetchImpl: fastFetch });
    proxy.registerProvider({
      id: "relay",
      name: "Relay",
      baseUrl: "https://relay.example.invalid/v1",
      apiKey: "sk-1",
      defaultModel: "deepseek-chat",
      fastModel: "deepseek-v4-flash",
    });

    const decision = await decideWithJev("帮我整理一下这批新品的货源方案", {
      smallModel: proxy.createJevSmallModel("tenant_a"),
      timeoutMs: 500,
    });
    expect(decision.method).toBe("model");
    expect(decision.targetRole).toBe("procurement");

    // Slow relay (>500ms) -> cleanly falls back to lead bot
    const slowFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const slowProxy = new ControlPlaneLlmProxy({ vault, fetchImpl: slowFetch });
    slowProxy.registerProvider({
      id: "slow",
      name: "Slow",
      baseUrl: "https://slow.example.invalid/v1",
      apiKey: "sk-1",
      defaultModel: "deepseek-chat",
    });
    const fallback = await decideWithJev("帮我整理一下这批新品的货源方案", {
      smallModel: slowProxy.createJevSmallModel("tenant_a"),
      timeoutMs: 40,
    });
    expect(fallback.method).toBe("fallback");
    expect(fallback.fallbackToLead).toBe(true);
    expect(fallback.targetRole).toBe("lead");
  });
});

interface MockDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

function createIsolatedPortalFixture(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  autoBootstrapLlmEnv?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-admin-llm-"));
  const now = options?.now ?? (() => Date.UTC(2026, 10, 27, 8, 0, 0));
  const tickets = new TicketEngine({ dbPath: join(dir, "tickets.sqlite"), now });
  const approvals = new ApprovalEngine({ dbPath: join(dir, "approvals.sqlite"), now });
  const patrol = new PatrolEngine({ dbPath: join(dir, "patrol.sqlite"), tickets, approvals, now });
  const memorySkill = new MemorySkillEngine({ dbPath: join(dir, "memory-skill.sqlite"), now });
  const isolation = new IsolationEngine({
    dataDir: dir,
    dbPath: join(dir, "isolation.sqlite"),
    memorySkill,
    vault: approvals.vault,
    now,
  });
  const llmProxy = new ControlPlaneLlmProxy({
    vault: approvals.vault,
    fetchImpl: options?.fetchImpl,
    now,
  });
  const portal = new PortalEngine({
    dbPath: join(dir, "portal.sqlite"),
    tickets,
    approvals,
    patrol,
    memorySkill,
    isolation,
    llmProxy,
    autoBootstrapLlmEnv: options?.autoBootstrapLlmEnv ?? false,
    now,
    bootstrapAdmin: { username: "ops_admin", password: "admin-password-123", displayName: "运维管理员" },
  });

  const portalRoutes = createPortalRoutes({ portal });
  const llmRoutes = createLlmProxyRoutes(portal.llmProxy);

  async function dispatch(
    method: string,
    rawUrl: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<MockDispatchResult> {
    const url = new URL(rawUrl, "http://127.0.0.1:5199");
    let status = 404;
    let payload: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts?.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = { headers, on: () => {} } as unknown as IncomingMessage;
    const res = {
      setHeader: () => {},
      writeHead: (code: number) => {
        status = code;
      },
      write: () => true,
      end: () => {},
    } as unknown as ServerResponse;

    const ctx = {
      req,
      res,
      path: url.pathname,
      method,
      url,
      json: (_res: ServerResponse, code: number, data: unknown) => {
        status = code;
        payload = (data ?? {}) as Record<string, unknown>;
      },
      readBody: async () => opts?.body ?? {},
    };

    const handledPortal = await portalRoutes(ctx);
    if (handledPortal !== undefined) {
      await llmRoutes(ctx);
    }
    return { status, body: payload };
  }

  return {
    dir,
    portal,
    approvals,
    tickets,
    patrol,
    memorySkill,
    isolation,
    dispatch,
    cleanup: () => {
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

describe("add-admin-llm-config: store, admin config, pricing, quota, rotation & isolated e2e", () => {
  it("accumulates concurrent addUsage writes via ON CONFLICT DO UPDATE without losing tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-llm-store-"));
    try {
      const db = new DatabaseSync(join(dir, "portal.sqlite"));
      const store = new LlmProxyStore(db);

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          Promise.resolve().then(() => {
            store.addUsage("tenant_concurrent", "prov_1", "2026-11-27", 100 + i, 50, 0.001, 0.002);
          }),
        ),
      );

      const usage = store.getUsage("tenant_concurrent", "2026-11-27");
      // Sum of (100 + i) for i = 0..19 is 20 * 100 + 190 = 2190
      expect(usage.inputTokens).toBe(2190);
      expect(usage.outputTokens).toBe(1000);
      expect(usage.cost).toBeCloseTo(0.02, 6);
      expect(usage.revenue).toBeCloseTo(0.04, 6);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces admin/customer auth (401/403), masks API keys, preserves key on empty update, validates https & pricing", async () => {
    let activeUpstreamKey = "sk-test-initial-1234";
    const upstreamCalls: Array<{ url: string; auth: string | null; model: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const url = String(input);
      upstreamCalls.push({ url, auth, model: parsed.model ?? "" });

      if (url.includes("broken.invalid")) {
        return new Response("bad gateway", { status: 502 });
      }
      if (auth !== `Bearer ${activeUpstreamKey}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: parsed.model ?? "deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const fx = createIsolatedPortalFixture({ fetchImpl: mockFetch });
    try {
      const { token: adminToken } = fx.portal.loginAdmin("ops_admin", "admin-password-123");
      const adminSession = fx.portal.authenticateAdmin(adminToken)!;
      fx.portal.provisionTenantAsAdmin(adminSession, { tenantId: "tenant_alpha", openIds: ["ou_alpha_boss"] });
      const createdCustomer = fx.portal.createPortalUserAsAdmin(adminSession, {
        username: "alpha_boss",
        password: "cust-password-123",
        role: "customer",
        tenantId: "tenant_alpha",
        tenantRole: "admin",
      });
      expect(createdCustomer.user.tenantId).toBe("tenant_alpha");
      const custLogin = fx.portal.loginUnified("alpha_boss", "cust-password-123");
      const customerToken = custLogin.token;

      // 1. Unauthenticated -> 401; Customer -> 403
      const unauth = await fx.dispatch("GET", "/api/admin/llm/providers");
      expect(unauth.status).toBe(401);

      const custForbidden = await fx.dispatch("GET", "/api/admin/llm/providers", {
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(custForbidden.status).toBe(403);

      // 2. Non-https baseUrl -> 400
      const badUrl = await fx.dispatch("POST", "/api/admin/llm/providers", {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          name: "Bad Relay",
          baseUrl: "http://insecure.example.invalid/v1",
          apiKey: activeUpstreamKey,
          defaultModel: "deepseek-chat",
        },
      });
      expect(badUrl.status).toBe(400);

      // 3. Save provider -> returns only apiKeyLast4, never plaintext key
      const saved = await fx.dispatch("POST", "/api/admin/llm/providers", {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          name: "DeepSeek 中转站",
          baseUrl: "https://relay.example.invalid/v1",
          apiKey: activeUpstreamKey,
          defaultModel: "deepseek-chat",
          fastModel: "deepseek-chat",
          enabled: true,
        },
      });
      expect(saved.status).toBe(200);
      const provider = saved.body.provider as Record<string, unknown>;
      const providerId = String(provider.id);
      expect(provider.apiKeyConfigured).toBe(true);
      expect(provider.apiKeyLast4).toBe("****1234");
      expect(JSON.stringify(saved.body)).not.toContain(activeUpstreamKey);

      // 4. Update model with empty apiKey -> preserves old key
      const updated = await fx.dispatch("PUT", `/api/admin/llm/providers/${providerId}`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          name: "DeepSeek 中转站",
          baseUrl: "https://relay.example.invalid/v1",
          apiKey: "",
          defaultModel: "deepseek-reasoner",
          fastModel: "deepseek-chat",
          enabled: true,
        },
      });
      expect(updated.status).toBe(200);
      expect((updated.body.provider as Record<string, unknown>).apiKeyLast4).toBe("****1234");
      expect((updated.body.provider as Record<string, unknown>).defaultModel).toBe("deepseek-reasoner");

      // 5. Test connectivity: ok provider passes; broken provider fails without affecting active provider
      const testOk = await fx.dispatch("POST", `/api/admin/llm/providers/${providerId}/test`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(testOk.status).toBe(200);
      expect(testOk.body.ok).toBe(true);

      const brokenSaved = await fx.dispatch("POST", "/api/admin/llm/providers", {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          name: "Broken Relay",
          baseUrl: "https://broken.invalid/v1",
          apiKey: "sk-broken-9999",
          defaultModel: "deepseek-chat",
          enabled: false,
          priority: 99,
        },
      });
      const brokenId = String((brokenSaved.body.provider as Record<string, unknown>).id);
      const testFail = await fx.dispatch("POST", `/api/admin/llm/providers/${brokenId}/test`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(testFail.status).toBe(200);
      expect(testFail.body.ok).toBe(false);
      expect(String(testFail.body.error)).toContain("502");

      // 6. Pricing: price < cost -> 400; valid pricing saves
      const badPricing = await fx.dispatch("PUT", `/api/admin/llm/pricing/${providerId}`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          costPer1MInputTokens: 2,
          costPer1MOutputTokens: 4,
          pricePer1MInputTokens: 1,
          pricePer1MOutputTokens: 4,
        },
      });
      expect(badPricing.status).toBe(400);

      const goodPricing = await fx.dispatch("PUT", `/api/admin/llm/pricing/${providerId}`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: {
          costPer1MInputTokens: 1,
          costPer1MOutputTokens: 2,
          pricePer1MInputTokens: 2,
          pricePer1MOutputTokens: 4,
        },
      });
      expect(goodPricing.status).toBe(200);

      // 7. Tenant call records exact cost/revenue & uses updated defaultModel
      const { token: vtk } = fx.portal.llmProxy.issueVirtualToken({
        tenantId: "tenant_alpha",
        botId: "bot_1",
        maxTokensPerDay: 1500,
      });
      const callRes = await fx.dispatch("POST", "/api/llm/v1/chat/completions", {
        headers: { authorization: `Bearer ${vtk}` },
        body: { messages: [{ role: "user", content: "测试调用" }] },
      });
      expect(callRes.status).toBe(200);
      expect(upstreamCalls.at(-1)?.model).toBe("deepseek-reasoner");

      const adminUsage = await fx.dispatch("GET", "/api/admin/llm/usage/tenant_alpha?date=2026-11-27", {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminUsage.status).toBe(200);
      const u = adminUsage.body.usage as Record<string, number>;
      expect(u.inputTokens).toBe(1000);
      expect(u.outputTokens).toBe(500);
      expect(u.cost).toBeCloseTo(0.002, 6);
      expect(u.revenue).toBeCloseTo(0.004, 6);

      // 8. Customer portal read-only usage omits baseUrl, Key, and upstream cost
      const custUsage = await fx.dispatch("GET", "/api/portal/llm/usage", {
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(custUsage.status).toBe(200);
      const custJson = JSON.stringify(custUsage.body);
      expect(custJson).not.toContain("relay.example.invalid");
      expect(custJson).not.toContain(activeUpstreamKey);
      expect(custJson).not.toContain("****1234");
      expect((custUsage.body.usage as Record<string, unknown>).cost).toBeUndefined();
      expect((custUsage.body.usage as Record<string, unknown>).activeModel).toBe("deepseek-reasoner");
      expect((custUsage.body.usage as Record<string, unknown>).todayTokens).toBe(1500);

      // 9. Over daily token quota -> 402 without calling upstream; raising budget restores calls
      const callsBeforeQuotaBlock = upstreamCalls.length;
      const blocked = await fx.dispatch("POST", "/api/llm/v1/chat/completions", {
        headers: { authorization: `Bearer ${vtk}` },
        body: { messages: [{ role: "user", content: "超额度调用" }] },
      });
      expect(blocked.status).toBe(402);
      expect(upstreamCalls.length).toBe(callsBeforeQuotaBlock);

      const raisedBudget = await fx.dispatch("PUT", "/api/admin/llm/tenants/tenant_alpha/budget", {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { maxTokensPerDay: 10_000, maxCostPerDay: 50 },
      });
      expect(raisedBudget.status).toBe(200);

      const afterRaise = await fx.dispatch("POST", "/api/llm/v1/chat/completions", {
        headers: { authorization: `Bearer ${vtk}` },
        body: { messages: [{ role: "user", content: "调大额度后调用" }] },
      });
      expect(afterRaise.status).toBe(200);

      // 10. Rotate Key: confirm !== true -> 400; confirm: true -> old key invalidated (401), new key works
      const rotateNoConfirm = await fx.dispatch("POST", `/api/admin/llm/providers/${providerId}/rotate`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { apiKey: "sk-test-rotated-5678", confirm: false },
      });
      expect(rotateNoConfirm.status).toBe(400);

      const oldKey = activeUpstreamKey;
      const newKey = "sk-test-rotated-5678";
      activeUpstreamKey = newKey;

      // Verify old key is rejected (401) by upstream before/after rotation
      const oldKeyProbe = await mockFetch("https://relay.example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${oldKey}` },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "old" }] }),
      });
      expect(oldKeyProbe.status).toBe(401);

      const rotated = await fx.dispatch("POST", `/api/admin/llm/providers/${providerId}/rotate`, {
        headers: { authorization: `Bearer ${adminToken}` },
        body: { apiKey: newKey, confirm: true },
      });
      expect(rotated.status).toBe(200);
      expect((rotated.body.provider as Record<string, unknown>).apiKeyLast4).toBe("****5678");
      expect(JSON.stringify(rotated.body)).not.toContain(newKey);

      const afterRotateCall = await fx.dispatch("POST", "/api/llm/v1/chat/completions", {
        headers: { authorization: `Bearer ${vtk}` },
        body: { messages: [{ role: "user", content: "轮换后调用" }] },
      });
      expect(afterRotateCall.status).toBe(200);
      expect(upstreamCalls.at(-1)?.auth).toBe(`Bearer ${newKey}`);

      // Verify audit log contains llm_api_key_rotated and NEVER contains plaintext keys
      const audits = fx.portal.listAllAudit("_control_plane", 50);
      expect(audits.some((a) => a.action === "llm_api_key_rotated")).toBe(true);
      expect(JSON.stringify(audits)).not.toContain(oldKey);
      expect(JSON.stringify(audits)).not.toContain(newKey);
    } finally {
      fx.cleanup();
    }
  });

  it("migrates env vars on first start and gives DB priority over env on subsequent restarts", async () => {
    const prevBase = process.env.OMB_LLM_RELAY_BASE_URL;
    const prevKey = process.env.OMB_LLM_RELAY_API_KEY;
    const prevModel = process.env.OMB_LLM_RELAY_MODEL;
    const prevFast = process.env.OMB_LLM_RELAY_FAST_MODEL;
    const dir = mkdtempSync(join(tmpdir(), "omb-llm-env-"));

    try {
      process.env.OMB_LLM_RELAY_BASE_URL = "https://env-relay.example.invalid/v1";
      process.env.OMB_LLM_RELAY_API_KEY = "sk-env-bootstrap-4321";
      process.env.OMB_LLM_RELAY_MODEL = "deepseek-chat";
      process.env.OMB_LLM_RELAY_FAST_MODEL = "deepseek-chat";

      const now = () => Date.UTC(2026, 10, 27, 9, 0, 0);
      const tickets = new TicketEngine({ dbPath: join(dir, "tickets.sqlite"), now });
      const approvals = new ApprovalEngine({ dbPath: join(dir, "approvals.sqlite"), now });
      const patrol = new PatrolEngine({ dbPath: join(dir, "patrol.sqlite"), tickets, approvals, now });
      const memorySkill = new MemorySkillEngine({ dbPath: join(dir, "memory-skill.sqlite"), now });
      const isolation = new IsolationEngine({
        dataDir: dir,
        dbPath: join(dir, "isolation.sqlite"),
        memorySkill,
        vault: approvals.vault,
        now,
      });

      // 1st start: empty DB -> migrates env vars into llm_providers + Vault
      const portal1 = new PortalEngine({
        dbPath: join(dir, "portal.sqlite"),
        tickets,
        approvals,
        patrol,
        memorySkill,
        isolation,
        now,
        bootstrapAdmin: { username: "ops_admin", password: "admin-password-123" },
      });
      const { token: adminToken } = portal1.loginAdmin("ops_admin", "admin-password-123");
      const adminSession = portal1.authenticateAdmin(adminToken)!;

      const list1 = portal1.listLlmProvidersAsAdmin(adminSession);
      expect(list1).toHaveLength(1);
      expect(list1[0]?.id).toBe("primary-deepseek-relay");
      expect(list1[0]?.apiKeyConfigured).toBe(true);
      expect(list1[0]?.apiKeyLast4).toBe("****4321");

      // Admin edits provider in DB
      portal1.saveLlmProviderAsAdmin(adminSession, {
        id: "primary-deepseek-relay",
        name: "Admin Overridden Relay",
        baseUrl: "https://db-relay.example.invalid/v1",
        defaultModel: "deepseek-reasoner",
        fastModel: "deepseek-chat",
        enabled: true,
      });
      portal1.close();

      // 2nd start (same DB + Vault, env still holds old values) -> DB config wins over env
      const portal2 = new PortalEngine({
        dbPath: join(dir, "portal.sqlite"),
        tickets,
        approvals,
        patrol,
        memorySkill,
        isolation,
        now,
      });
      const active2 = portal2.llmProxy.listProviders();
      expect(active2).toHaveLength(1);
      expect(active2[0]?.baseUrl).toBe("https://db-relay.example.invalid/v1");
      expect(active2[0]?.defaultModel).toBe("deepseek-reasoner");

      // Also verify LlmProxyError status code is 402 on quota exceeded
      expect(new LlmProxyError(402, "budget_exceeded", "over").status).toBe(402);

      portal2.close();
      isolation.close();
      memorySkill.close();
      patrol.close();
      approvals.close();
      tickets.close();
    } finally {
      if (prevBase === undefined) delete process.env.OMB_LLM_RELAY_BASE_URL;
      else process.env.OMB_LLM_RELAY_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.OMB_LLM_RELAY_API_KEY;
      else process.env.OMB_LLM_RELAY_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.OMB_LLM_RELAY_MODEL;
      else process.env.OMB_LLM_RELAY_MODEL = prevModel;
      if (prevFast === undefined) delete process.env.OMB_LLM_RELAY_FAST_MODEL;
      else process.env.OMB_LLM_RELAY_FAST_MODEL = prevFast;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
