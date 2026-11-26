import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { PortalError, type PortalEngine } from "../portal/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const PORTAL_SESSION_COOKIE = "omb_portal_session";
export const ADMIN_SESSION_COOKIE = "omb_admin_session";

const qrConfirmSchema = z.object({
  qrToken: z.string().min(1),
  openId: z.string().min(1),
});

const qrExchangeSchema = z.object({
  qrToken: z.string().min(1),
  cookie: z.boolean().optional(),
});

const botToggleSchema = z.object({
  enabled: z.boolean(),
  tenantId: z.string().min(1).optional(),
});

const approvalDecideSchema = z.object({
  action: z.enum(["allow_once", "always_allow", "deny"]),
});

const budgetPatchSchema = z.object({
  tenantId: z.string().min(1).optional(),
  tokenPerTx: z.number().nonnegative().optional(),
  tokenDaily: z.number().nonnegative().optional(),
  tokenMonthly: z.number().nonnegative().optional(),
  businessPerTx: z.number().nonnegative().optional(),
  businessDaily: z.number().nonnegative().optional(),
  businessMonthly: z.number().nonnegative().optional(),
  currency: z.string().min(1).max(16).optional(),
});

const schedulePatchSchema = z.object({
  tenantId: z.string().min(1).optional(),
  patrolFrequencyPerDay: z.number().int().min(1).max(24).optional(),
  dailyDigestTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  patrolEnabled: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
});

const memorySuggestionSchema = z.object({
  memoryId: z.string().min(1),
  suggestedContent: z.string().min(1),
  reason: z.string().min(1),
});

const approversSchema = z.object({
  tenantId: z.string().min(1).optional(),
  approverOpenIds: z.array(z.string().min(1)),
});

const adminLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  cookie: z.boolean().optional(),
});

const adminCreateAccountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  displayName: z.string().min(1).optional(),
});

const adminProvisionSchema = z.object({
  tenantId: z.string().min(1),
  openIds: z.array(z.string().min(1)).min(1),
  hostNodeId: z.string().min(1).optional(),
  quota: z
    .object({
      vcpu: z.number().int().min(1).max(64).optional(),
      memoryGb: z.number().int().min(2).max(128).optional(),
      diskGb: z.number().int().min(10).max(1000).optional(),
    })
    .optional(),
});

const adminMemberSchema = z.object({
  openId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "member"]),
});

const adminOffboardSchema = z.object({
  confirm: z.boolean(),
});

const coreSkillRequestSchema = z.object({
  tenantId: z.string().min(1),
  skillId: z.string().min(1),
  reason: z.string().min(1),
  patch: z.object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    triggerPhrases: z.array(z.string().min(1)).optional(),
    spec: z
      .object({
        inputs: z.string().optional(),
        outputs: z.string().optional(),
        tools: z.array(z.string()).optional(),
        boundaries: z.string().optional(),
        failureHandling: z.string().optional(),
      })
      .optional(),
  }),
});

const coreSkillApproveSchema = z.object({
  confirm: z.boolean(),
});

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    map.set(key, val);
  }
  return map;
}

function extractToken(req: IncomingMessage, cookieName: string, url?: URL): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const queryToken = url?.searchParams.get("token");
  if (queryToken) return queryToken.trim();
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies.get(cookieName) ?? null;
}

function setSessionCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number): void {
  res.setHeader(
    "set-cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`,
  );
}

function clearSessionCookie(res: ServerResponse, name: string): void {
  res.setHeader("set-cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export interface PortalRouteDeps {
  portal: PortalEngine;
}

/**
 * HTTP routes for Customer Web Portal (`/api/portal/*`) and Admin Console (`/api/admin/*`).
 * Self-authenticating so remote browsers (mobile/iPad/desktop) can authenticate directly
 * via Feishu QR (customers) or separate admin credentials (operators) without desktop pairing.
 */
export function createPortalRoutes({ portal }: PortalRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (!path.startsWith("/api/portal/") && !path.startsWith("/api/admin/")) {
      return PASS;
    }

    try {
      // =====================================================================
      // Customer Portal Auth (Feishu QR only, no password)
      // =====================================================================
      if (path === "/api/portal/auth/qr/start" && method === "POST") {
        const challenge = portal.createFeishuQrChallenge();
        return json(res, 200, { challenge });
      }

      if (path === "/api/portal/auth/qr/status" && method === "GET") {
        const qrToken = url.searchParams.get("qrToken") ?? "";
        if (!qrToken) return json(res, 400, { error: "missing_qr_token" });
        const challenge = portal.getFeishuQrChallenge(qrToken);
        return challenge ? json(res, 200, { challenge }) : json(res, 404, { error: "qr_not_found" });
      }

      if (path === "/api/portal/auth/qr/confirm" && method === "POST") {
        const parsed = qrConfirmSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_qr_confirm", issues: parsed.error.issues });
        const result = portal.confirmFeishuQrChallenge(parsed.data.qrToken, parsed.data.openId);
        return json(res, 200, result);
      }

      if (path === "/api/portal/auth/qr/exchange" && method === "POST") {
        const parsed = qrExchangeSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_qr_exchange", issues: parsed.error.issues });
        const exchanged = portal.exchangeFeishuQrChallenge(parsed.data.qrToken);
        if (parsed.data.cookie !== false) {
          setSessionCookie(res, PORTAL_SESSION_COOKIE, exchanged.token, 24 * 60 * 60);
        }
        return json(res, 200, exchanged);
      }

      if (path === "/api/portal/auth/logout" && method === "POST") {
        const token = extractToken(req, PORTAL_SESSION_COOKIE);
        if (token) portal.logoutCustomer(token);
        clearSessionCookie(res, PORTAL_SESSION_COOKIE);
        return json(res, 200, { ok: true });
      }

      // =====================================================================
      // Customer Portal Protected API (`/api/portal/*`)
      // =====================================================================
      if (path.startsWith("/api/portal/")) {
        const token = extractToken(req, PORTAL_SESSION_COOKIE, url);
        const session = portal.authenticateCustomer(token);
        if (!session) {
          return json(res, 401, { error: "customer_auth_required", message: "请先使用飞书扫码登录客户门户" });
        }

        if (path === "/api/portal/auth/me" && method === "GET") {
          return json(res, 200, { session });
        }

        const requestedTenantId = url.searchParams.get("tenantId");

        // Page 1: Bots
        if (path === "/api/portal/bots" && method === "GET") {
          return json(res, 200, { bots: portal.listCustomerBots(session, requestedTenantId) });
        }
        const botMatch = /^\/api\/portal\/bots\/([^/]+)$/.exec(path);
        if (botMatch && method === "PATCH") {
          const parsed = botToggleSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_bot_toggle", issues: parsed.error.issues });
          const bot = portal.setCustomerBotEnabled(
            session,
            decodeURIComponent(botMatch[1]!),
            parsed.data.enabled,
            parsed.data.tenantId,
          );
          return json(res, 200, { bot });
        }

        // Page 2: Tickets & Approvals (Dual-Channel + SSE)
        if (path === "/api/portal/tickets" && method === "GET") {
          return json(res, 200, { tickets: portal.listCustomerTickets(session, requestedTenantId) });
        }
        const ticketMatch = /^\/api\/portal\/tickets\/([^/]+)$/.exec(path);
        if (ticketMatch && method === "GET") {
          const ticket = portal.getCustomerTicket(session, decodeURIComponent(ticketMatch[1]!));
          return json(res, 200, { ticket });
        }

        if (path === "/api/portal/approvals/stream" && method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          res.write(`event: connected\ndata: ${JSON.stringify({ tenantId: session.tenantId })}\n\n`);
          const unsubscribe = portal.onApprovalCardEvent((event) => {
            if (event.card.tenantId !== session.tenantId) return;
            res.write(`event: approval\ndata: ${JSON.stringify(event)}\n\n`);
          });
          req.on("close", () => {
            unsubscribe();
          });
          return;
        }

        if (path === "/api/portal/approvals" && method === "GET") {
          return json(res, 200, { approvals: portal.listCustomerApprovals(session, requestedTenantId) });
        }
        const approvalMatch = /^\/api\/portal\/approvals\/([^/]+)$/.exec(path);
        if (approvalMatch && method === "GET") {
          const approval = portal.getCustomerApproval(session, decodeURIComponent(approvalMatch[1]!));
          return json(res, 200, { approval });
        }
        const decideMatch = /^\/api\/portal\/approvals\/([^/]+)\/decide$/.exec(path);
        if (decideMatch && method === "POST") {
          const parsed = approvalDecideSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_approval_decision", issues: parsed.error.issues });
          const outcome = portal.decideApprovalFromWeb(
            session,
            decodeURIComponent(decideMatch[1]!),
            parsed.data.action,
          );
          return json(res, 200, outcome);
        }

        // Page 3: Spend & Budget
        if (path === "/api/portal/spend" && method === "GET") {
          return json(res, 200, { spend: portal.getCustomerSpend(session, requestedTenantId) });
        }
        if (path === "/api/portal/budget" && method === "PUT") {
          const parsed = budgetPatchSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_budget_patch", issues: parsed.error.issues });
          const { tenantId, ...patch } = parsed.data;
          const policy = portal.updateCustomerBudget(session, patch, tenantId);
          return json(res, 200, { policy });
        }

        // Page 4: Scheduled Tasks
        if (path === "/api/portal/schedule" && method === "GET") {
          return json(res, 200, { schedule: portal.getCustomerSchedule(session, requestedTenantId) });
        }
        if (path === "/api/portal/schedule" && method === "PUT") {
          const parsed = schedulePatchSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_schedule_patch", issues: parsed.error.issues });
          const { tenantId, ...patch } = parsed.data;
          const schedule = portal.updateCustomerSchedule(session, patch, tenantId);
          return json(res, 200, { schedule });
        }

        // Page 5: Memory & Skills
        if (path === "/api/portal/memory-skill" && method === "GET") {
          return json(res, 200, portal.getCustomerMemoryAndSkills(session, requestedTenantId));
        }
        if (path === "/api/portal/memory/suggestions" && method === "POST") {
          const parsed = memorySuggestionSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_memory_suggestion", issues: parsed.error.issues });
          const suggestion = portal.submitCustomerMemorySuggestion(session, parsed.data);
          return json(res, 201, { suggestion });
        }
        const skillMutMatch = /^\/api\/portal\/skills\/([^/]+)$/.exec(path);
        if (skillMutMatch && (method === "PATCH" || method === "PUT" || method === "POST")) {
          const raw = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
          portal.attemptCustomerSkillMutation(session, decodeURIComponent(skillMutMatch[1]!), {
            name: typeof raw?.name === "string" ? raw.name : undefined,
            description: typeof raw?.description === "string" ? raw.description : undefined,
          });
        }

        // Page 6: Settings, Audit, Export
        if (path === "/api/portal/settings" && method === "GET") {
          return json(res, 200, { settings: portal.getCustomerSettings(session, requestedTenantId) });
        }
        if (path === "/api/portal/settings/approvers" && method === "PUT") {
          const parsed = approversSchema.safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "invalid_approvers", issues: parsed.error.issues });
          const settings = portal.updateCustomerApprovers(
            session,
            parsed.data.approverOpenIds,
            parsed.data.tenantId,
          );
          return json(res, 200, { settings });
        }
        if (path === "/api/portal/audit" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return json(res, 200, {
            audit: portal.listCustomerAudit(session, requestedTenantId, Number.isFinite(limit) ? limit : 100),
          });
        }
        if (path === "/api/portal/export" && method === "GET") {
          return json(res, 200, { export: portal.exportCustomerData(session, requestedTenantId) });
        }

        return json(res, 404, { error: "portal_route_not_found" });
      }

      // =====================================================================
      // Admin Console Auth (Separate from Customer Feishu QR)
      // =====================================================================
      if (path === "/api/admin/auth/login" && method === "POST") {
        // Explicitly reject customer tokens or Feishu QR payloads attempting to log into admin console.
        const raw = (await readBody(req)) as Record<string, unknown> | null;
        if (raw && (typeof raw.qrToken === "string" || typeof raw.openId === "string")) {
          return json(res, 403, { error: "customer_login_forbidden_on_admin", message: "客户账号禁止登录管理后台" });
        }
        const parsed = adminLoginSchema.safeParse(raw);
        if (!parsed.success) return json(res, 400, { error: "invalid_admin_login", issues: parsed.error.issues });
        const loggedIn = portal.loginAdmin(parsed.data.username, parsed.data.password);
        if (parsed.data.cookie !== false) {
          setSessionCookie(res, ADMIN_SESSION_COOKIE, loggedIn.token, 8 * 60 * 60);
        }
        return json(res, 200, loggedIn);
      }

      if (path === "/api/admin/auth/logout" && method === "POST") {
        const token = extractToken(req, ADMIN_SESSION_COOKIE);
        if (token) portal.logoutAdmin(token);
        clearSessionCookie(res, ADMIN_SESSION_COOKIE);
        return json(res, 200, { ok: true });
      }

      // =====================================================================
      // Admin Console Protected API (`/api/admin/*`)
      // =====================================================================
      const adminToken = extractToken(req, ADMIN_SESSION_COOKIE);
      // If a customer token is presented to admin endpoints, explicitly return 403.
      if (adminToken && portal.authenticateCustomer(adminToken)) {
        return json(res, 403, { error: "customer_forbidden_on_admin", message: "客户账号无权访问管理后台" });
      }
      const adminSession = portal.authenticateAdmin(adminToken);
      if (!adminSession) {
        // Also check if request carried a customer cookie while calling admin API.
        const custCookie = parseCookieHeader(req.headers.cookie).get(PORTAL_SESSION_COOKIE);
        if (custCookie && portal.authenticateCustomer(custCookie)) {
          return json(res, 403, { error: "customer_forbidden_on_admin", message: "客户账号无权访问管理后台" });
        }
        return json(res, 401, { error: "admin_auth_required", message: "请先使用管理员账号登录管理后台" });
      }

      if (path === "/api/admin/auth/me" && method === "GET") {
        return json(res, 200, { session: adminSession });
      }

      if (path === "/api/admin/tenants" && method === "GET") {
        return json(res, 200, { tenants: portal.listAllTenantsOverview() });
      }

      if (path === "/api/admin/tenants/provision" && method === "POST") {
        const parsed = adminProvisionSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_provision", issues: parsed.error.issues });
        return json(res, 201, portal.provisionTenantAsAdmin(adminSession, parsed.data));
      }

      const offboardMatch = /^\/api\/admin\/tenants\/([^/]+)\/offboard$/.exec(path);
      if (offboardMatch && method === "POST") {
        const parsed = adminOffboardSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_offboard", issues: parsed.error.issues });
        const result = portal.offboardTenantAsAdmin(
          adminSession,
          decodeURIComponent(offboardMatch[1]!),
          parsed.data.confirm,
        );
        return json(res, 200, result);
      }

      const memberMatch = /^\/api\/admin\/tenants\/([^/]+)\/members$/.exec(path);
      if (memberMatch && method === "POST") {
        const parsed = adminMemberSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_member", issues: parsed.error.issues });
        const member = portal.registerTenantMember({
          tenantId: decodeURIComponent(memberMatch[1]!),
          ...parsed.data,
        });
        return json(res, 201, { member });
      }

      if (path === "/api/admin/approvals" && method === "GET") {
        const tenantId = url.searchParams.get("tenantId") || undefined;
        return json(res, 200, { approvals: portal.listAllApprovals(tenantId) });
      }

      if (path === "/api/admin/audit" && method === "GET") {
        const tenantId = url.searchParams.get("tenantId") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? 200);
        return json(res, 200, { audit: portal.listAllAudit(tenantId, Number.isFinite(limit) ? limit : 200) });
      }

      if (path === "/api/admin/core-skills/requests" && method === "GET") {
        const tenantId = url.searchParams.get("tenantId") || undefined;
        return json(res, 200, { requests: portal.listCoreSkillChangeRequests(tenantId) });
      }

      if (path === "/api/admin/core-skills/requests" && method === "POST") {
        const parsed = coreSkillRequestSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_core_skill_request", issues: parsed.error.issues });
        const request = portal.requestCoreSkillHashChange(adminSession, parsed.data);
        return json(res, 201, { request });
      }

      const approveCoreMatch = /^\/api\/admin\/core-skills\/requests\/([^/]+)\/approve$/.exec(path);
      if (approveCoreMatch && method === "POST") {
        const parsed = coreSkillApproveSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_core_skill_approve", issues: parsed.error.issues });
        const result = portal.approveCoreSkillHashChange(
          adminSession,
          decodeURIComponent(approveCoreMatch[1]!),
          parsed.data.confirm,
        );
        return json(res, 200, result);
      }

      const directCoreMatch = /^\/api\/admin\/core-skills\/([^/]+)$/.exec(path);
      if (directCoreMatch && (method === "PATCH" || method === "PUT")) {
        const raw = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
        const tenantId = typeof raw?.tenantId === "string" ? raw.tenantId : "unknown";
        portal.directMutateCoreSkillForbidden(adminSession, tenantId, decodeURIComponent(directCoreMatch[1]!));
      }

      if (path === "/api/admin/accounts" && method === "GET") {
        return json(res, 200, { accounts: portal.listAdminAccounts() });
      }

      if (path === "/api/admin/accounts" && method === "POST") {
        const parsed = adminCreateAccountSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "invalid_admin_account", issues: parsed.error.issues });
        const account = portal.createAdminAccount(adminSession, parsed.data);
        return json(res, 201, { account });
      }

      const revokeAdminMatch = /^\/api\/admin\/accounts\/([^/]+)\/revoke$/.exec(path);
      if (revokeAdminMatch && method === "POST") {
        const result = portal.revokeAdminAccount(adminSession, decodeURIComponent(revokeAdminMatch[1]!));
        return json(res, 200, result);
      }

      return json(res, 404, { error: "admin_route_not_found" });
    } catch (error) {
      if (error instanceof PortalError) {
        return json(res, error.status, { error: error.code, message: error.message });
      }
      throw error;
    }
  };
}
