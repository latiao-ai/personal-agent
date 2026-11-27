import { describe, expect, it } from "vitest";

import { ControlPlaneVault } from "../approvals/vault.ts";
import { decideWithJev } from "../routing/jev.ts";
import { ControlPlaneLlmProxy } from "./engine.ts";

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
