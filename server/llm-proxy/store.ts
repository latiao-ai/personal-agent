import type { DatabaseSync } from "node:sqlite";

import type { LlmPricing } from "../../shared/llm-proxy.ts";

export interface StoredLlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  fastModel: string;
  enabled: boolean;
  priority: number;
  updatedBy: string;
  updatedAt: number;
}

export interface DailyLlmUsageSummary {
  tenantId: string;
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  revenue: number;
}

export interface MonthlyLlmUsageSummary {
  tenantId: string;
  month: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  revenue: number;
}

export const LLM_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    default_model TEXT NOT NULL,
    fast_model TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_pricing (
    provider_id TEXT PRIMARY KEY,
    cost_input_per_1m REAL NOT NULL,
    cost_output_per_1m REAL NOT NULL,
    price_input_per_1m REAL NOT NULL,
    price_output_per_1m REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CNY'
  );

  CREATE TABLE IF NOT EXISTS llm_usage_daily (
    tenant_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, provider_id, date)
  );
`;

/** SQLite persistence for control-plane LLM providers, pricing, and daily tenant usage (keys stay in Vault). */
export class LlmProxyStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(LLM_TABLES_SQL);
  }

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure when transaction is already closed.
      }
      throw error;
    }
  }

  listProviders(): StoredLlmProvider[] {
    const rows = this.db
      .prepare(`SELECT * FROM llm_providers ORDER BY priority ASC, updated_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToProvider);
  }

  getProvider(id: string): StoredLlmProvider | null {
    const row = this.db
      .prepare(`SELECT * FROM llm_providers WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToProvider(row) : null;
  }

  upsertProvider(row: StoredLlmProvider): StoredLlmProvider {
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO llm_providers (
            id, name, base_url, default_model, fast_model, enabled, priority, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            base_url = excluded.base_url,
            default_model = excluded.default_model,
            fast_model = excluded.fast_model,
            enabled = excluded.enabled,
            priority = excluded.priority,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`,
        )
        .run(
          row.id,
          row.name,
          row.baseUrl,
          row.defaultModel,
          row.fastModel,
          row.enabled ? 1 : 0,
          row.priority,
          row.updatedBy,
          row.updatedAt,
        );
    });
    return this.getProvider(row.id)!;
  }

  getPricing(providerId: string): LlmPricing | null {
    const row = this.db
      .prepare(`SELECT * FROM llm_pricing WHERE provider_id = ?`)
      .get(providerId) as Record<string, unknown> | undefined;
    return row ? rowToPricing(row) : null;
  }

  upsertPricing(pricing: LlmPricing): LlmPricing {
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO llm_pricing (
            provider_id, cost_input_per_1m, cost_output_per_1m, price_input_per_1m, price_output_per_1m, currency
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_id) DO UPDATE SET
            cost_input_per_1m = excluded.cost_input_per_1m,
            cost_output_per_1m = excluded.cost_output_per_1m,
            price_input_per_1m = excluded.price_input_per_1m,
            price_output_per_1m = excluded.price_output_per_1m,
            currency = excluded.currency`,
        )
        .run(
          pricing.providerId,
          pricing.costPer1MInputTokens,
          pricing.costPer1MOutputTokens,
          pricing.pricePer1MInputTokens,
          pricing.pricePer1MOutputTokens,
          pricing.currency,
        );
    });
    return this.getPricing(pricing.providerId)!;
  }

  addUsage(
    tenantId: string,
    providerId: string,
    date: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    revenue: number,
  ): void {
    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO llm_usage_daily (
            tenant_id, provider_id, date, input_tokens, output_tokens, cost, revenue
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, provider_id, date) DO UPDATE SET
            input_tokens = llm_usage_daily.input_tokens + excluded.input_tokens,
            output_tokens = llm_usage_daily.output_tokens + excluded.output_tokens,
            cost = llm_usage_daily.cost + excluded.cost,
            revenue = llm_usage_daily.revenue + excluded.revenue`,
        )
        .run(tenantId, providerId, date, inputTokens, outputTokens, cost, revenue);
    });
  }

  getUsage(tenantId: string, date: string): DailyLlmUsageSummary {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(revenue), 0) AS revenue
         FROM llm_usage_daily
         WHERE tenant_id = ? AND date = ?`,
      )
      .get(tenantId, date) as Record<string, unknown> | undefined;
    return {
      tenantId,
      date,
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cost: Number(row?.cost ?? 0),
      revenue: Number(row?.revenue ?? 0),
    };
  }

  getMonthlyUsage(tenantId: string, yearMonth: string): MonthlyLlmUsageSummary {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost), 0) AS cost,
           COALESCE(SUM(revenue), 0) AS revenue
         FROM llm_usage_daily
         WHERE tenant_id = ? AND date LIKE ?`,
      )
      .get(tenantId, `${yearMonth}%`) as Record<string, unknown> | undefined;
    return {
      tenantId,
      month: yearMonth,
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      cost: Number(row?.cost ?? 0),
      revenue: Number(row?.revenue ?? 0),
    };
  }
}

function rowToProvider(row: Record<string, unknown>): StoredLlmProvider {
  return {
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    defaultModel: String(row.default_model),
    fastModel: String(row.fast_model),
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority),
    updatedBy: String(row.updated_by),
    updatedAt: Number(row.updated_at),
  };
}

function rowToPricing(row: Record<string, unknown>): LlmPricing {
  return {
    providerId: String(row.provider_id),
    costPer1MInputTokens: Number(row.cost_input_per_1m),
    costPer1MOutputTokens: Number(row.cost_output_per_1m),
    pricePer1MInputTokens: Number(row.price_input_per_1m),
    pricePer1MOutputTokens: Number(row.price_output_per_1m),
    currency: "CNY",
  };
}
