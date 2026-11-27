import type {
  ModelCatalog,
  ProviderAdapter,
  ProviderDriver,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  TextGenerationOptions,
  ThreadId,
  TurnId,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import {
  LlmProxyError,
  type ChatCompletionMessage,
  type ChatCompletionToolCall,
  type ChatCompletionToolDefinition,
  type ControlPlaneLlmProxy,
} from "../llm-proxy/engine.ts";
import { mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";

export const RELAY_DRIVER_KIND = "relay";
export const RELAY_INSTANCE_ID = "relay";
export const RELAY_DEFAULT_TIMEOUT_MS = 30_000;
export const RELAY_MAX_TOOL_ROUNDS = 8;

export type RelayErrorCode =
  | "relay_auth_failed"
  | "relay_timeout"
  | "relay_unavailable"
  | "relay_quota_exceeded"
  | "relay_not_configured"
  | "relay_tenant_mismatch"
  | "relay_tool_loop_exceeded";

export class RelayDriverError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number;

  constructor(code: RelayErrorCode, status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayDriverError";
    this.code = code;
    this.status = status;
  }
}

export interface RelayToolResult {
  text: string;
  ok: boolean;
}

export type RelayToolExecutor = (
  call: { id: string; name: string; arguments: Record<string, unknown>; rawArguments: string },
  signal: AbortSignal,
) => Promise<RelayToolResult>;

export interface RelayDriverOptions {
  proxy: ControlPlaneLlmProxy;
  tenantId: string;
  botId: string;
  virtualToken?: string;
  timeoutMs?: number;
  maxToolRounds?: number;
  executeTool?: RelayToolExecutor;
}

export interface RelayTurnInput {
  text: string;
  system?: string;
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  tools?: ChatCompletionToolDefinition[];
  executeTool?: RelayToolExecutor;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  virtualToken?: string;
  chatId?: string;
  senderId?: string;
}

export interface RelayTurnResult {
  text: string;
  model: string;
  rounds: number;
  toolCallsExecuted: number;
  usage: {
    input: number;
    output: number;
    total: number;
  };
}

function mapProxyError(err: unknown): RelayDriverError {
  if (err instanceof RelayDriverError) return err;
  if (err instanceof LlmProxyError) {
    if (err.status === 402 || err.code === "budget_exceeded") {
      return new RelayDriverError("relay_quota_exceeded", 402, "今日模型额度已用完，请联系管理员", { cause: err });
    }
    if (err.code === "tenant_mismatch") {
      return new RelayDriverError("relay_tenant_mismatch", 403, err.message, { cause: err });
    }
    if (err.code === "relay_not_configured") {
      return new RelayDriverError("relay_not_configured", 503, err.message, { cause: err });
    }
    if (err.code === "relay_timeout" || err.status === 504) {
      return new RelayDriverError("relay_timeout", 504, "中转站请求超时，请稍后重试", { cause: err });
    }
    if (err.upstreamStatus === 401 || err.upstreamStatus === 403 || err.status === 401 || err.status === 403) {
      return new RelayDriverError("relay_auth_failed", 401, "中转站鉴权失败，请检查管理后台 API Key", { cause: err });
    }
    if (
      err.upstreamStatus === 429 ||
      (err.upstreamStatus !== undefined && err.upstreamStatus >= 500) ||
      err.status === 429 ||
      err.status >= 500
    ) {
      return new RelayDriverError("relay_unavailable", 503, `中转站暂不可用：${err.message}`, { cause: err });
    }
    return new RelayDriverError("relay_unavailable", err.status, err.message, { cause: err });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new RelayDriverError("relay_timeout", 504, "中转站请求超时，请稍后重试", { cause: err });
  }
  return new RelayDriverError(
    "relay_unavailable",
    503,
    err instanceof Error ? err.message : String(err),
    { cause: err },
  );
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function hasAnyIntegration(integrations: SendTurnInput["integrations"]): boolean {
  if (!integrations) return false;
  return Boolean(
    integrations.agents ||
      integrations.localComputer ||
      integrations.browser ||
      integrations.composio ||
      integrations.composioOwn ||
      integrations.data ||
      integrations.email ||
      integrations.device ||
      integrations.phone ||
      (integrations.custom && Object.keys(integrations.custom).length > 0),
  );
}

export function resolveActiveRelayModel(proxy: ControlPlaneLlmProxy | null | undefined): string | null {
  const active = proxy?.listProviders().find((p) => p.enabled);
  return active?.defaultModel?.trim() || null;
}

export function relayModelLabel(model: string): string {
  return `控制面中转 · ${model}`;
}

export function buildRelayModelCatalog(proxy: ControlPlaneLlmProxy | null | undefined): ModelCatalog {
  const model = resolveActiveRelayModel(proxy) ?? "deepseek-chat";
  return {
    default: model,
    options: [{ id: model, label: relayModelLabel(model) }],
  };
}

/**
 * In-process Bot driver backed directly by ControlPlaneLlmProxy (no HTTP loopback, no CLI fallback).
 * Always resolves defaultModel from the active enabled relay provider in admin config and enforces
 * tenant-scoped virtual tokens and up to 8 OpenAI tool_calls rounds.
 */
export class RelayDriver {
  private readonly proxy: ControlPlaneLlmProxy;
  private readonly tenantId: string;
  private readonly botId: string;
  private readonly virtualToken?: string;
  private readonly timeoutMs: number;
  private readonly maxToolRounds: number;
  private readonly executeTool?: RelayToolExecutor;

  constructor(options: RelayDriverOptions) {
    this.proxy = options.proxy;
    this.tenantId = options.tenantId;
    this.botId = options.botId;
    this.virtualToken = options.virtualToken;
    this.timeoutMs = options.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS;
    this.maxToolRounds = options.maxToolRounds ?? RELAY_MAX_TOOL_ROUNDS;
    this.executeTool = options.executeTool;
  }

  async runTurn(input: RelayTurnInput): Promise<RelayTurnResult> {
    const defaultModel = resolveActiveRelayModel(this.proxy);
    if (!defaultModel) {
      throw new RelayDriverError("relay_not_configured", 503, "控制面尚未启用任何中转站模型供应商");
    }

    const token =
      input.virtualToken ??
      this.virtualToken ??
      this.proxy.issueVirtualToken({ tenantId: this.tenantId, botId: this.botId }).token;

    const messages: ChatCompletionMessage[] = [];
    if (input.system?.trim()) {
      messages.push({ role: "system", content: input.system.trim() });
    }
    if (input.transcript?.length) {
      for (const entry of input.transcript) {
        messages.push({ role: entry.role, content: entry.text });
      }
    }
    messages.push({ role: "user", content: input.text });

    const executor = input.executeTool ?? this.executeTool;
    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    let toolCallsExecuted = 0;
    let resolvedModel = defaultModel;

    for (let round = 1; round <= this.maxToolRounds + 1; round++) {
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      if (input.signal) {
        if (input.signal.aborted) {
          throw new RelayDriverError("relay_timeout", 504, "请求已取消或超时");
        }
        input.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.proxy.chatCompletions(
          token,
          {
            model: defaultModel,
            messages,
            ...(input.tools?.length ? { tools: input.tools } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          },
          controller.signal,
          { expectedTenantId: this.tenantId },
        );
      } catch (err) {
        throw mapProxyError(err);
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onExternalAbort);
      }

      resolvedModel = response.model || defaultModel;
      totalInput += response.usage?.prompt_tokens ?? 0;
      totalOutput += response.usage?.completion_tokens ?? 0;
      totalTokens += response.usage?.total_tokens ?? (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);

      const message = response.choices[0]?.message;
      const toolCalls: ChatCompletionToolCall[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length === 0) {
        return {
          text: message?.content ?? "",
          model: resolvedModel,
          rounds: round,
          toolCallsExecuted,
          usage: { input: totalInput, output: totalOutput, total: totalTokens },
        };
      }

      if (round > this.maxToolRounds) {
        throw new RelayDriverError(
          "relay_tool_loop_exceeded",
          422,
          `工具调用轮次超过上限（${this.maxToolRounds} 轮），已交回人工处理`,
        );
      }

      if (!executor) {
        return {
          text: message?.content ?? "",
          model: resolvedModel,
          rounds: round,
          toolCallsExecuted,
          usage: { input: totalInput, output: totalOutput, total: totalTokens },
        };
      }

      messages.push({
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const parsedArgs = parseToolArgs(call.function.arguments);
        const toolController = new AbortController();
        const toolTimer = setTimeout(() => toolController.abort(), this.timeoutMs);
        let result: RelayToolResult;
        try {
          result = await executor(
            {
              id: call.id,
              name: call.function.name,
              arguments: parsedArgs,
              rawArguments: call.function.arguments,
            },
            toolController.signal,
          );
        } catch (err) {
          result = {
            ok: false,
            text: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(toolTimer);
        }
        toolCallsExecuted += 1;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result.text,
        });
      }
    }

    throw new RelayDriverError(
      "relay_tool_loop_exceeded",
      422,
      `工具调用轮次超过上限（${this.maxToolRounds} 轮），已交回人工处理`,
    );
  }
}

export interface RelayProviderConfig {
  tenantId?: string;
  timeoutMs?: number;
}

/**
 * ProviderDriver adapter registering ControlPlaneLlmProxy as the sole built-in model provider
 * for OpenMausBot harness turns and the main UI model selector.
 */
export function createRelayProviderDriver(
  getProxy: () => ControlPlaneLlmProxy | null,
  options?: { defaultTenantId?: string; timeoutMs?: number },
): ProviderDriver<RelayProviderConfig> {
  const defaultTenantId = options?.defaultTenantId ?? "tenant_default";
  const defaultTimeoutMs = options?.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS;

  return {
    driverKind: RELAY_DRIVER_KIND,
    metadata: {
      displayName: "控制面中转",
      access: "api",
    },
    decodeConfig(raw: unknown): RelayProviderConfig {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const record = raw as Record<string, unknown>;
      return {
        ...(typeof record.tenantId === "string" && record.tenantId.trim() ? { tenantId: record.tenantId.trim() } : {}),
        ...(typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0
          ? { timeoutMs: record.timeoutMs }
          : {}),
      };
    },
    defaultConfig(): RelayProviderConfig {
      return {};
    },
    get models(): ModelCatalog {
      return buildRelayModelCatalog(getProxy());
    },
    async create(input): Promise<ProviderInstance> {
      const listeners = new Set<RuntimeEventListener>();
      const activeTurns = new Map<ThreadId, AbortController>();
      const tenantId = input.config.tenantId ?? defaultTenantId;
      const timeoutMs = input.config.timeoutMs ?? defaultTimeoutMs;

      const emit = (event: RuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };

      const baseEvent = (threadId: ThreadId, turnId?: TurnId) => ({
        eventId: newEventId(),
        provider: RELAY_DRIVER_KIND,
        providerInstanceId: input.instanceId,
        threadId,
        ...(turnId ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      });

      const adapter: ProviderAdapter = {
        provider: RELAY_DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          guestTurns: "confined",
          agentsMcp: true,
          browserMcp: true,
          composioMcp: true,
          dataMcp: true,
          emailMcp: true,
          customMcp: true,
        },
        async sendTurn(turn: SendTurnInput) {
          const turnId = newId();
          const controller = new AbortController();
          activeTurns.set(turn.threadId, controller);

          const proxy = getProxy();
          const activeModel = resolveActiveRelayModel(proxy);

          void (async () => {
            let toolSession: ChatToolSession | null = null;
            try {
              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "session.started",
                sessionId: `relay:${turn.threadId}`,
                model: activeModel,
              });
              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "turn.started",
              });

              if (!proxy) {
                throw new RelayDriverError("relay_not_configured", 503, "控制面中转代理尚未初始化");
              }

              if (hasAnyIntegration(turn.integrations)) {
                try {
                  toolSession = await mountChatTools(turn, controller.signal);
                } catch {
                  toolSession = null;
                }
              }

              const driver = new RelayDriver({
                proxy,
                tenantId,
                botId: turn.botId ?? "bot_default",
                timeoutMs,
              });

              const result = await driver.runTurn({
                text: turn.text,
                system: turn.system,
                transcript: turn.transcript,
                signal: controller.signal,
                ...(toolSession && toolSession.definitions.length > 0
                  ? {
                      tools: toolSession.definitions,
                      executeTool: async (call, sig) => {
                        const itemId = newId();
                        emit({
                          ...baseEvent(turn.threadId, turnId),
                          itemId,
                          type: "item.started",
                          itemType: "tool",
                          title: call.name,
                        });
                        const res = await toolSession!.execute(call.name, call.arguments, sig);
                        emit({
                          ...baseEvent(turn.threadId, turnId),
                          itemId,
                          type: "item.completed",
                          itemType: "tool",
                          ok: res.ok,
                          output: res.text,
                        });
                        return res;
                      },
                    }
                  : {}),
              });

              if (result.text) {
                emit({
                  ...baseEvent(turn.threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta: result.text,
                });
                emit({
                  ...baseEvent(turn.threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_text",
                  text: result.text,
                });
              }

              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "turn.completed",
                ok: true,
                usage: {
                  input: result.usage.input,
                  output: result.usage.output,
                },
              });
            } catch (err) {
              const mapped = mapProxyError(err);
              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "runtime.error",
                message: `[${mapped.code}] ${mapped.message}`,
                terminal: true,
              });
              emit({
                ...baseEvent(turn.threadId, turnId),
                type: "turn.completed",
                ok: false,
                stopReason: mapped.code,
              });
            } finally {
              if (toolSession) {
                await toolSession.close().catch(() => {});
              }
              if (activeTurns.get(turn.threadId) === controller) {
                activeTurns.delete(turn.threadId);
              }
            }
          })();

          return { turnId };
        },
        async interruptTurn(threadId: ThreadId) {
          const controller = activeTurns.get(threadId);
          if (controller) {
            controller.abort();
            activeTurns.delete(threadId);
          }
        },
        async respondToRequest() {
          return "unavailable";
        },
        hasSession(threadId: ThreadId) {
          return activeTurns.has(threadId);
        },
        async stopAll() {
          for (const controller of activeTurns.values()) {
            controller.abort();
          }
          activeTurns.clear();
        },
        onEvent(listener: RuntimeEventListener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };

      const instance: ProviderInstance = {
        instanceId: input.instanceId,
        driverKind: RELAY_DRIVER_KIND,
        displayName: input.displayName ?? "控制面中转",
        enabled: input.enabled,
        get models(): ModelCatalog {
          return buildRelayModelCatalog(getProxy());
        },
        adapter,
        async snapshot() {
          const proxy = getProxy();
          const readiness = proxy?.checkReadiness();
          if (!readiness || !readiness.relayConfigured) {
            return {
              state: "unavailable",
              authenticated: false,
              billing: "metered",
              reason: readiness?.reason ?? "控制面尚未配置中转站模型供应商",
            };
          }
          return {
            state: readiness.reachable ? "available" : "unavailable",
            authenticated: true,
            billing: "metered",
            ...(readiness.reason ? { reason: readiness.reason } : {}),
          };
        },
        async generateText(prompt: string, genOpts?: TextGenerationOptions): Promise<string> {
          const proxy = getProxy();
          if (!proxy) {
            throw new RelayDriverError("relay_not_configured", 503, "控制面中转代理尚未初始化");
          }
          const driver = new RelayDriver({
            proxy,
            tenantId,
            botId: "bot_text_gen",
            timeoutMs: genOpts?.timeoutMs ?? timeoutMs,
          });
          const result = await driver.runTurn({
            text: prompt,
            signal: genOpts?.signal,
          });
          genOpts?.onUsage?.({
            model: result.model,
            input: result.usage.input,
            output: result.usage.output,
          });
          return result.text;
        },
        async dispose() {
          await adapter.stopAll();
        },
      };

      return instance;
    },
  };
}
