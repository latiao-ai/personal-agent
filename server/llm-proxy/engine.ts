import { randomBytes, randomUUID } from "node:crypto";

import type {
  LlmCircuitState,
  LlmProxyReadiness,
  LlmRelayProviderConfig,
  LlmVirtualTokenRecord,
  PortalTenantLlmUsageView,
} from "../../shared/llm-proxy.ts";
import type { RoutingRole } from "../../shared/routing.ts";
import type { ControlPlaneVault } from "../approvals/vault.ts";
import type { JevModelVerdict, JevSmallModel } from "../routing/jev.ts";
import type { LlmProxyStore } from "./store.ts";

const CONTROL_PLANE_VAULT_TENANT = "_control_plane_llm";
const DEFAULT_TOKEN_TTL_MS = 60 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_TOKENS_PER_DAY = 200_000;
const DEFAULT_MAX_COST_PER_DAY = 50;
const TEST_PROVIDER_TIMEOUT_MS = 5_000;

function formatApiKeyLast4(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "";
  return `****${trimmed.slice(-4)}`;
}

function formatUtcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface RelayProviderRegistration extends LlmRelayProviderConfig {
  /** Secret key name inside ControlPlaneVault's control-plane partition. */
  vaultSecretName: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatCompletionMessage[];
  tools?: ChatCompletionToolDefinition[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LlmProxyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly upstreamStatus?: number;

  constructor(status: number, code: string, message: string, upstreamStatus?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface ControlPlaneLlmProxyOptions {
  vault: ControlPlaneVault;
  store?: LlmProxyStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Control-plane OpenAI-compatible LLM relay proxy for DeepSeek.
 * Master relay API keys remain strictly inside ControlPlaneVault / control-plane env and never enter VMs.
 * VMs and bots authenticate with short-lived tenant-scoped virtual tokens enforced for expiry, revocation,
 * daily token/cost budgets, and circuit-breaking failover.
 */
export class ControlPlaneLlmProxy {
  private readonly vault: ControlPlaneVault;
  private store: LlmProxyStore | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly providers: RelayProviderRegistration[] = [];
  private readonly providerSecrets = new Map<string, string>();
  private readonly virtualTokens = new Map<string, LlmVirtualTokenRecord>();
  private readonly tenantBudgets = new Map<string, { maxTokensPerDay: number; maxCostPerDay: number }>();
  private readonly failureCounts = new Map<string, number>();
  private readonly circuitOpenedAt = new Map<string, number>();

  constructor(options: ControlPlaneLlmProxyOptions) {
    this.vault = options.vault;
    this.store = options.store ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    // Auto-bootstrap default relay provider from control-plane environment if configured.
    const envBaseUrl = process.env.OMB_LLM_RELAY_BASE_URL?.trim();
    const envApiKey = process.env.OMB_LLM_RELAY_API_KEY?.trim();
    if (envBaseUrl && envApiKey) {
      this.registerProvider({
        id: "primary-deepseek-relay",
        name: "DeepSeek Relay",
        baseUrl: envBaseUrl.replace(/\/+$/, ""),
        apiKey: envApiKey,
        defaultModel: process.env.OMB_LLM_RELAY_MODEL?.trim() || "deepseek-chat",
        fastModel: process.env.OMB_LLM_RELAY_FAST_MODEL?.trim() || "deepseek-chat",
        priority: 1,
      });
    }
  }

  /** Attaches the SQLite store for pricing lookups and daily usage recording. */
  attachStore(store: LlmProxyStore): void {
    this.store = store;
  }

  /** Migrates OMB_LLM_RELAY_* env vars into DB + Vault once if llm_providers is empty, then loads from DB. */
  bootstrapFromEnvAndLoad(store: LlmProxyStore, autoBootstrapEnv = true): void {
    this.store = store;
    if (autoBootstrapEnv && store.listProviders().length === 0) {
      const envBaseUrl = process.env.OMB_LLM_RELAY_BASE_URL?.trim();
      const envApiKey = process.env.OMB_LLM_RELAY_API_KEY?.trim();
      if (envBaseUrl && envApiKey) {
        const defaultModel = process.env.OMB_LLM_RELAY_MODEL?.trim() || "deepseek-chat";
        const fastModel = process.env.OMB_LLM_RELAY_FAST_MODEL?.trim() || "deepseek-chat";
        const baseUrl = envBaseUrl.replace(/\/+$/, "");
        store.upsertProvider({
          id: "primary-deepseek-relay",
          name: "DeepSeek Relay",
          baseUrl,
          defaultModel,
          fastModel,
          enabled: true,
          priority: 1,
          updatedBy: "env-bootstrap",
          updatedAt: this.now(),
        });
        this.updateProvider({
          id: "primary-deepseek-relay",
          name: "DeepSeek Relay",
          baseUrl,
          apiKey: envApiKey,
          defaultModel,
          fastModel,
          enabled: true,
          priority: 1,
        });
      }
    }
    if (store.listProviders().length > 0) {
      this.loadProvidersFromStore(store);
    }
  }

  /** Returns sanitized read-only LLM usage for a tenant (no baseUrl, no API keys, no upstream cost). */
  getPortalUsageView(tenantId: string): PortalTenantLlmUsageView {
    const today = formatUtcDate(this.now());
    const month = today.slice(0, 7);
    const daily = this.store?.getUsage(tenantId, today) ?? { inputTokens: 0, outputTokens: 0, cost: 0, revenue: 0 };
    const monthly = this.store?.getMonthlyUsage(tenantId, month) ?? { inputTokens: 0, outputTokens: 0, cost: 0, revenue: 0 };
    const budget = this.getTenantBudget(tenantId);
    const activeProvider = this.providers.find((p) => p.enabled) ?? null;
    const todayTokens = daily.inputTokens + daily.outputTokens;
    const monthTokens = monthly.inputTokens + monthly.outputTokens;
    return {
      tenantId,
      date: today,
      month,
      activeModel: activeProvider?.defaultModel ?? null,
      todayTokens,
      todayRevenue: Number(daily.revenue.toFixed(6)),
      monthTokens,
      monthRevenue: Number(monthly.revenue.toFixed(6)),
      maxTokensPerDay: budget.maxTokensPerDay,
      maxCostPerDay: budget.maxCostPerDay,
      remainingTokensToday: Math.max(0, budget.maxTokensPerDay - todayTokens),
      remainingCostToday: Math.max(0, Number((budget.maxCostPerDay - daily.revenue).toFixed(6))),
      currency: "CNY",
    };
  }

  /** Loads enabled providers from control-plane DB; DB config overrides env bootstrap, keys come from Vault. */
  loadProvidersFromStore(store: LlmProxyStore): void {
    this.store = store;
    const rows = store.listProviders();
    this.providers.length = 0;

    for (const row of rows) {
      if (!row.enabled) continue;
      const vaultSecretName = `llm_relay:${row.id}:api_key`;
      const secret = this.vault.getSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName) ?? this.providerSecrets.get(row.id);
      if (!secret) {
        console.warn(`[llm-proxy] skipping provider "${row.id}": API key not found in ControlPlaneVault`);
        continue;
      }
      this.providerSecrets.set(row.id, secret);
      this.providers.push({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl.replace(/\/+$/, ""),
        defaultModel: row.defaultModel,
        fastModel: row.fastModel || row.defaultModel,
        enabled: true,
        priority: row.priority,
        vaultSecretName,
      });
    }
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /** Updates or adds a provider in memory; writes Vault first when a new apiKey is provided. */
  updateProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    defaultModel: string;
    fastModel?: string;
    enabled: boolean;
    priority: number;
  }): void {
    const vaultSecretName = `llm_relay:${input.id}:api_key`;
    const trimmedKey = input.apiKey?.trim();
    if (trimmedKey) {
      this.vault.setSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName, trimmedKey);
      this.providerSecrets.set(input.id, trimmedKey);
      this.failureCounts.delete(input.id);
      this.circuitOpenedAt.delete(input.id);
    }

    const existingIdx = this.providers.findIndex((p) => p.id === input.id);
    const entry: RelayProviderRegistration = {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      defaultModel: input.defaultModel,
      fastModel: input.fastModel?.trim() || input.defaultModel,
      enabled: input.enabled,
      priority: input.priority,
      vaultSecretName,
    };
    if (existingIdx >= 0) {
      this.providers[existingIdx] = entry;
    } else {
      this.providers.push(entry);
    }
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /** Replaces a provider's API key in Vault so the old key is immediately invalidated. */
  rotateProviderApiKey(providerId: string, newApiKey: string): { apiKeyConfigured: boolean; apiKeyLast4: string } {
    const trimmed = newApiKey.trim();
    const vaultSecretName = `llm_relay:${providerId}:api_key`;
    this.vault.setSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName, trimmed);
    this.providerSecrets.set(providerId, trimmed);
    this.failureCounts.delete(providerId);
    this.circuitOpenedAt.delete(providerId);
    return {
      apiKeyConfigured: Boolean(trimmed),
      apiKeyLast4: formatApiKeyLast4(trimmed),
    };
  }

  /** Returns masked key status for admin views; never exposes plaintext keys. */
  getApiKeyMask(providerId: string): { apiKeyConfigured: boolean; apiKeyLast4: string } {
    const vaultSecretName = `llm_relay:${providerId}:api_key`;
    const secret = this.vault.getSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName) ?? this.providerSecrets.get(providerId);
    if (!secret) {
      return { apiKeyConfigured: false, apiKeyLast4: "" };
    }
    return { apiKeyConfigured: true, apiKeyLast4: formatApiKeyLast4(secret) };
  }

  /** Sends a minimal probe call (max_tokens: 5, 5s timeout) without recording usage or altering active config. */
  async testProvider(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const stored = this.store?.getProvider(id);
    const active = this.providers.find((p) => p.id === id);
    const target = stored ?? active;
    if (!target) {
      return { ok: false, latencyMs: 0, error: "未找到目标模型供应商" };
    }

    const vaultSecretName = `llm_relay:${id}:api_key`;
    const secret = this.vault.getSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName) ?? this.providerSecrets.get(id);
    if (!secret) {
      return { ok: false, latencyMs: 0, error: "未配置 API Key" };
    }

    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_PROVIDER_TIMEOUT_MS);
    try {
      const baseUrl = target.baseUrl.replace(/\/+$/, "");
      const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model: target.fastModel || target.defaultModel,
          max_tokens: 5,
          temperature: 0,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - startedAt);
      if (!res.ok) {
        return { ok: false, latencyMs, error: `中转站返回 HTTP ${res.status}` };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      const latencyMs = Math.max(0, this.now() - startedAt);
      const rawMsg = err instanceof Error ? err.message : "连接失败";
      const safeMsg = rawMsg.replaceAll(secret, "[REDACTED]");
      return { ok: false, latencyMs, error: safeMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  getTenantBudget(tenantId: string): { maxTokensPerDay: number; maxCostPerDay: number } {
    return (
      this.tenantBudgets.get(tenantId) ?? {
        maxTokensPerDay: DEFAULT_MAX_TOKENS_PER_DAY,
        maxCostPerDay: DEFAULT_MAX_COST_PER_DAY,
      }
    );
  }

  setTenantBudget(
    tenantId: string,
    input: { maxTokensPerDay?: number; maxCostPerDay?: number },
  ): { maxTokensPerDay: number; maxCostPerDay: number } {
    const prev = this.getTenantBudget(tenantId);
    const next = {
      maxTokensPerDay: input.maxTokensPerDay ?? prev.maxTokensPerDay,
      maxCostPerDay: input.maxCostPerDay ?? prev.maxCostPerDay,
    };
    this.tenantBudgets.set(tenantId, next);
    for (const record of this.virtualTokens.values()) {
      if (record.tenantId === tenantId) {
        record.maxTokensPerDay = next.maxTokensPerDay;
        record.maxCostUsdPerDay = next.maxCostPerDay;
      }
    }
    return { ...next };
  }

  /** Registers an OpenAI-compatible relay provider; master API key is stored only in ControlPlaneVault. */
  registerProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
    fastModel?: string;
    priority?: number;
    enabled?: boolean;
  }): LlmRelayProviderConfig {
    const vaultSecretName = `llm_relay:${input.id}:api_key`;
    this.vault.setSecret(CONTROL_PLANE_VAULT_TENANT, vaultSecretName, input.apiKey);
    this.providerSecrets.set(input.id, input.apiKey);

    const existingIdx = this.providers.findIndex((p) => p.id === input.id);
    const entry: RelayProviderRegistration = {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      defaultModel: input.defaultModel,
      fastModel: input.fastModel ?? input.defaultModel,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 10,
      vaultSecretName,
    };
    if (existingIdx >= 0) {
      this.providers[existingIdx] = entry;
    } else {
      this.providers.push(entry);
    }
    this.providers.sort((a, b) => a.priority - b.priority);
    return {
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      defaultModel: entry.defaultModel,
      fastModel: entry.fastModel,
      enabled: entry.enabled,
      priority: entry.priority,
    };
  }

  listProviders(): LlmRelayProviderConfig[] {
    return this.providers.map(({ vaultSecretName: _omit, ...pub }) => ({ ...pub }));
  }

  /** Issues a short-lived tenant/bot virtual token for VM or harness calls to the control-plane proxy. */
  issueVirtualToken(input: {
    tenantId: string;
    botId: string;
    ttlMs?: number;
    maxTokensPerDay?: number;
    maxCostUsdPerDay?: number;
  }): { token: string; record: LlmVirtualTokenRecord } {
    const now = this.now();
    const tenantBudget = this.getTenantBudget(input.tenantId);
    const token = `omb_vtk_${randomBytes(24).toString("hex")}`;
    const record: LlmVirtualTokenRecord = {
      tokenId: `vtk_${randomUUID()}`,
      tenantId: input.tenantId,
      botId: input.botId,
      issuedAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
      maxTokensPerDay: input.maxTokensPerDay ?? tenantBudget.maxTokensPerDay,
      maxCostUsdPerDay: input.maxCostUsdPerDay ?? tenantBudget.maxCostPerDay,
      usedTokensToday: 0,
      usedCostUsdToday: 0,
      revokedAt: null,
    };
    this.virtualTokens.set(token, record);
    return { token, record: { ...record } };
  }

  revokeVirtualToken(token: string): boolean {
    const record = this.virtualTokens.get(token);
    if (!record) return false;
    record.revokedAt = this.now();
    return true;
  }

  /** Builds a sanitized VM environment containing ONLY the virtual token and proxy URL, never master keys. */
  buildVmLlmEnv(baseEnv: NodeJS.ProcessEnv, proxyBaseUrl: string, virtualToken: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const forbiddenValues = new Set(this.providerSecrets.values());
    for (const [k, v] of Object.entries(env)) {
      if (
        k === "OMB_LLM_RELAY_API_KEY" ||
        k === "DEEPSEEK_API_KEY" ||
        k === "OPENAI_API_KEY" ||
        (v !== undefined && forbiddenValues.has(v))
      ) {
        delete env[k];
      }
    }
    env.OMB_LLM_PROXY_URL = proxyBaseUrl;
    env.OMB_LLM_VIRTUAL_TOKEN = virtualToken;
    return env;
  }

  private validateVirtualToken(
    rawToken: string | null | undefined,
    expectedTenantId?: string,
  ): LlmVirtualTokenRecord {
    if (!rawToken) {
      throw new LlmProxyError(401, "missing_virtual_token", "缺少租户临时模型令牌");
    }
    const record = this.virtualTokens.get(rawToken);
    if (!record) {
      throw new LlmProxyError(401, "invalid_virtual_token", "无效的模型令牌");
    }
    if (record.revokedAt !== null) {
      throw new LlmProxyError(401, "virtual_token_revoked", "模型令牌已被吊销");
    }
    if (this.now() > record.expiresAt) {
      throw new LlmProxyError(401, "virtual_token_expired", "模型令牌已过期");
    }
    if (expectedTenantId && record.tenantId !== expectedTenantId) {
      throw new LlmProxyError(403, "tenant_mismatch", "跨租户模型令牌拒绝调用");
    }
    if (record.usedTokensToday >= record.maxTokensPerDay || record.usedCostUsdToday >= record.maxCostUsdPerDay) {
      throw new LlmProxyError(402, "budget_exceeded", "已超出租户/Bot 每日模型预算上限，已熔断");
    }
    return record;
  }

  private getProviderCircuitState(providerId: string): LlmCircuitState {
    const openedAt = this.circuitOpenedAt.get(providerId);
    if (openedAt === undefined) return "closed";
    if (this.now() - openedAt >= this.cooldownMs) {
      return "half_open";
    }
    return "open";
  }

  private recordProviderSuccess(providerId: string): void {
    this.failureCounts.set(providerId, 0);
    this.circuitOpenedAt.delete(providerId);
  }

  private recordProviderFailure(providerId: string): void {
    const count = (this.failureCounts.get(providerId) ?? 0) + 1;
    this.failureCounts.set(providerId, count);
    if (count >= this.failureThreshold) {
      this.circuitOpenedAt.set(providerId, this.now());
    }
  }

  /** Forwards an OpenAI-compatible chat completion through healthy relay providers with circuit breaking. */
  async chatCompletions(
    rawVirtualToken: string | null | undefined,
    body: ChatCompletionRequest,
    signal?: AbortSignal,
    options?: { expectedTenantId?: string },
  ): Promise<ChatCompletionResponse> {
    const tokenRecord = this.validateVirtualToken(rawVirtualToken, options?.expectedTenantId);
    const today = formatUtcDate(this.now());
    if (this.store) {
      const daily = this.store.getUsage(tokenRecord.tenantId, today);
      const dailyTokens = daily.inputTokens + daily.outputTokens;
      if (dailyTokens >= tokenRecord.maxTokensPerDay || daily.cost >= tokenRecord.maxCostUsdPerDay) {
        throw new LlmProxyError(402, "budget_exceeded", "已超出租户每日模型额度上限，已熔断");
      }
    }
    const enabled = this.providers.filter((p) => p.enabled);
    if (enabled.length === 0) {
      throw new LlmProxyError(503, "relay_not_configured", "控制面尚未配置中转站 Provider");
    }

    let lastError: Error | null = null;
    for (const provider of enabled) {
      const state = this.getProviderCircuitState(provider.id);
      if (state === "open") {
        continue;
      }
      const masterKey =
        this.vault.getSecret(CONTROL_PLANE_VAULT_TENANT, provider.vaultSecretName) ??
        this.providerSecrets.get(provider.id);
      if (!masterKey) {
        continue;
      }
      try {
        const res = await this.fetchImpl(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${masterKey}`,
          },
          body: JSON.stringify({
            ...body,
            model: body.model || provider.defaultModel,
          }),
          signal,
        });
        if (!res.ok) {
          this.recordProviderFailure(provider.id);
          lastError = new LlmProxyError(
            502,
            "relay_upstream_error",
            `中转站 ${provider.id} 返回状态 ${res.status}`,
            res.status,
          );
          continue;
        }
        const data = (await res.json()) as ChatCompletionResponse;
        this.recordProviderSuccess(provider.id);
        const rawPrompt = data.usage?.prompt_tokens ?? 0;
        const rawCompletion = data.usage?.completion_tokens ?? 0;
        const hasUsage = Boolean(data.usage && (rawPrompt > 0 || rawCompletion > 0 || (data.usage.total_tokens ?? 0) > 0));
        const promptTokens = hasUsage ? rawPrompt : 100;
        const completionTokens = hasUsage ? rawCompletion : 0;
        const totalTokens = hasUsage ? (data.usage?.total_tokens ?? promptTokens + completionTokens) : 100;

        const pricing = this.store?.getPricing(provider.id) ?? null;
        const cost = pricing
          ? (promptTokens / 1_000_000) * pricing.costPer1MInputTokens +
            (completionTokens / 1_000_000) * pricing.costPer1MOutputTokens
          : (totalTokens / 1_000_000) * 0.5;
        const revenue = pricing
          ? (promptTokens / 1_000_000) * pricing.pricePer1MInputTokens +
            (completionTokens / 1_000_000) * pricing.pricePer1MOutputTokens
          : cost;

        if (this.store) {
          this.store.addUsage(tokenRecord.tenantId, provider.id, today, promptTokens, completionTokens, cost, revenue);
        }
        tokenRecord.usedTokensToday += totalTokens;
        tokenRecord.usedCostUsdToday += Number(cost.toFixed(8));
        return data;
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
          lastError = new LlmProxyError(504, "relay_timeout", `中转站 ${provider.id} 请求超时`);
          break;
        }
        this.recordProviderFailure(provider.id);
        const safeMsg = err instanceof Error ? err.message.replaceAll(masterKey, "[REDACTED]") : "relay_network_error";
        lastError = new LlmProxyError(503, "relay_unreachable", `中转站 ${provider.id} 不可达: ${safeMsg}`);
      }
    }

    throw lastError ?? new LlmProxyError(503, "relay_circuit_open", "所有中转站均已熔断或不可用，已按预算规则降级停止重试");
  }

  /** Creates a Jev fast-router small model backed by the relay proxy (preserves 500ms timeout fallback). */
  createJevSmallModel(tenantId: string, botId = "bot_jev_router"): JevSmallModel {
    const { token } = this.issueVirtualToken({ tenantId, botId, ttlMs: 24 * 60 * 60_000 });
    return async (text: string, signal: AbortSignal): Promise<JevModelVerdict> => {
      const provider = this.providers.find((p) => p.enabled);
      const model = provider?.fastModel ?? "deepseek-chat";
      const response = await this.chatCompletions(
        token,
        {
          model,
          temperature: 0,
          max_tokens: 80,
          messages: [
            {
              role: "system",
              content:
                'Classify user intent into JSON {"role":"lead|procurement|order|followup","confidence":0.0-1.0,"reason":"..."}',
            },
            { role: "user", content: text },
          ],
        },
        signal,
      );
      const content = response.choices[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as { role?: RoutingRole; confidence?: number; reason?: string };
      return {
        role: parsed.role ?? "lead",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reason: parsed.reason,
      };
    };
  }

  /** Startup readiness check replacing local CLI login requirement. */
  checkReadiness(): LlmProxyReadiness {
    const active = this.providers.find((p) => p.enabled) ?? null;
    if (!active) {
      return {
        reachable: true,
        relayConfigured: false,
        activeProviderId: null,
        activeProviderUrl: null,
        circuitState: "closed",
        defaultModel: "deepseek-chat",
        fastModel: "deepseek-chat",
        localCliRequired: false,
        reason: "未配置 OMB_LLM_RELAY_BASE_URL / OMB_LLM_RELAY_API_KEY",
      };
    }
    const circuitState = this.getProviderCircuitState(active.id);
    return {
      reachable: circuitState !== "open",
      relayConfigured: true,
      activeProviderId: active.id,
      activeProviderUrl: active.baseUrl,
      circuitState,
      defaultModel: active.defaultModel,
      fastModel: active.fastModel,
      localCliRequired: false,
      ...(circuitState === "open" ? { reason: "主中转站处于熔断状态" } : {}),
    };
  }
}
