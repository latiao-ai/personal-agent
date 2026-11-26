import { randomBytes } from "node:crypto";

import type { EphemeralSurrogateToken } from "../../shared/approvals.ts";
import { withoutCloudSecrets } from "../cloud-secrets.ts";

const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;

/**
 * Control-plane tenant-isolated Credential Vault and ephemeral surrogate token issuer.
 * Raw secrets stay strictly inside control-plane memory/vault per tenantId; VM agents only
 * ever receive short-lived single-use surrogate tokens embedding budget & tool bounds.
 */
export class ControlPlaneVault {
  private readonly tenantSecrets = new Map<string, Map<string, string>>();
  private readonly tokens = new Map<string, EphemeralSurrogateToken>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Stores a real credential inside a specific tenant's isolated vault partition. */
  setSecret(tenantId: string, name: string, value: string): void {
    let bucket = this.tenantSecrets.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.tenantSecrets.set(tenantId, bucket);
    }
    bucket.set(name, value);
  }

  /** Lists secret names (never values) registered for a tenant. */
  listSecretNames(tenantId: string): string[] {
    return [...(this.tenantSecrets.get(tenantId)?.keys() ?? [])];
  }

  /** Issues a short-lived surrogate token scoped to one ticket, tenant, tool list, and budget cap. */
  issueSurrogateToken(input: {
    tenantId: string;
    ticketId: string;
    toolAllowlist: string[];
    maxTokenSpend: number;
    maxBusinessSpend: number;
    currency: string;
    ttlMs?: number;
  }): EphemeralSurrogateToken {
    const now = this.now();
    const record: EphemeralSurrogateToken = {
      token: `stkn_${randomBytes(24).toString("hex")}`,
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      toolAllowlist: [...input.toolAllowlist],
      maxTokenSpend: input.maxTokenSpend,
      maxBusinessSpend: input.maxBusinessSpend,
      currency: input.currency,
      issuedAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
      consumed: false,
    };
    this.tokens.set(record.token, record);
    return { ...record, toolAllowlist: [...record.toolAllowlist] };
  }

  /** Consumes a surrogate token once; validates expiry, tenant, tool allowlist, and embedded budget cap. */
  consumeSurrogateToken(input: {
    token: string;
    tenantId: string;
    toolName: string;
    businessSpend?: number;
    tokenSpend?: number;
  }): { ok: true; ticketId: string } | { ok: false; reason: string } {
    const record = this.tokens.get(input.token);
    if (!record) return { ok: false, reason: "token_unknown" };
    if (record.consumed) return { ok: false, reason: "token_already_consumed" };
    if (this.now() > record.expiresAt) {
      record.consumed = true;
      return { ok: false, reason: "token_expired" };
    }
    if (record.tenantId !== input.tenantId) return { ok: false, reason: "tenant_mismatch" };
    if (record.toolAllowlist.length > 0 && !record.toolAllowlist.includes(input.toolName)) {
      return { ok: false, reason: "tool_not_allowed_by_token" };
    }
    if ((input.businessSpend ?? 0) > record.maxBusinessSpend) {
      return { ok: false, reason: "token_business_budget_exceeded" };
    }
    if ((input.tokenSpend ?? 0) > record.maxTokenSpend) {
      return { ok: false, reason: "token_model_budget_exceeded" };
    }
    record.consumed = true;
    return { ok: true, ticketId: record.ticketId };
  }

  /**
   * Builds a sanitized agent process environment: strips cloud secrets and every registered
   * raw secret key/value for this tenant, injecting only the ephemeral surrogate token.
   */
  buildAgentProcessEnv(baseEnv: NodeJS.ProcessEnv, surrogate: EphemeralSurrogateToken): NodeJS.ProcessEnv {
    const sanitized = withoutCloudSecrets(baseEnv);
    const tenantBucket = this.tenantSecrets.get(surrogate.tenantId);
    if (tenantBucket) {
      const secretValues = new Set(tenantBucket.values());
      for (const [key, val] of Object.entries(sanitized)) {
        if (tenantBucket.has(key) || (val !== undefined && secretValues.has(val))) {
          delete sanitized[key];
        }
      }
    }
    sanitized.OMB_SURROGATE_TOKEN = surrogate.token;
    sanitized.OMB_SURROGATE_TICKET_ID = surrogate.ticketId;
    return sanitized;
  }
}
