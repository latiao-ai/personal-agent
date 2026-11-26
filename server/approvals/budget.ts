import type { DualBudgetPolicy } from "../../shared/approvals.ts";

export const DEFAULT_DUAL_BUDGET_POLICY: DualBudgetPolicy = {
  tokenPerTx: 5,
  tokenDaily: 50,
  tokenMonthly: 500,
  businessPerTx: 1_000,
  businessDaily: 5_000,
  businessMonthly: 30_000,
  currency: "CNY",
};

export interface SpendTotals {
  tokenDay: number;
  tokenMonth: number;
  businessDay: number;
  businessMonth: number;
}

export type BudgetCheckResult =
  | { ok: true }
  | { ok: false; code: "budget_exceeded"; dimension: string; limit: number; projected: number; reason: string };

/** Hard-rule dual budget guard: checks per-tx, daily, and monthly caps for token and business spend separately. */
export function evaluateDualBudget(
  policy: DualBudgetPolicy,
  totals: SpendTotals,
  request: { tokenCost: number; businessCost: number },
): BudgetCheckResult {
  const tokenCost = Math.max(0, request.tokenCost);
  const businessCost = Math.max(0, request.businessCost);

  if (tokenCost > policy.tokenPerTx) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "token_per_tx",
      limit: policy.tokenPerTx,
      projected: tokenCost,
      reason: `模型 token 单笔花费 ${tokenCost} 超过上限 ${policy.tokenPerTx}`,
    };
  }
  if (totals.tokenDay + tokenCost > policy.tokenDaily) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "token_daily",
      limit: policy.tokenDaily,
      projected: totals.tokenDay + tokenCost,
      reason: `模型 token 日累计花费 ${totals.tokenDay + tokenCost} 超过上限 ${policy.tokenDaily}`,
    };
  }
  if (totals.tokenMonth + tokenCost > policy.tokenMonthly) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "token_monthly",
      limit: policy.tokenMonthly,
      projected: totals.tokenMonth + tokenCost,
      reason: `模型 token 月累计花费 ${totals.tokenMonth + tokenCost} 超过上限 ${policy.tokenMonthly}`,
    };
  }
  if (businessCost > policy.businessPerTx) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "business_per_tx",
      limit: policy.businessPerTx,
      projected: businessCost,
      reason: `业务单笔花费 ${businessCost} 超过上限 ${policy.businessPerTx}`,
    };
  }
  if (totals.businessDay + businessCost > policy.businessDaily) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "business_daily",
      limit: policy.businessDaily,
      projected: totals.businessDay + businessCost,
      reason: `业务日累计花费 ${totals.businessDay + businessCost} 超过上限 ${policy.businessDaily}`,
    };
  }
  if (totals.businessMonth + businessCost > policy.businessMonthly) {
    return {
      ok: false,
      code: "budget_exceeded",
      dimension: "business_monthly",
      limit: policy.businessMonthly,
      projected: totals.businessMonth + businessCost,
      reason: `业务月累计花费 ${totals.businessMonth + businessCost} 超过上限 ${policy.businessMonthly}`,
    };
  }
  return { ok: true };
}

export function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function utcMonthKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 7);
}
