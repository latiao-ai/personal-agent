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
