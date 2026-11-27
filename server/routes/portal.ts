import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { ChannelGatewayEngine } from "../gateway/engine.ts";
import { WeixinAdapter } from "../gateway/adapters.ts";
import { PortalError, type PortalEngine } from "../portal/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const PORTAL_SESSION_COOKIE = "omb_portal_session";
export const ADMIN_SESSION_COOKIE = "omb_admin_session";

const unifiedLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  cookie: z.boolean().optional(),
});

const adminCreateUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  displayName: z.string().min(1).optional(),
  role: z.enum(["customer", "ops_admin"]),
  tenantId: z.string().min(1).optional(),
  tenantRole: z.enum(["admin", "member"]).optional(),
  legacyLocalAccount: z.boolean().optional(),
  autoSwitchSession: z.boolean().optional(),
});

const adminChangePasswordSchema = z.object({
  password: z.string().min(6),
});

const channelBindingCreateSchema = z.object({
  botId: z.string().min(1),
  platform: z.enum(["feishu", "weixin"]),
  platformAppId: z.string().min(1),
  platformSecret: z.string().optional(),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  label: z.string().optional(),
  forceReplaceDuplicateCredential: z.boolean().optional(),
});

const allowlistPutSchema = z.object({
  platform: z.enum(["feishu", "weixin"]),
  allowedSenderIds: z.array(z.string().min(1)),
  tenantId: z.string().min(1).optional(),
});

const feishuIdentitySchema = z.object({
  feishuOpenId: z.string().min(1),
});

const weixinIdentitySchema = z.object({
  weixinOpenId: z.string().min(1),
  ilinkAccountId: z.string().min(1),
});

const weixinQrConfirmSchema = z.object({
  sessionId: z.string().min(1),
  ilinkAccountId: z.string().min(1).optional(),
});

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

function formatSetCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function formatClearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function setSessionCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number): void {
  res.setHeader("set-cookie", formatSetCookie(name, value, maxAgeSeconds));
}

function clearSessionCookie(res: ServerResponse, name: string): void {
  res.setHeader("set-cookie", formatClearCookie(name));
}

/**
 * Server-side route guard for `/portal` and `/admin` HTML pages.
 * Runs before static SPA serving: unauthenticated requests redirect to `/login`;
 * mismatched roles redirect to their own destination page (or 403 for JSON callers).
 */
export function handlePortalPageGuard(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  portal: PortalEngine,
): boolean {
  const isPortal = path === "/portal" || path.startsWith("/portal/");
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  if (!isPortal && !isAdmin) return false;

  const cookies = parseCookieHeader(req.headers.cookie);
  const custSession = portal.authenticateCustomer(cookies.get(PORTAL_SESSION_COOKIE));
  const adminSession = portal.authenticateAdmin(cookies.get(ADMIN_SESSION_COOKIE));
  const wantsJson = String(req.headers.accept ?? "").includes("application/json");

  if (isPortal) {
    if (custSession) return false;
    if (adminSession) {
      res.writeHead(302, { location: "/admin", "cache-control": "no-store" });
      res.end();
      return true;
    }
    res.writeHead(302, { location: `/login?next=${encodeURIComponent(path)}`, "cache-control": "no-store" });
    res.end();
    return true;
  }

  // isAdmin
  if (adminSession) return false;
  if (custSession) {
    if (wantsJson) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "customer_forbidden_on_admin", message: "客户账号无权访问管理后台" }));
      return true;
    }
    res.writeHead(302, { location: "/portal", "cache-control": "no-store" });
    res.end();
    return true;
  }
  res.writeHead(302, { location: `/login?next=${encodeURIComponent(path)}`, "cache-control": "no-store" });
  res.end();
  return true;
}

const UNIFIED_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/register",
]);

export interface PortalRouteDeps {
  portal: PortalEngine;
  gateway?: ChannelGatewayEngine;
}

/**
 * HTTP routes for Unified Auth (`/api/auth/login|me|logout|register`),
 * Customer Web Portal (`/api/portal/*`), and Admin Console (`/api/admin/*`).
 */
export function createPortalRoutes({ portal, gateway }: PortalRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    const isUnifiedAuth = UNIFIED_AUTH_PATHS.has(path);
    if (!isUnifiedAuth && !path.startsWith("/api/portal/") && !path.startsWith("/api/admin/")) {
      return PASS;
    }

    try {
      // =====================================================================
      // Unified Login Entry (`/api/auth/login`, `/api/auth/me`, `/api/auth/logout`)
      // Self-registration is explicitly disabled (403).
      // =====================================================================
      if ((path === "/api/auth/register" || path === "/api/portal/auth/register") && method === "POST") {
        return json(res, 403, {
          error: "self_registration_disabled",
          message: "不开放自助注册，请联系管理员在管理后台创建账号",
        });
      }

      if (path === "/api/auth/login" && method === "POST") {
        const parsed = unifiedLoginSchema.safeParse(await readBody(req));
        if (!parsed.success) {
          return json(res, 400, { error: "invalid_login_payload", issues: parsed.error.issues });
        }
        const result = portal.loginUnified(parsed.data.username, parsed.data.password);
        if (parsed.data.cookie !== false) {
          if (result.kind === "admin") {
            res.setHeader("set-cookie", [
              formatSetCookie(ADMIN_SESSION_COOKIE, result.token, 8 * 60 * 60),
              formatClearCookie(PORTAL_SESSION_COOKIE),
            ]);
          } else {
            res.setHeader("set-cookie", [
              formatSetCookie(PORTAL_SESSION_COOKIE, result.token, 24 * 60 * 60),
              formatClearCookie(ADMIN_SESSION_COOKIE),
            ]);
          }
        }
        return json(res, 200, result);
      }

      if (path === "/api/auth/me" && method === "GET") {
        const adminTok = extractToken(req, ADMIN_SESSION_COOKIE);
        const adminSession = portal.authenticateAdmin(adminTok);
        if (adminSession) {
          return json(res, 200, { authenticated: true, kind: "admin", redirectTo: "/admin", session: adminSession });
        }
        const custTok = extractToken(req, PORTAL_SESSION_COOKIE);
        const custSession = portal.authenticateCustomer(custTok);
        if (custSession) {
          return json(res, 200, { authenticated: true, kind: "customer", redirectTo: "/portal", session: custSession });
        }
        return json(res, 401, { authenticated: false, error: "unauthenticated", message: "请先登录" });
      }

      if (path === "/api/auth/logout" && method === "POST") {
        const custTok = extractToken(req, PORTAL_SESSION_COOKIE);
        const adminTok = extractToken(req, ADMIN_SESSION_COOKIE);
        if (custTok) portal.logoutCustomer(custTok);
        if (adminTok) portal.logoutAdmin(adminTok);
        res.setHeader("set-cookie", [
          formatClearCookie(PORTAL_SESSION_COOKIE),
          formatClearCookie(ADMIN_SESSION_COOKIE),
        ]);
        return json(res, 200, { ok: true });
      }
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

        // Page 7: Messaging Platforms (Feishu + Personal WeChat iLink; WeCom not implemented)
        if (path === "/api/portal/channels/bindings" && method === "GET") {
          const botId = url.searchParams.get("botId") || undefined;
          return json(res, 200, {
            bindings: portal.listChannelBindings(session, { botId, requestedTenantId }),
            gatewayStatus: gateway?.getHealthSnapshot() ?? null,
            weixinNote: WeixinAdapter.GROUP_LIMITATION_NOTE,
          });
        }
        if (path === "/api/portal/channels/bindings" && method === "POST") {
          const raw = (await readBody(req)) as Record<string, unknown> | null;
          if (raw?.platform === "wecom") {
            return json(res, 501, {
              error: "wecom_not_implemented",
              message: "企业微信（WeCom）本次未接通，请使用飞书或个人微信",
            });
          }
          const parsed = channelBindingCreateSchema.safeParse(raw);
          if (!parsed.success) {
            return json(res, 400, { error: "invalid_channel_binding", issues: parsed.error.issues });
          }
          const created = portal.createChannelBinding(session, parsed.data);
          return json(res, 201, created);
        }
        const unbindMatch = /^\/api\/portal\/channels\/bindings\/([^/]+)$/.exec(path);
        if (unbindMatch && method === "DELETE") {
          const binding = portal.unbindChannelBinding(session, decodeURIComponent(unbindMatch[1]!));
          return json(res, 200, { binding });
        }

        if (path === "/api/portal/channels/allowlist" && method === "GET") {
          const platform = url.searchParams.get("platform") === "weixin" ? "weixin" : "feishu";
          return json(res, 200, { allowlist: portal.getTenantChannelAllowlist(session, platform, requestedTenantId) });
        }
        if (path === "/api/portal/channels/allowlist" && method === "PUT") {
          const parsed = allowlistPutSchema.safeParse(await readBody(req));
          if (!parsed.success) {
            return json(res, 400, { error: "invalid_allowlist", issues: parsed.error.issues });
          }
          const allowlist = portal.setTenantChannelAllowlist(
            session,
            parsed.data.platform,
            parsed.data.allowedSenderIds,
            parsed.data.tenantId,
          );
          return json(res, 200, { allowlist });
        }

        if (path === "/api/portal/channels/weixin/qr/start" && method === "POST") {
          if (!gateway) {
            return json(res, 503, { error: "gateway_unavailable", message: "常驻网关未启动" });
          }
          return json(res, 200, { qrSession: gateway.weixin.startIlinkQrLogin() });
        }
        if (path === "/api/portal/channels/weixin/qr/confirm" && method === "POST") {
          if (!gateway) {
            return json(res, 503, { error: "gateway_unavailable", message: "常驻网关未启动" });
          }
          const parsed = weixinQrConfirmSchema.safeParse(await readBody(req));
          if (!parsed.success) {
            return json(res, 400, { error: "invalid_weixin_qr_confirm", issues: parsed.error.issues });
          }
          const qrSession = gateway.weixin.confirmIlinkQrLogin(parsed.data.sessionId, parsed.data.ilinkAccountId);
          return qrSession ? json(res, 200, { qrSession }) : json(res, 404, { error: "qr_session_not_found" });
        }

        if (path === "/api/portal/identities" && method === "GET") {
          return json(res, 200, {
            feishu: portal.listFeishuIdentities(session, requestedTenantId),
            weixin: portal.listWeixinIdentities(session, requestedTenantId),
          });
        }
        if (path === "/api/portal/identities/feishu" && method === "POST") {
          const parsed = feishuIdentitySchema.safeParse(await readBody(req));
          if (!parsed.success) {
            return json(res, 400, { error: "invalid_feishu_identity", issues: parsed.error.issues });
          }
          return json(res, 201, { identity: portal.bindFeishuIdentity(session, parsed.data.feishuOpenId) });
        }
        if (path === "/api/portal/identities/weixin" && method === "POST") {
          const parsed = weixinIdentitySchema.safeParse(await readBody(req));
          if (!parsed.success) {
            return json(res, 400, { error: "invalid_weixin_identity", issues: parsed.error.issues });
          }
          return json(res, 201, { identity: portal.bindWeixinIdentity(session, parsed.data) });
        }

        if (path === "/api/portal/gateway/logs" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          return json(res, 200, {
            status: gateway?.getHealthSnapshot() ?? null,
            logs: gateway?.listLogs({ tenantId: session.tenantId, limit: Number.isFinite(limit) ? limit : 50 }) ?? [],
          });
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

      // Unified User Account Management (Admin-only, no self-registration)
      if (path === "/api/admin/users" && method === "GET") {
        return json(res, 200, { users: portal.listPortalUsers() });
      }
      if (path === "/api/admin/users" && method === "POST") {
        const parsed = adminCreateUserSchema.safeParse(await readBody(req));
        if (!parsed.success) {
          return json(res, 400, { error: "invalid_user_payload", issues: parsed.error.issues });
        }
        const created = portal.createPortalUserAsAdmin(adminSession, parsed.data);
        if (created.customerSession) {
          res.setHeader("set-cookie", [
            formatSetCookie(PORTAL_SESSION_COOKIE, created.customerSession.token, 24 * 60 * 60),
            formatClearCookie(ADMIN_SESSION_COOKIE),
          ]);
        }
        return json(res, 201, {
          user: created.user,
          autoRedirectTo: created.autoRedirectTo,
          switchedToCustomerSession: Boolean(created.customerSession),
        });
      }
      const userPassMatch = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(path);
      if (userPassMatch && method === "PATCH") {
        const parsed = adminChangePasswordSchema.safeParse(await readBody(req));
        if (!parsed.success) {
          return json(res, 400, { error: "invalid_password_payload", issues: parsed.error.issues });
        }
        return json(
          res,
          200,
          portal.changePortalUserPasswordAsAdmin(adminSession, decodeURIComponent(userPassMatch[1]!), parsed.data.password),
        );
      }
      const userDisableMatch = /^\/api\/admin\/users\/([^/]+)\/disable$/.exec(path);
      if (userDisableMatch && method === "POST") {
        return json(res, 200, portal.disablePortalUserAsAdmin(adminSession, decodeURIComponent(userDisableMatch[1]!)));
      }

      if (path === "/api/admin/gateway/status" && method === "GET") {
        return json(res, 200, {
          status: gateway?.getHealthSnapshot() ?? null,
          logs: gateway?.listLogs({ limit: 100 }) ?? [],
        });
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
