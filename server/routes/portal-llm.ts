import { z } from "zod";

import type { AdminSession, CustomerSession } from "../../shared/portal.ts";
import type { PortalEngine } from "../portal/engine.ts";
import { PASS, type RouteContext } from "./table.ts";

const saveProviderSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1),
  fastModel: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
});

const rotateKeySchema = z.object({
  apiKey: z.string().min(1),
  confirm: z.boolean(),
});

const pricingSchema = z.object({
  costPer1MInputTokens: z.number().nonnegative(),
  costPer1MOutputTokens: z.number().nonnegative(),
  pricePer1MInputTokens: z.number().nonnegative(),
  pricePer1MOutputTokens: z.number().nonnegative(),
});

const tenantBudgetSchema = z.object({
  maxTokensPerDay: z.number().int().nonnegative().optional(),
  maxCostPerDay: z.number().nonnegative().optional(),
});

/** Customer portal LLM usage route (`GET /api/portal/llm/usage`). */
export async function handlePortalLlmRoute(
  ctx: RouteContext,
  portal: PortalEngine,
  session: CustomerSession,
  requestedTenantId: string | null,
): Promise<typeof PASS | void> {
  if (ctx.path === "/api/portal/llm/usage" && ctx.method === "GET") {
    ctx.json(ctx.res, 200, { usage: portal.getCustomerLlmUsage(session, requestedTenantId) });
    return;
  }
  return PASS;
}

/** Admin console LLM configuration, pricing, quota, and usage routes (`/api/admin/llm/*`). */
export async function handleAdminLlmRoute(
  ctx: RouteContext,
  portal: PortalEngine,
  adminSession: AdminSession,
): Promise<typeof PASS | void> {
  const { req, res, path, method, url, json, readBody } = ctx;
  if (!path.startsWith("/api/admin/llm/")) return PASS;

  if (path === "/api/admin/llm/providers" && method === "GET") {
    json(res, 200, { providers: portal.listLlmProvidersAsAdmin(adminSession) });
    return;
  }

  if (path === "/api/admin/llm/providers" && method === "POST") {
    const parsed = saveProviderSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: "invalid_llm_provider", issues: parsed.error.issues });
      return;
    }
    const provider = portal.saveLlmProviderAsAdmin(adminSession, parsed.data);
    json(res, 200, { provider });
    return;
  }

  const providerTestMatch = /^\/api\/admin\/llm\/providers\/([^/]+)\/test$/.exec(path);
  if (providerTestMatch && method === "POST") {
    const result = await portal.testLlmProviderAsAdmin(adminSession, decodeURIComponent(providerTestMatch[1]!));
    json(res, 200, result);
    return;
  }

  const providerRotateMatch = /^\/api\/admin\/llm\/providers\/([^/]+)\/rotate$/.exec(path);
  if (providerRotateMatch && method === "POST") {
    const parsed = rotateKeySchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: "invalid_rotate_payload", issues: parsed.error.issues });
      return;
    }
    const provider = portal.rotateLlmApiKeyAsAdmin(
      adminSession,
      decodeURIComponent(providerRotateMatch[1]!),
      parsed.data.apiKey,
      parsed.data.confirm,
    );
    json(res, 200, { provider });
    return;
  }

  const providerPutMatch = /^\/api\/admin\/llm\/providers\/([^/]+)$/.exec(path);
  if (providerPutMatch && method === "PUT") {
    const parsed = saveProviderSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: "invalid_llm_provider", issues: parsed.error.issues });
      return;
    }
    const provider = portal.saveLlmProviderAsAdmin(adminSession, {
      ...parsed.data,
      id: decodeURIComponent(providerPutMatch[1]!),
    });
    json(res, 200, { provider });
    return;
  }

  const pricingMatch = /^\/api\/admin\/llm\/pricing\/([^/]+)$/.exec(path);
  if (pricingMatch && method === "GET") {
    const pricing = portal.getLlmPricingAsAdmin(decodeURIComponent(pricingMatch[1]!));
    json(res, 200, { pricing });
    return;
  }
  if (pricingMatch && method === "PUT") {
    const parsed = pricingSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: "invalid_llm_pricing", issues: parsed.error.issues });
      return;
    }
    const pricing = portal.setLlmPricingAsAdmin(adminSession, decodeURIComponent(pricingMatch[1]!), parsed.data);
    json(res, 200, { pricing });
    return;
  }

  const usageMatch = /^\/api\/admin\/llm\/usage\/([^/]+)$/.exec(path);
  if (usageMatch && method === "GET") {
    const date = url.searchParams.get("date") || undefined;
    const usage = portal.getTenantLlmUsageAsAdmin(adminSession, decodeURIComponent(usageMatch[1]!), date);
    json(res, 200, { usage });
    return;
  }

  const budgetMatch = /^\/api\/admin\/llm\/tenants\/([^/]+)\/budget$/.exec(path);
  if (budgetMatch && method === "PUT") {
    const parsed = tenantBudgetSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: "invalid_llm_budget", issues: parsed.error.issues });
      return;
    }
    const budget = portal.setTenantLlmBudgetAsAdmin(adminSession, decodeURIComponent(budgetMatch[1]!), parsed.data);
    json(res, 200, { budget });
    return;
  }

  return PASS;
}
