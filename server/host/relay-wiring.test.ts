import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoutingRole } from "../../shared/routing.ts";
import { ControlPlaneVault } from "../approvals/vault.ts";
import type { ModelSelection, RuntimeEvent } from "../contracts.ts";
import { RELAY_INSTANCE_ID } from "../drivers/relay.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";
import { LlmProxyStore } from "../llm-proxy/store.ts";
import { createRoutingHost } from "../routing/host.ts";
import { TicketEngine } from "../tickets/engine.ts";
import { createRelayWiring, type RelayMigratableStore } from "./relay-wiring.ts";

describe("add-relay-bot-driver Steps 2, 3, 5: relay-only registry, CLI migration, and Jev routing", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let store: LlmProxyStore;
  let vault: ControlPlaneVault;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-relay-wiring-"));
    db = new DatabaseSync(join(tmpDir, "portal.sqlite"));
    store = new LlmProxyStore(db);
    vault = new ControlPlaneVault();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProxy(fetchImpl: typeof fetch, defaultModel = "deepseek-v4-1-flash") {
    const proxy = new ControlPlaneLlmProxy({ vault, store, fetchImpl });
    proxy.registerProvider({
      id: "deepseek-main",
      name: "DeepSeek Relay",
      baseUrl: "https://relay.example.test/v1",
      apiKey: "sk-relay-secret",
      defaultModel,
      fastModel: defaultModel,
      priority: 1,
      enabled: true,
    });
    return proxy;
  }

  it("exposes only 控制面中转 · <defaultModel> in ProviderRegistry and zero CLI drivers", async () => {
    const proxy = makeProxy(async () =>
      new Response(
        JSON.stringify({
          id: "cmpl_1",
          object: "chat.completion",
          model: "deepseek-v4-1-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "我是 DeepSeek" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const wiring = createRelayWiring();
    wiring.attachProxy(proxy);
    const registry = new ProviderRegistry(wiring.drivers);
    await registry.load(wiring.providerConfigs());

    const described = await registry.describe();
    expect(described).toHaveLength(1);
    expect(described[0]?.instanceId).toBe(RELAY_INSTANCE_ID);
    expect(described[0]?.driverKind).toBe("relay");
    expect(described[0]?.models.options).toEqual([
      { id: "deepseek-v4-1-flash", label: "控制面中转 · deepseek-v4-1-flash" },
    ]);
    // No CLI drivers (codex, claude, grok) exist in registry
    expect(registry.get("codex")).toBeNull();
    expect(registry.get("claude")).toBeNull();
    expect(registry.get("grok")).toBeNull();

    const relayInstance = registry.get(RELAY_INSTANCE_ID)!;
    const events: RuntimeEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      relayInstance.adapter.onEvent((ev) => {
        events.push(ev);
        if (ev.type === "turn.completed") resolve();
      });
    });

    await relayInstance.adapter.sendTurn({ threadId: "th_new", botId: "bot_1", text: "你是谁" });
    await settled;

    expect(events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "我是 DeepSeek")).toBe(true);
    await relayInstance.dispose();
  });

  it("does not interrupt busy legacy CLI turn, but migrates on next idle turn with one-time notice", () => {
    const proxy = makeProxy(async () => new Response("{}", { status: 200 }));
    const wiring = createRelayWiring();
    wiring.attachProxy(proxy);

    let botModel: ModelSelection = { instanceId: "codex", model: "GPT-5.6-Sol" };
    let taskModel: ModelSelection | undefined = { instanceId: "codex", model: "GPT-5.6-Sol" };
    const notices: string[] = [];

    const mockStore: RelayMigratableStore = {
      bot: () => ({ id: "bot_1", name: "辣条", modelSelection: botModel }),
      taskByThread: () => ({ threadId: "th_old", modelSelection: taskModel }),
      patchBot: (_id, patch) => {
        botModel = patch.modelSelection;
      },
      patchTask: (_botId, _threadId, patch) => {
        taskModel = patch.modelSelection;
      },
      appendMessage: (_threadId, msg) => {
        notices.push(msg.tool.name);
      },
    };

    // Busy turn: do not switch mid-turn
    expect(wiring.migrateLegacyCliSelection(mockStore, "bot_1", "th_old", true)).toBe(false);
    expect(botModel.instanceId).toBe("codex");
    expect(notices).toHaveLength(0);

    // Next idle turn: auto-migrate and emit one-time notice
    expect(wiring.migrateLegacyCliSelection(mockStore, "bot_1", "th_old", false)).toBe(true);
    expect(botModel).toEqual({ instanceId: RELAY_INSTANCE_ID, model: "deepseek-v4-1-flash" });
    expect(taskModel).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("控制面中转 · deepseek-v4-1-flash");

    // Subsequent turn: no duplicate notice
    expect(wiring.migrateLegacyCliSelection(mockStore, "bot_1", "th_old", false)).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it("reports explicit relay error without falling back to CLI when upstream fails", async () => {
    const proxy = makeProxy(async () => new Response("Invalid Key", { status: 401 }));
    const wiring = createRelayWiring();
    wiring.attachProxy(proxy);
    const registry = new ProviderRegistry(wiring.drivers);
    await registry.load(wiring.providerConfigs());

    const relayInstance = registry.get(RELAY_INSTANCE_ID)!;
    const events: RuntimeEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      relayInstance.adapter.onEvent((ev) => {
        events.push(ev);
        if (ev.type === "turn.completed") resolve();
      });
    });

    await relayInstance.adapter.sendTurn({ threadId: "th_fail", botId: "bot_1", text: "你好" });
    await settled;

    const errEvent = events.find((e) => e.type === "runtime.error");
    expect(errEvent && errEvent.type === "runtime.error" ? errEvent.message : "").toContain("relay_auth_failed");
    expect(events.some((e) => e.type === "turn.completed" && e.ok === false)).toBe(true);
    await relayInstance.dispose();
  });

  it("wires Jev smallModel via createRoutingHost and passes 40-case evals/routing/cases.json (<5% misroute, <20% fallback)", async () => {
    let smallModelCalls = 0;
    const proxy = makeProxy(async () => {
      smallModelCalls += 1;
      return new Response(
        JSON.stringify({
          id: "cmpl_jev",
          object: "chat.completion",
          model: "deepseek-v4-1-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ role: "lead", confidence: 0.35, reason: "ambiguous" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const tickets = new TicketEngine({
      dbPath: join(tmpDir, "tickets.sqlite"),
      allowlist: new Set(["ou_member_1"]),
    });
    const routingHost = createRoutingHost(tickets, {
      smallModel: proxy.createJevSmallModel("tenant_default"),
    });

    try {
      const casesPath = join(process.cwd(), "evals", "routing", "cases.json");
      const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Array<{
        id: string;
        text: string;
        expectedRole: RoutingRole;
        expectFallback?: boolean;
      }>;
      expect(cases).toHaveLength(40);

      let misroutes = 0;
      let fallbacks = 0;
      for (const c of cases) {
        const res = await routingHost.engine.routeGroupMessage({
          eventId: `eval_${c.id}`,
          chatId: "oc_eval_group",
          senderId: "ou_member_1",
          mentionedBot: true,
          text: `@助理 ${c.text}`,
        });
        if (res.outcome !== "dispatched_to_specialist" && res.outcome !== "replied_by_manager") {
          misroutes += 1;
          continue;
        }
        if (res.jev.targetRole !== c.expectedRole) misroutes += 1;
        if (res.jev.fallbackToLead) fallbacks += 1;
      }

      expect(misroutes / cases.length).toBeLessThan(0.05);
      expect(fallbacks / cases.length).toBeLessThan(0.2);
      // Fixed rules ran first: smallModel only called for the 5 ambiguous cases
      expect(smallModelCalls).toBe(5);
    } finally {
      tickets.close();
    }
  });
});
