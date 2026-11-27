/** Public control-plane contracts for LLM relay proxy (DeepSeek via OpenAI-compatible relay). */

export type LlmCircuitState = "closed" | "open" | "half_open";

export interface LlmRelayProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  fastModel: string;
  enabled: boolean;
  priority: number;
}

export interface LlmVirtualTokenRecord {
  tokenId: string;
  tenantId: string;
  botId: string;
  issuedAt: number;
  expiresAt: number;
  maxTokensPerDay: number;
  maxCostUsdPerDay: number;
  usedTokensToday: number;
  usedCostUsdToday: number;
  revokedAt: number | null;
}

export interface LlmProxyReadiness {
  reachable: boolean;
  relayConfigured: boolean;
  activeProviderId: string | null;
  activeProviderUrl: string | null;
  circuitState: LlmCircuitState;
  defaultModel: string;
  fastModel: string;
  localCliRequired: false;
  reason?: string;
}

/** Sanitized admin view of an LLM relay provider; never contains plaintext API keys. */
export interface AdminLlmProviderView {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  fastModel: string;
  enabled: boolean;
  priority: number;
  apiKeyConfigured: boolean;
  apiKeyLast4: string;
  updatedAt: number;
  updatedBy: string;
}

/** Per-provider cost and selling price per 1M tokens. */
export interface LlmPricing {
  providerId: string;
  costPer1MInputTokens: number;
  costPer1MOutputTokens: number;
  pricePer1MInputTokens: number;
  pricePer1MOutputTokens: number;
  currency: "CNY";
}

/** Admin view of a tenant's daily LLM usage, cost, revenue, and daily limits. */
export interface TenantLlmUsage {
  tenantId: string;
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  revenue: number;
  maxTokensPerDay: number;
  maxCostPerDay: number;
}

/** Read-only customer portal LLM usage view; omits baseUrl, API keys, and upstream cost. */
export interface PortalTenantLlmUsageView {
  tenantId: string;
  date: string;
  month: string;
  activeModel: string | null;
  todayTokens: number;
  todayRevenue: number;
  monthTokens: number;
  monthRevenue: number;
  maxTokensPerDay: number;
  maxCostPerDay: number;
  remainingTokensToday: number;
  remainingCostToday: number;
  currency: "CNY";
}
