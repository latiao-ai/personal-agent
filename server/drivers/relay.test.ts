import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneVault } from "../approvals/vault.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";
import { LlmProxyStore } from "../llm-proxy/store.ts";
import {
  createRelayProviderDriver,
  RELAY_INSTANCE_ID,
  RelayDriver,
  RelayDriverError,
} from "./relay.ts";

describe("RelayDriver (add-relay-bot-driver Step 1)", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let store: LlmProxyStore;
  let vault: ControlPlaneVault;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omb-relay-driver-"));
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
      apiKey: "sk-relay-master-secret",
      defaultModel,
      fastModel: defaultModel,
      priority: 1,
      enabled: true,
    });
    return proxy;
  }

  it("returns text reply using active provider defaultModel without hardcoding", async () => {
    let seenModel: string | undefined;
    const proxy = makeProxy(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      seenModel = body.model;
      return new Response(
        JSON.stringify({
          id: "cmpl_1",
          object: "chat.completion",
          model: body.model ?? "deepseek-v4-1-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "你好，我是 DeepSeek 回复的。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }, "deepseek-v4-1-flash");

    const driver = new RelayDriver({ proxy, tenantId: "tenant_a", botId: "bot_1" });
    const res = await driver.runTurn({ text: "你好，你现在是什么模型回复你的" });

    expect(seenModel).toBe("deepseek-v4-1-flash");
    expect(res.text).toBe("你好，我是 DeepSeek 回复的。");
    expect(res.model).toBe("deepseek-v4-1-flash");
    expect(res.rounds).toBe(1);
    expect(res.toolCallsExecuted).toBe(0);
    expect(res.usage).toEqual({ input: 20, output: 15, total: 35 });
  });

  it("executes OpenAI tool_calls loop and feeds tool results back to the model", async () => {
    let callCount = 0;
    let secondRequestMessages: Array<{ role: string; content: string | null; tool_call_id?: string }> = [];

    const proxy = makeProxy(async (_url, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            id: "cmpl_tool_1",
            object: "chat.completion",
            model: "deepseek-v4-1-flash",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_sku_1",
                      type: "function",
                      function: { name: "check_inventory", arguments: '{"sku":"SKU-102"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      secondRequestMessages = body.messages;
      return new Response(
        JSON.stringify({
          id: "cmpl_tool_2",
          object: "chat.completion",
          model: "deepseek-v4-1-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "SKU-102 当前库存为 88 件。" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const driver = new RelayDriver({
      proxy,
      tenantId: "tenant_a",
      botId: "bot_1",
      executeTool: async (call) => {
        expect(call.name).toBe("check_inventory");
        expect(call.arguments).toEqual({ sku: "SKU-102" });
        return { ok: true, text: '{"sku":"SKU-102","qty":88}' };
      },
    });

    const res = await driver.runTurn({
      text: "查一下 SKU-102 库存",
      tools: [
        {
          type: "function",
          function: {
            name: "check_inventory",
            description: "Query SKU stock",
            parameters: { type: "object", properties: { sku: { type: "string" } } },
          },
        },
      ],
    });

    expect(callCount).toBe(2);
    expect(res.text).toBe("SKU-102 当前库存为 88 件。");
    expect(res.rounds).toBe(2);
    expect(res.toolCallsExecuted).toBe(1);
    expect(res.usage).toEqual({ input: 80, output: 30, total: 110 });
    expect(secondRequestMessages.some((m) => m.role === "tool" && m.tool_call_id === "call_sku_1")).toBe(true);
  });

  it("maps 402 quota exceeded without calling upstream or billing", async () => {
    let upstreamCalls = 0;
    const proxy = makeProxy(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    });
    proxy.setTenantBudget("tenant_capped", { maxTokensPerDay: 100, maxCostPerDay: 1 });
    const today = new Date().toISOString().slice(0, 10);
    store.addUsage("tenant_capped", "deepseek-main", today, 100, 0, 0.1, 0.2);

    const driver = new RelayDriver({ proxy, tenantId: "tenant_capped", botId: "bot_1" });
    await expect(driver.runTurn({ text: "hello" })).rejects.toMatchObject({
      name: "RelayDriverError",
      code: "relay_quota_exceeded",
      status: 402,
    });
    expect(upstreamCalls).toBe(0);
    expect(store.getUsage("tenant_capped", today).inputTokens).toBe(100);
  });

  it("maps 401/403 upstream failures to relay_auth_failed", async () => {
    const proxy = makeProxy(async () => new Response("Unauthorized", { status: 401 }));
    const driver = new RelayDriver({ proxy, tenantId: "tenant_a", botId: "bot_1" });
    await expect(driver.runTurn({ text: "hello" })).rejects.toMatchObject({
      code: "relay_auth_failed",
      status: 401,
    });
  });

  it("maps request timeout to relay_timeout", async () => {
    const proxy = makeProxy(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const driver = new RelayDriver({ proxy, tenantId: "tenant_a", botId: "bot_1", timeoutMs: 30 });
    await expect(driver.runTurn({ text: "hello" })).rejects.toMatchObject({
      code: "relay_timeout",
      status: 504,
    });
  });

  it("maps 429/5xx failures to relay_unavailable", async () => {
    const proxy = makeProxy(async () => new Response("Rate limited", { status: 429 }));
    const driver = new RelayDriver({ proxy, tenantId: "tenant_a", botId: "bot_1" });
    await expect(driver.runTurn({ text: "hello" })).rejects.toMatchObject({
      code: "relay_unavailable",
      status: 503,
    });
  });

  it("rejects cross-tenant virtual token reuse with relay_tenant_mismatch", async () => {
    const proxy = makeProxy(async () => new Response("{}", { status: 200 }));
    const tokenA = proxy.issueVirtualToken({ tenantId: "tenant_a", botId: "bot_a" }).token;
    const driverB = new RelayDriver({ proxy, tenantId: "tenant_b", botId: "bot_b", virtualToken: tokenA });
    await expect(driverB.runTurn({ text: "hello" })).rejects.toBeInstanceOf(RelayDriverError);
    await expect(driverB.runTurn({ text: "hello" })).rejects.toMatchObject({
      code: "relay_tenant_mismatch",
      status: 403,
    });
  });

  it("emits ProviderAdapter runtime events and exposes dynamic 控制面中转 · <defaultModel> catalog", async () => {
    const proxy = makeProxy(async () =>
      new Response(
        JSON.stringify({
          id: "cmpl_adapter",
          object: "chat.completion",
          model: "deepseek-v4-1-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "来自 DeepSeek 中转" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const providerDriver = createRelayProviderDriver(() => proxy);
    expect(providerDriver.models).toEqual({
      default: "deepseek-v4-1-flash",
      options: [{ id: "deepseek-v4-1-flash", label: "控制面中转 · deepseek-v4-1-flash" }],
    });

    const instance = await providerDriver.create({
      instanceId: RELAY_INSTANCE_ID,
      displayName: "控制面中转",
      environment: {},
      enabled: true,
      config: {},
    });

    const events: RuntimeEvent[] = [];
    const done = new Promise<void>((resolve) => {
      instance.adapter.onEvent((ev) => {
        events.push(ev);
        if (ev.type === "turn.completed") resolve();
      });
    });

    await instance.adapter.sendTurn({ threadId: "th_1", botId: "bot_1", text: "你好" });
    await done;

    expect(events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "来自 DeepSeek 中转")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed" && e.ok === true)).toBe(true);
    await instance.dispose();
  });
});
