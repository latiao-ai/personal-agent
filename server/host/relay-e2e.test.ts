import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprovalHost } from "../approvals/host.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { RELAY_INSTANCE_ID, RelayDriver } from "../drivers/relay.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { createIsolationHost } from "../isolation/host.ts";
import { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";
import { createMemorySkillHost } from "../memory-skill/host.ts";
import { createPatrolHost } from "../patrol/host.ts";
import { PortalEngine } from "../portal/engine.ts";
import { createTicketHost } from "../tickets/host.ts";
import { createRelayWiring } from "./relay-wiring.ts";

describe("add-relay-bot-driver Step 8.3 isolated E2E", () => {
  let tmpDir: string;
  let cleanupFns: Array<() => void>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-relay-e2e-"));
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("covers admin switch to DeepSeek -> new session reply, quota 402, invalid key error, and cross-tenant token rejection", async () => {
    let upstreamMode: "ok" | "invalid_key" = "ok";
    let upstreamCalls = 0;

    const tickets = createTicketHost(tmpDir);
    const approvals = createApprovalHost(tmpDir);
    const patrol = createPatrolHost(tmpDir, { tickets: tickets.engine, approvals: approvals.engine });
    const memorySkill = createMemorySkillHost(tmpDir);
    const isolation = createIsolationHost(tmpDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
    const llmProxy = new ControlPlaneLlmProxy({
      vault: approvals.engine.vault,
      fetchImpl: async (_url, init) => {
        upstreamCalls += 1;
        if (upstreamMode === "invalid_key") {
          return new Response("Invalid API key", { status: 401 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        return new Response(
          JSON.stringify({
            id: "cmpl_e2e",
            object: "chat.completion",
            model: body.model ?? "deepseek-v4-1-flash",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "当前由 DeepSeek 中转模型 deepseek-v4-1-flash 回复。" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
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

    cleanupFns.push(
      () => portal.close(),
      () => isolation.close(),
      () => memorySkill.close(),
      () => patrol.close(),
      () => approvals.close(),
      () => tickets.close(),
    );

    // 1. Admin configures DeepSeek relay in /admin
    const admin = portal.loginAdmin("admin", "AdminPassword#1").session;
    portal.saveLlmProviderAsAdmin(admin, {
      id: "deepseek-main",
      name: "DeepSeek Relay",
      baseUrl: "https://www.hi-x.cn/v1",
      apiKey: "sk-live-test-key",
      defaultModel: "deepseek-v4-1-flash",
      fastModel: "deepseek-v4-1-flash",
      enabled: true,
      priority: 1,
    });

    const wiring = createRelayWiring({ defaultTenantId: "tenant_a" });
    wiring.attachProxy(llmProxy);
    const registry = new ProviderRegistry(wiring.drivers);
    await registry.load(wiring.providerConfigs());

    // Model selector shows only 控制面中转 · deepseek-v4-1-flash
    const instances = await registry.describe();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.models.options).toEqual([
      { id: "deepseek-v4-1-flash", label: "控制面中转 · deepseek-v4-1-flash" },
    ]);

    // New session gets DeepSeek reply
    const relayInstance = registry.get(RELAY_INSTANCE_ID)!;
    const events: RuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      relayInstance.adapter.onEvent((ev) => {
        events.push(ev);
        if (ev.type === "turn.completed") resolve();
      });
    });
    await relayInstance.adapter.sendTurn({ threadId: "th_e2e_1", botId: "bot_1", text: "你是什么模型" });
    await done;
    expect(
      events.some(
        (e) =>
          e.type === "item.completed" &&
          e.itemType === "assistant_text" &&
          e.text.includes("deepseek-v4-1-flash"),
      ),
    ).toBe(true);

    // 2. Quota exceeded -> 402, no upstream call, no extra billing
    llmProxy.setTenantBudget("tenant_a", { maxTokensPerDay: 60, maxCostPerDay: 10 });
    const callsBeforeCap = upstreamCalls;
    const cappedDriver = new RelayDriver({ proxy: llmProxy, tenantId: "tenant_a", botId: "bot_1" });
    await expect(cappedDriver.runTurn({ text: "再来一轮" })).rejects.toMatchObject({
      code: "relay_quota_exceeded",
      status: 402,
    });
    expect(upstreamCalls).toBe(callsBeforeCap);

    // 3. Invalid key -> explicit relay_auth_failed, no CLI fallback
    llmProxy.setTenantBudget("tenant_a", { maxTokensPerDay: 100_000, maxCostPerDay: 50 });
    upstreamMode = "invalid_key";
    await expect(cappedDriver.runTurn({ text: "测试失效 Key" })).rejects.toMatchObject({
      code: "relay_auth_failed",
      status: 401,
    });

    // 4. Cross-tenant token -> rejected (403)
    upstreamMode = "ok";
    const tokenA = llmProxy.issueVirtualToken({ tenantId: "tenant_a", botId: "bot_a" }).token;
    const tenantBDriver = new RelayDriver({
      proxy: llmProxy,
      tenantId: "tenant_b",
      botId: "bot_b",
      virtualToken: tokenA,
    });
    await expect(tenantBDriver.runTurn({ text: "跨租户调用" })).rejects.toMatchObject({
      code: "relay_tenant_mismatch",
      status: 403,
    });

    await relayInstance.dispose();
  });
});
