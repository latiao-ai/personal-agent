import { z } from "zod";

import type { ApprovalEngine } from "../approvals/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const evaluateSchema = z.object({
  tenantId: z.string().min(1).default("default"),
  ticketId: z.string().min(1),
  initiator: z.string().min(1),
  approver: z.string().min(1).nullable().optional(),
  actionSummary: z.string().min(1),
  actionCategory: z.enum(["read_only", "low_risk_write", "high_risk_spend", "delete_data", "outward_message"]).optional(),
  toolName: z.string().min(1),
  toolAllowlist: z.array(z.string()).default([]),
  recipient: z.string().optional(),
  riskSummary: z.string().optional(),
  tokenCost: z.number().nonnegative().default(0),
  businessCost: z.number().nonnegative().default(0),
  currency: z.string().min(1).max(16).optional(),
  validUntil: z.number().positive().optional(),
});

const callbackSchema = z.object({
  cardId: z.string().min(1),
  operatorOpenId: z.string().min(1),
  action: z.enum(["allow_once", "always_allow", "deny"]),
  channel: z.enum(["feishu", "web"]).optional(),
  callbackEventId: z.string().optional(),
});

const budgetPolicySchema = z.object({
  tenantId: z.string().min(1).default("default"),
  tokenPerTx: z.number().nonnegative(),
  tokenDaily: z.number().nonnegative(),
  tokenMonthly: z.number().nonnegative(),
  businessPerTx: z.number().nonnegative(),
  businessDaily: z.number().nonnegative(),
  businessMonthly: z.number().nonnegative(),
  currency: z.string().min(1).max(16).default("CNY"),
});

const vaultSecretSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1),
  value: z.string().min(1),
});

const consumeTokenSchema = z.object({
  token: z.string().min(1),
  tenantId: z.string().min(1),
  toolName: z.string().min(1),
  businessSpend: z.number().nonnegative().optional(),
  tokenSpend: z.number().nonnegative().optional(),
});

export interface ApprovalRouteDeps {
  approvals: ApprovalEngine;
}

/** Control-plane HTTP routes for 4-tier approvals, Feishu card callbacks, tenant vault tokens, budgets, and audit. */
export function createApprovalRoutes({ approvals }: ApprovalRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (path === "/api/approvals/evaluate" && method === "POST") {
      const parsed = evaluateSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_approval_request", issues: parsed.error.issues });
      }
      const result = await approvals.evaluate(parsed.data);
      const status =
        result.decision === "rejected"
          ? 403
          : result.decision === "ask_human"
            ? 202
            : 200;
      return json(res, status, result);
    }

    if (path === "/api/approvals/cards/callback" && method === "POST") {
      const parsed = callbackSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_card_callback", issues: parsed.error.issues });
      }
      const result = approvals.handleCardCallback(parsed.data);
      const status = result.ok
        ? 200
        : result.outcome === "card_not_found"
          ? 404
          : result.outcome === "card_expired"
            ? 410
            : 403;
      return json(res, status, result);
    }

    if (path === "/api/approvals/cards" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { cards: approvals.listCards(Number.isFinite(limit) ? limit : 100) });
    }

    if (path === "/api/approvals/budgets" && method === "PUT") {
      const parsed = budgetPolicySchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_budget_policy", issues: parsed.error.issues });
      }
      const { tenantId, ...policy } = parsed.data;
      approvals.setBudgetPolicy(tenantId, policy);
      return json(res, 200, { tenantId, policy });
    }

    if (path === "/api/approvals/budgets" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") || "default";
      return json(res, 200, { tenantId, policy: approvals.getBudgetPolicy(tenantId) });
    }

    if (path === "/api/approvals/vault/secrets" && method === "POST") {
      const parsed = vaultSecretSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_vault_secret", issues: parsed.error.issues });
      }
      approvals.vault.setSecret(parsed.data.tenantId, parsed.data.name, parsed.data.value);
      return json(res, 201, {
        tenantId: parsed.data.tenantId,
        secretNames: approvals.vault.listSecretNames(parsed.data.tenantId),
      });
    }

    if (path === "/api/approvals/vault/tokens/consume" && method === "POST") {
      const parsed = consumeTokenSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_token_consume", issues: parsed.error.issues });
      }
      const outcome = approvals.vault.consumeSurrogateToken(parsed.data);
      return json(res, outcome.ok ? 200 : 403, outcome);
    }

    if (path === "/api/approvals/audit" && method === "GET") {
      const ticketId = url.searchParams.get("ticketId") || undefined;
      const approverOpenId = url.searchParams.get("approverOpenId") || undefined;
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, {
        audit: approvals.listAudit({
          ticketId,
          approverOpenId,
          limit: Number.isFinite(limit) ? limit : 100,
        }),
      });
    }

    const cardMatch = path.match(/^\/api\/approvals\/cards\/([\w-]+)$/);
    if (cardMatch && method === "GET") {
      const card = approvals.getCard(cardMatch[1]!);
      return card ? json(res, 200, { card }) : json(res, 404, { error: "card_not_found" });
    }

    return PASS;
  };
}
