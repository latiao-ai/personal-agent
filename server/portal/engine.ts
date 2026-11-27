import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ApprovalButtonAction, ApprovalCard, DualBudgetPolicy, FeishuCardCallbackResult } from "../../shared/approvals.ts";
import type { VmQuota } from "../../shared/isolation.ts";
import type { SkillSpec } from "../../shared/memory-skill.ts";
import type {
  AdminAccount,
  AdminOffboardResult,
  AdminSession,
  AdminTenantOverview,
  ChannelBinding,
  ChannelPlatform,
  CoreSkillHashChangeRequest,
  CustomerSelfExport,
  CustomerSession,
  MemoryChangeSuggestion,
  PortalApprovalView,
  PortalAuditEntry,
  PortalBotSummary,
  PortalMemorySkillView,
  PortalRole,
  PortalSpendOverview,
  PortalUserAccount,
  QrLoginChallenge,
  TenantChannelAllowlist,
  TenantMember,
  TenantPortalSettings,
  TenantScheduleConfig,
  UnifiedLoginResult,
  UserIdentity,
  WeixinIdentity,
} from "../../shared/portal.ts";
import type { Ticket } from "../../shared/tickets.ts";
import { formatApprovalStatusBanner, type ApprovalCardEvent, type ApprovalEngine } from "../approvals/engine.ts";
import { DATA_DIR } from "../config.ts";
import type { IsolationEngine } from "../isolation/engine.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import type { PatrolEngine } from "../patrol/engine.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { hashPortalToken, PortalAdminOps } from "./admin.ts";
import { PortalStore } from "./store.ts";
import { PortalUnifiedOps } from "./unified.ts";

const QR_CHALLENGE_TTL_MS = 5 * 60_000;
const CUSTOMER_SESSION_TTL_MS = 24 * 60 * 60_000;

export class PortalError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface PortalEngineOptions {
  dbPath?: string;
  tickets: TicketEngine;
  approvals: ApprovalEngine;
  patrol: PatrolEngine;
  memorySkill: MemorySkillEngine;
  isolation: IsolationEngine;
  now?: () => number;
  qrBaseUrl?: string;
  bootstrapAdmin?: { username: string; password: string; displayName?: string };
}

/**
 * Control-plane engine for Customer Web Portal and Admin Console (add-customer-portal).
 * Enforces Feishu QR customer login, server-side tenant & role isolation, 6-page customer
 * audit/self-service operations, dual-channel approval sync, and separate admin console controls.
 */
export class PortalEngine {
  readonly store: PortalStore;
  readonly tickets: TicketEngine;
  readonly approvals: ApprovalEngine;
  readonly patrol: PatrolEngine;
  readonly memorySkill: MemorySkillEngine;
  readonly isolation: IsolationEngine;
  private readonly now: () => number;
  private readonly qrBaseUrl: string;
  private readonly adminOps: PortalAdminOps;
  private readonly unifiedOps: PortalUnifiedOps;
  private readonly feishuSyncListeners = new Set<(event: ApprovalCardEvent) => void>();
  private readonly bindingChangeListeners = new Set<() => void>();
  private readonly unsubscribeApprovals: () => void;

  constructor(options: PortalEngineOptions) {
    this.now = options.now ?? Date.now;
    this.store = new PortalStore(options.dbPath ?? join(DATA_DIR, "portal.sqlite"));
    this.tickets = options.tickets;
    this.approvals = options.approvals;
    this.patrol = options.patrol;
    this.memorySkill = options.memorySkill;
    this.isolation = options.isolation;
    this.qrBaseUrl = options.qrBaseUrl ?? "feishu://openmausbot/qr-login";
    this.adminOps = new PortalAdminOps({
      store: this.store,
      approvals: this.approvals,
      isolation: this.isolation,
      memorySkill: this.memorySkill,
      now: this.now,
      registerTenantMember: (i) => this.registerTenantMember(i),
      recordAudit: (e) => this.recordAudit(e),
      throwError: (s, c, m) => {
        throw new PortalError(s, c, m);
      },
    });
    this.unifiedOps = new PortalUnifiedOps({
      store: this.store,
      approvals: this.approvals,
      isolation: this.isolation,
      now: this.now,
      loginAdminAccount: (u, p) => this.adminOps.loginAdmin(u, p),
      registerTenantMember: (i) => this.registerTenantMember(i),
      recordAudit: (e) => this.recordAudit(e),
      onBindingsChanged: () => {
        for (const listener of this.bindingChangeListeners) {
          try {
            listener();
          } catch {
            // Non-fatal gateway hot-reload listener error.
          }
        }
      },
      throwError: (s, c, m) => {
        throw new PortalError(s, c, m);
      },
    });

    if (options.bootstrapAdmin) {
      this.adminOps.ensureBootstrapAdmin(options.bootstrapAdmin);
    } else {
      const envUser = process.env.OMB_ADMIN_USERNAME?.trim();
      const envPass = process.env.OMB_ADMIN_PASSWORD?.trim();
      if (envUser && envPass) {
        this.adminOps.ensureBootstrapAdmin({ username: envUser, password: envPass, displayName: "控制面管理员" });
      }
    }

    this.unsubscribeApprovals = this.approvals.onCardEvent((event) => {
      for (const listener of this.feishuSyncListeners) {
        try {
          listener(event);
        } catch {
          // Non-fatal sync listener error.
        }
      }
    });
  }

  close(): void {
    this.unsubscribeApprovals();
    this.store.close();
  }

  private recordAudit(entry: Omit<PortalAuditEntry, "id" | "at">): PortalAuditEntry {
    const full: PortalAuditEntry = {
      id: `paud_${randomUUID()}`,
      at: this.now(),
      ...entry,
    };
    this.store.appendAudit(full);
    return full;
  }

  // ===========================================================================
  // 1. Tenant Member Registry & Customer Feishu QR Login (no password)
  // ===========================================================================

  registerTenantMember(input: {
    tenantId: string;
    openId: string;
    displayName?: string;
    role: PortalRole;
  }): TenantMember {
    const member: TenantMember = {
      tenantId: input.tenantId,
      openId: input.openId,
      displayName: input.displayName?.trim() || input.openId,
      role: input.role,
      createdAt: this.now(),
    };
    this.store.upsertTenantMember(member);
    return member;
  }

  resolveMemberByOpenId(openId: string): TenantMember | null {
    const direct = this.store.getMemberByOpenId(openId);
    if (direct) return direct;
    // Auto-resolve from MVP6 IsolationEngine open_id -> tenant_id mapping if present.
    const vm = this.isolation.store.findTenantVmByOpenId(openId);
    if (!vm) return null;
    const isPrimary = vm.openIds[0] === openId;
    const member: TenantMember = {
      tenantId: vm.tenantId,
      openId,
      displayName: openId,
      role: isPrimary ? "admin" : "member",
      createdAt: this.now(),
    };
    this.store.upsertTenantMember(member);
    return member;
  }

  createFeishuQrChallenge(): QrLoginChallenge {
    const now = this.now();
    const qrToken = `qr_${randomBytes(18).toString("hex")}`;
    const qrUrl = `${this.qrBaseUrl}?token=${encodeURIComponent(qrToken)}`;
    const expiresAt = now + QR_CHALLENGE_TTL_MS;
    this.store.insertQrChallenge({
      qrToken,
      qrUrl,
      status: "pending",
      openId: null,
      createdAt: now,
      expiresAt,
      confirmedAt: null,
    });
    return { qrToken, qrUrl, status: "pending", expiresAt, createdAt: now };
  }

  getFeishuQrChallenge(qrToken: string): QrLoginChallenge | null {
    const stored = this.store.getQrChallenge(qrToken);
    if (!stored) return null;
    if (stored.status === "pending" && this.now() > stored.expiresAt) {
      this.store.expireQrChallenge(qrToken);
      return { ...stored, status: "expired" };
    }
    return {
      qrToken: stored.qrToken,
      qrUrl: stored.qrUrl,
      status: stored.status,
      expiresAt: stored.expiresAt,
      createdAt: stored.createdAt,
    };
  }

  /** Confirms a Feishu QR login after Feishu verifies the scanning user's open_id. */
  confirmFeishuQrChallenge(qrToken: string, openId: string): { ok: true; tenantId: string; role: PortalRole } {
    const stored = this.store.getQrChallenge(qrToken);
    if (!stored) {
      throw new PortalError(404, "qr_not_found", "二维码不存在");
    }
    const now = this.now();
    if (now > stored.expiresAt) {
      this.store.expireQrChallenge(qrToken);
      throw new PortalError(410, "qr_expired", "二维码已过期，请刷新重试");
    }
    if (stored.status !== "pending") {
      throw new PortalError(409, "qr_already_used", "二维码已被使用");
    }
    const member = this.resolveMemberByOpenId(openId);
    if (!member) {
      throw new PortalError(403, "open_id_not_bound", "该飞书账号未绑定任何租户，无法登录客户门户");
    }
    const confirmed = this.store.confirmQrChallenge(qrToken, openId, now);
    if (!confirmed) {
      throw new PortalError(409, "qr_already_used", "二维码已被使用");
    }
    return { ok: true, tenantId: member.tenantId, role: member.role };
  }

  /** Exchanges a confirmed Feishu QR challenge for a short-lived control-plane customer session token. */
  exchangeFeishuQrChallenge(qrToken: string): { token: string; session: CustomerSession } {
    const stored = this.store.getQrChallenge(qrToken);
    if (!stored) {
      throw new PortalError(404, "qr_not_found", "二维码不存在");
    }
    const now = this.now();
    if (now > stored.expiresAt) {
      this.store.expireQrChallenge(qrToken);
      throw new PortalError(410, "qr_expired", "二维码已过期");
    }
    if (stored.status !== "confirmed" || !stored.openId) {
      throw new PortalError(409, "qr_not_confirmed", "二维码尚未完成飞书扫码确认");
    }
    const member = this.resolveMemberByOpenId(stored.openId);
    if (!member) {
      throw new PortalError(403, "open_id_not_bound", "该飞书账号未绑定有效租户");
    }
    if (!this.store.consumeQrChallenge(qrToken)) {
      throw new PortalError(409, "qr_already_consumed", "二维码已被兑换");
    }
    const rawToken = `cust_${randomBytes(24).toString("hex")}`;
    const session: CustomerSession = {
      sessionId: `cses_${randomUUID()}`,
      tenantId: member.tenantId,
      openId: member.openId,
      displayName: member.displayName,
      role: member.role,
      createdAt: now,
      expiresAt: now + CUSTOMER_SESSION_TTL_MS,
    };
    this.store.insertCustomerSession(hashPortalToken(rawToken), session);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "customer_qr_login",
      targetType: "session",
      targetId: session.sessionId,
      before: null,
      after: { tenantId: session.tenantId, role: session.role },
      reason: "客户通过飞书扫码登录客户 Web 门户",
    });
    return { token: rawToken, session };
  }

  authenticateCustomer(rawToken: string | null | undefined): CustomerSession | null {
    if (!rawToken) return null;
    const session = this.store.getCustomerSession(hashPortalToken(rawToken));
    if (!session || session.revokedAt !== null) return null;
    if (this.now() > session.expiresAt) return null;
    return {
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      openId: session.openId,
      displayName: session.displayName,
      role: session.role,
      ...(session.userId ? { userId: session.userId } : {}),
      ...(session.username ? { username: session.username } : {}),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  logoutCustomer(rawToken: string): void {
    this.store.revokeCustomerSession(hashPortalToken(rawToken), this.now());
  }

  // ===========================================================================
  // 2. Server-Side Tenant Isolation Helpers
  // ===========================================================================

  private assertTenantScope(session: CustomerSession, requestedTenantId?: string | null, resourceDesc = "resource"): void {
    if (requestedTenantId && requestedTenantId !== session.tenantId) {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: "cross_tenant_denied",
        targetType: resourceDesc,
        targetId: requestedTenantId,
        before: null,
        after: null,
        reason: `跨租户越权访问被服务端拦截: session=${session.tenantId}, requested=${requestedTenantId}`,
      });
      throw new PortalError(403, "cross_tenant_forbidden", "无权查看其他租户数据");
    }
  }

  private assertCustomerAdmin(session: CustomerSession, action: string): void {
    if (session.role !== "admin") {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: "member_privilege_denied",
        targetType: "setting",
        targetId: action,
        before: null,
        after: null,
        reason: `普通成员无权执行管理员操作: ${action}`,
      });
      throw new PortalError(403, "admin_role_required", "仅租户管理员可执行此修改");
    }
  }

  private getTenantOpenIds(tenantId: string): Set<string> {
    const ids = new Set<string>();
    for (const m of this.store.listTenantMembers(tenantId)) {
      ids.add(m.openId);
    }
    const vm = this.isolation.getTenantVm(tenantId);
    if (vm) {
      for (const openId of vm.openIds) ids.add(openId);
    }
    const approvers = this.store.getApprovers(tenantId);
    if (approvers) {
      for (const openId of approvers.approverOpenIds) ids.add(openId);
    }
    return ids;
  }

  private isTicketOwnedByTenant(ticket: Ticket, tenantId: string): boolean {
    const openIds = this.getTenantOpenIds(tenantId);
    if (openIds.has(ticket.initiator)) return true;
    if (ticket.mandate.approver && openIds.has(ticket.mandate.approver)) return true;
    if (ticket.mandate.scope.includes(tenantId)) return true;
    // Also check if any approval card links this ticket to the tenant.
    const cards = this.approvals.listCardsByTenant(tenantId, 500);
    return cards.some((c) => c.ticketId === ticket.id);
  }

  private decorateApproval(card: ApprovalCard, viewerOpenId: string): PortalApprovalView {
    return {
      ...card,
      statusBanner: formatApprovalStatusBanner(card),
      canAct: card.status === "pending" && card.approverOpenId === viewerOpenId,
    };
  }

  // ===========================================================================
  // 3. Customer Web Portal — 6 Pages
  // ===========================================================================

  // Page 1: Bots
  listCustomerBots(session: CustomerSession, requestedTenantId?: string | null): PortalBotSummary[] {
    this.assertTenantScope(session, requestedTenantId, "bots");
    const profiles = this.isolation.store.listBotProfiles(session.tenantId);
    const states = this.store.getBotStates(session.tenantId);
    const tickets = this.listCustomerTickets(session);
    return profiles.map((p) => {
      const state = states.get(p.botId);
      const activeTicketCount = tickets.filter(
        (t) => t.botId === p.botId && (t.status === "ready" || t.status === "executing"),
      ).length;
      return {
        tenantId: p.tenantId,
        botId: p.botId,
        role: p.role,
        enabled: state ? state.enabled : true,
        toolAllowlist: p.toolAllowlist,
        allowedConnectors: p.allowedConnectors,
        activeTicketCount,
        updatedAt: state ? state.updatedAt : p.createdAt,
      };
    });
  }

  isBotEnabled(tenantId: string, botId: string): boolean {
    const state = this.store.getBotStates(tenantId).get(botId);
    return state ? state.enabled : true;
  }

  setCustomerBotEnabled(session: CustomerSession, botId: string, enabled: boolean, requestedTenantId?: string | null): PortalBotSummary {
    this.assertTenantScope(session, requestedTenantId, "bot");
    const profile = this.isolation.store.getBotProfile(session.tenantId, botId);
    if (!profile) {
      throw new PortalError(404, "bot_not_found", "未找到该租户下的 Bot");
    }
    const prevEnabled = this.isBotEnabled(session.tenantId, botId);
    const now = this.now();
    this.store.setBotState(session.tenantId, botId, enabled, now, session.openId);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: enabled ? "bot_enabled" : "bot_disabled",
      targetType: "bot",
      targetId: botId,
      before: { enabled: prevEnabled },
      after: { enabled },
      reason: enabled ? "客户开启 Bot 接单" : "客户关闭 Bot（不再接新任务，正在运行的 Ticket 不受影响）",
    });
    return this.listCustomerBots(session).find((b) => b.botId === botId)!;
  }

  // Page 2: Tickets & Approvals (Dual-Channel)
  listCustomerTickets(session: CustomerSession, requestedTenantId?: string | null, limit = 100): Ticket[] {
    this.assertTenantScope(session, requestedTenantId, "tickets");
    const all = this.tickets.listTickets(500);
    return all.filter((t) => this.isTicketOwnedByTenant(t, session.tenantId)).slice(0, limit);
  }

  getCustomerTicket(session: CustomerSession, ticketId: string): Ticket {
    const ticket = this.tickets.getTicket(ticketId);
    if (!ticket) {
      throw new PortalError(404, "ticket_not_found", "工单不存在");
    }
    if (!this.isTicketOwnedByTenant(ticket, session.tenantId)) {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: "cross_tenant_denied",
        targetType: "ticket",
        targetId: ticketId,
        before: null,
        after: null,
        reason: `跨租户访问工单被拒绝: ticket=${ticketId}`,
      });
      throw new PortalError(403, "cross_tenant_forbidden", "无权查看其他租户的工单");
    }
    return ticket;
  }

  listCustomerApprovals(session: CustomerSession, requestedTenantId?: string | null, limit = 100): PortalApprovalView[] {
    this.assertTenantScope(session, requestedTenantId, "approvals");
    return this.approvals
      .listCardsByTenant(session.tenantId, limit)
      .map((card) => this.decorateApproval(card, session.openId));
  }

  getCustomerApproval(session: CustomerSession, cardId: string): PortalApprovalView {
    const card = this.approvals.getCard(cardId);
    if (!card) {
      throw new PortalError(404, "card_not_found", "审批记录不存在");
    }
    if (card.tenantId !== session.tenantId) {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: "cross_tenant_denied",
        targetType: "approval_card",
        targetId: cardId,
        before: null,
        after: null,
        reason: `跨租户访问审批卡片被拒绝: card=${cardId}`,
      });
      throw new PortalError(403, "cross_tenant_forbidden", "无权查看其他租户的审批记录");
    }
    return this.decorateApproval(card, session.openId);
  }

  /** Dual-channel Web approval decision: validates tenant & designated approver, delegates to atomic MVP2b store. */
  decideApprovalFromWeb(
    session: CustomerSession,
    cardId: string,
    action: ApprovalButtonAction,
  ): { result: FeishuCardCallbackResult; card: PortalApprovalView } {
    const existing = this.approvals.getCard(cardId);
    if (!existing) {
      throw new PortalError(404, "card_not_found", "审批卡片不存在");
    }
    if (existing.tenantId !== session.tenantId) {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: "cross_tenant_denied",
        targetType: "approval_card",
        targetId: cardId,
        before: null,
        after: null,
        reason: `跨租户操作审批卡片被拒绝: card=${cardId}`,
      });
      throw new PortalError(403, "cross_tenant_forbidden", "无权操作其他租户的审批");
    }
    const result = this.approvals.handleCardCallback({
      cardId,
      operatorOpenId: session.openId,
      action,
      channel: "web",
    });
    if (!result.ok) {
      const status = result.outcome === "card_expired" ? 410 : result.outcome === "card_not_found" ? 404 : 403;
      throw new PortalError(status, result.outcome, result.reason);
    }
    const latest = this.approvals.getCard(cardId)!;
    if (!result.idempotent) {
      this.recordAudit({
        tenantId: session.tenantId,
        actorId: session.openId,
        actorRole: session.role,
        channel: "web",
        action: `approval_${result.outcome}`,
        targetType: "approval_card",
        targetId: cardId,
        before: { status: "pending" },
        after: { status: latest.status, decidedBy: latest.decidedBy, decisionChannel: latest.decisionChannel },
        reason: formatApprovalStatusBanner(latest) ?? "网页审批已处理",
      });
    }
    return { result, card: this.decorateApproval(latest, session.openId) };
  }

  onApprovalCardEvent(listener: (event: ApprovalCardEvent) => void): () => void {
    this.feishuSyncListeners.add(listener);
    return () => {
      this.feishuSyncListeners.delete(listener);
    };
  }

  // Page 3: Spend & Budget
  getCustomerSpend(session: CustomerSession, requestedTenantId?: string | null): PortalSpendOverview {
    this.assertTenantScope(session, requestedTenantId, "spend");
    const policy = this.approvals.getBudgetPolicy(session.tenantId);
    const totals = this.approvals.getSpendTotals(session.tenantId);
    const patrolSpend = this.patrol.getSpendSummary(session.tenantId);
    return {
      tenantId: session.tenantId,
      currency: policy.currency,
      policy,
      tokenSpend: {
        day: totals.tokenDay,
        month: totals.tokenMonth,
        patrolTokens: patrolSpend.monthSmallTokens + patrolSpend.monthLargeTokens,
        patrolCostUsd: patrolSpend.monthCostUsd,
      },
      businessSpend: {
        day: totals.businessDay,
        month: totals.businessMonth,
      },
    };
  }

  updateCustomerBudget(session: CustomerSession, patch: Partial<DualBudgetPolicy>, requestedTenantId?: string | null): DualBudgetPolicy {
    this.assertTenantScope(session, requestedTenantId, "budget");
    this.assertCustomerAdmin(session, "update_budget_policy");
    const before = this.approvals.getBudgetPolicy(session.tenantId);
    const next: DualBudgetPolicy = {
      tokenPerTx: patch.tokenPerTx ?? before.tokenPerTx,
      tokenDaily: patch.tokenDaily ?? before.tokenDaily,
      tokenMonthly: patch.tokenMonthly ?? before.tokenMonthly,
      businessPerTx: patch.businessPerTx ?? before.businessPerTx,
      businessDaily: patch.businessDaily ?? before.businessDaily,
      businessMonthly: patch.businessMonthly ?? before.businessMonthly,
      currency: patch.currency ?? before.currency,
    };
    this.approvals.setBudgetPolicy(session.tenantId, next);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "budget_policy_updated",
      targetType: "budget_policy",
      targetId: session.tenantId,
      before: { ...before },
      after: { ...next },
      reason: "管理员更新双口径预算上限",
    });
    return next;
  }

  // Page 4: Scheduled Tasks & Patrol Config
  getCustomerSchedule(session: CustomerSession, requestedTenantId?: string | null): TenantScheduleConfig {
    this.assertTenantScope(session, requestedTenantId, "schedule");
    const existing = this.store.getSchedule(session.tenantId);
    if (existing) return existing;
    return {
      tenantId: session.tenantId,
      patrolFrequencyPerDay: 2,
      dailyDigestTime: "09:00",
      patrolEnabled: true,
      digestEnabled: true,
      updatedAt: 0,
      updatedBy: "system",
      effectiveNote: "默认配置：每天巡检 2 次，09:00 发送日报",
    };
  }

  updateCustomerSchedule(
    session: CustomerSession,
    patch: {
      patrolFrequencyPerDay?: number;
      dailyDigestTime?: string;
      patrolEnabled?: boolean;
      digestEnabled?: boolean;
    },
    requestedTenantId?: string | null,
  ): TenantScheduleConfig {
    this.assertTenantScope(session, requestedTenantId, "schedule");
    const before = this.getCustomerSchedule(session);
    const next: Omit<TenantScheduleConfig, "effectiveNote"> = {
      tenantId: session.tenantId,
      patrolFrequencyPerDay: patch.patrolFrequencyPerDay ?? before.patrolFrequencyPerDay,
      dailyDigestTime: patch.dailyDigestTime ?? before.dailyDigestTime,
      patrolEnabled: patch.patrolEnabled ?? before.patrolEnabled,
      digestEnabled: patch.digestEnabled ?? before.digestEnabled,
      updatedAt: this.now(),
      updatedBy: session.openId,
    };
    this.store.upsertSchedule(next);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "schedule_updated",
      targetType: "schedule",
      targetId: session.tenantId,
      before: {
        patrolFrequencyPerDay: before.patrolFrequencyPerDay,
        dailyDigestTime: before.dailyDigestTime,
        patrolEnabled: before.patrolEnabled,
        digestEnabled: before.digestEnabled,
      },
      after: {
        patrolFrequencyPerDay: next.patrolFrequencyPerDay,
        dailyDigestTime: next.dailyDigestTime,
        patrolEnabled: next.patrolEnabled,
        digestEnabled: next.digestEnabled,
      },
      reason: "客户更新巡检频率与定时任务配置（控制面已保存，下次执行生效）",
    });
    return {
      ...next,
      effectiveNote: "已生效，下次巡检与日报将按新配置执行",
    };
  }

  // Page 5: Memory & Skills (Read-only + Core Skill 403 Guard)
  getCustomerMemoryAndSkills(session: CustomerSession, requestedTenantId?: string | null): PortalMemorySkillView {
    this.assertTenantScope(session, requestedTenantId, "memory_skill");
    const memories = this.memorySkill.store.listLongTerm(session.tenantId, "__portal__");
    const skills = this.memorySkill.listSkills(session.tenantId).map((s) => ({
      ...s,
      coreLocked: s.isCore,
      editableByCustomer: false,
    }));
    const suggestions = this.store.listMemorySuggestions(session.tenantId);
    return {
      tenantId: session.tenantId,
      memories,
      skills,
      suggestions,
    };
  }

  submitCustomerMemorySuggestion(
    session: CustomerSession,
    input: { memoryId: string; suggestedContent: string; reason: string },
  ): MemoryChangeSuggestion {
    const suggestion: MemoryChangeSuggestion = {
      id: `msug_${randomUUID()}`,
      tenantId: session.tenantId,
      memoryId: input.memoryId,
      suggestedContent: input.suggestedContent,
      reason: input.reason,
      submittedBy: session.openId,
      status: "pending",
      createdAt: this.now(),
    };
    this.store.insertMemorySuggestion(suggestion);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "memory_suggestion_submitted",
      targetType: "memory",
      targetId: input.memoryId,
      before: null,
      after: { suggestedContent: input.suggestedContent },
      reason: input.reason,
    });
    return suggestion;
  }

  /** Customer attempts to mutate a skill directly via API -> always 403 for core skills (and records lock denial). */
  attemptCustomerSkillMutation(
    session: CustomerSession,
    skillId: string,
    patch: { name?: string; description?: string; spec?: Partial<SkillSpec> },
  ): never {
    const skill = this.memorySkill.store.getSkill(session.tenantId, skillId);
    if (skill?.isCore) {
      // Trigger MVP5 core-skill lock denial audit by routing through agent-level lock check.
      this.memorySkill.updateSkill({
        tenantId: session.tenantId,
        skillId,
        ...patch,
        actor: `customer:${session.openId}`,
        actorType: "agent",
        reason: "customer_web_direct_mutation_blocked",
      });
    }
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "core_skill_mutation_denied",
      targetType: "skill",
      targetId: skillId,
      before: skill ? { contentHash: skill.contentHash, isCore: skill.isCore } : null,
      after: null,
      reason: "客户 Web 门户禁止修改核心技能，服务端强制拦截 (403)",
    });
    throw new PortalError(403, "core_skill_locked", "核心技能已锁定，客户无权修改，请由控制面管理员走审批流程变更");
  }

  // Page 6: Settings (Approvers + Audit + Self-Export)
  getCustomerSettings(session: CustomerSession, requestedTenantId?: string | null): TenantPortalSettings {
    this.assertTenantScope(session, requestedTenantId, "settings");
    const saved = this.store.getApprovers(session.tenantId);
    const members = this.store.listTenantMembers(session.tenantId);
    const defaultApprovers = members.filter((m) => m.role === "admin").map((m) => m.openId);
    return {
      tenantId: session.tenantId,
      approverOpenIds: saved ? saved.approverOpenIds : defaultApprovers,
      budgetPolicy: this.approvals.getBudgetPolicy(session.tenantId),
      members,
      updatedAt: saved?.updatedAt ?? 0,
    };
  }

  updateCustomerApprovers(
    session: CustomerSession,
    approverOpenIds: string[],
    requestedTenantId?: string | null,
  ): TenantPortalSettings {
    this.assertTenantScope(session, requestedTenantId, "approvers");
    this.assertCustomerAdmin(session, "update_approvers");
    const before = this.getCustomerSettings(session);
    const cleaned = [...new Set(approverOpenIds.map((id) => id.trim()).filter(Boolean))];
    const now = this.now();
    this.store.setApprovers(session.tenantId, cleaned, now, session.openId);
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "approvers_updated",
      targetType: "approvers",
      targetId: session.tenantId,
      before: { approverOpenIds: before.approverOpenIds },
      after: { approverOpenIds: cleaned },
      reason: "管理员更新审批人名单",
    });
    return this.getCustomerSettings(session);
  }

  listCustomerAudit(session: CustomerSession, requestedTenantId?: string | null, limit = 100): PortalAuditEntry[] {
    this.assertTenantScope(session, requestedTenantId, "audit");
    return this.store.listAudit(session.tenantId, limit);
  }

  exportCustomerData(session: CustomerSession, requestedTenantId?: string | null): CustomerSelfExport {
    this.assertTenantScope(session, requestedTenantId, "export");
    const exportedAt = this.now();
    const memorySkill = this.getCustomerMemoryAndSkills(session);
    const bundle: CustomerSelfExport = {
      exportId: `cexp_${randomUUID()}`,
      tenantId: session.tenantId,
      exportedAt,
      exportedBy: session.openId,
      bots: this.listCustomerBots(session),
      tickets: this.listCustomerTickets(session),
      approvals: this.listCustomerApprovals(session),
      spend: this.getCustomerSpend(session),
      schedule: this.getCustomerSchedule(session),
      memories: memorySkill.memories,
      skills: memorySkill.skills,
      audit: this.listCustomerAudit(session, undefined, 500),
    };
    this.recordAudit({
      tenantId: session.tenantId,
      actorId: session.openId,
      actorRole: session.role,
      channel: "web",
      action: "customer_data_exported",
      targetType: "export",
      targetId: bundle.exportId,
      before: null,
      after: { tenantId: session.tenantId },
      reason: "客户导出本租户数据",
    });
    return bundle;
  }

  // ===========================================================================
  // 4. Admin Console (Separate Account System, Cross-Tenant, Safeguards)
  // ===========================================================================

  createAdminAccount(
    actor: AdminSession | "bootstrap",
    input: { username: string; password: string; displayName?: string },
  ): AdminAccount {
    return this.adminOps.createAdminAccount(actor, input);
  }

  loginAdmin(username: string, password: string): { token: string; session: AdminSession } {
    return this.adminOps.loginAdmin(username, password);
  }

  authenticateAdmin(rawToken: string | null | undefined): AdminSession | null {
    return this.adminOps.authenticateAdmin(rawToken);
  }

  logoutAdmin(rawToken: string): void {
    this.adminOps.logoutAdmin(rawToken);
  }

  revokeAdminAccount(actor: AdminSession, targetAdminId: string): { ok: true } {
    return this.adminOps.revokeAdminAccount(actor, targetAdminId);
  }

  listAdminAccounts(): AdminAccount[] {
    return this.store.listAdminAccounts();
  }

  listAllTenantsOverview(): AdminTenantOverview[] {
    return this.adminOps.listAllTenantsOverview();
  }

  provisionTenantAsAdmin(
    actor: AdminSession,
    input: { tenantId: string; openIds: string[]; hostNodeId?: string; quota?: Partial<VmQuota> },
  ) {
    return this.adminOps.provisionTenant(actor, input);
  }

  offboardTenantAsAdmin(actor: AdminSession, tenantId: string, confirm: boolean): AdminOffboardResult {
    return this.adminOps.offboardTenant(actor, tenantId, confirm);
  }

  directMutateCoreSkillForbidden(actor: AdminSession, tenantId: string, skillId: string): never {
    return this.adminOps.directMutateCoreSkillForbidden(actor, tenantId, skillId);
  }

  requestCoreSkillHashChange(
    actor: AdminSession,
    input: {
      tenantId: string;
      skillId: string;
      patch: CoreSkillHashChangeRequest["patch"];
      reason: string;
    },
  ): CoreSkillHashChangeRequest {
    return this.adminOps.requestCoreSkillHashChange(actor, input);
  }

  approveCoreSkillHashChange(
    actor: AdminSession,
    requestId: string,
    confirm: boolean,
  ): { request: CoreSkillHashChangeRequest; newHash: string } {
    return this.adminOps.approveCoreSkillHashChange(actor, requestId, confirm);
  }

  listCoreSkillChangeRequests(tenantId?: string): CoreSkillHashChangeRequest[] {
    return this.store.listCoreSkillChangeRequests(tenantId);
  }

  listAllAudit(tenantId?: string, limit = 200): PortalAuditEntry[] {
    return this.store.listAudit(tenantId, limit);
  }

  listAllApprovals(tenantId?: string, limit = 200): PortalApprovalView[] {
    return this.adminOps.listAllApprovals(tenantId, limit);
  }

  // ===========================================================================
  // 8. Unified Login, Admin-Managed Users, Identity & Channel Bindings
  // ===========================================================================

  onChannelBindingsChanged(listener: () => void): () => void {
    this.bindingChangeListeners.add(listener);
    return () => { this.bindingChangeListeners.delete(listener); };
  }
  loginUnified(username: string, password: string): UnifiedLoginResult { return this.unifiedOps.loginUnified(username, password); }
  createPortalUserAsAdmin(actor: AdminSession, input: Parameters<PortalUnifiedOps["createUserAsAdmin"]>[1]) { return this.unifiedOps.createUserAsAdmin(actor, input); }
  listPortalUsers(): PortalUserAccount[] { return this.store.listPortalUsers(); }
  changePortalUserPasswordAsAdmin(actor: AdminSession, userId: string, newPassword: string): { ok: true } { return this.unifiedOps.changeUserPasswordAsAdmin(actor, userId, newPassword); }
  disablePortalUserAsAdmin(actor: AdminSession, userId: string): { ok: true } { return this.unifiedOps.disableUserAsAdmin(actor, userId); }
  bindFeishuIdentity(session: CustomerSession, feishuOpenId: string): UserIdentity { return this.unifiedOps.bindFeishuIdentity(session, feishuOpenId); }
  listFeishuIdentities(session: CustomerSession, requestedTenantId?: string | null): UserIdentity[] { this.assertTenantScope(session, requestedTenantId, "user_identity"); return this.store.listFeishuIdentities(session.tenantId); }
  bindWeixinIdentity(session: CustomerSession, input: { weixinOpenId: string; ilinkAccountId: string }): WeixinIdentity { return this.unifiedOps.bindWeixinIdentity(session, input); }
  listWeixinIdentities(session: CustomerSession, requestedTenantId?: string | null): WeixinIdentity[] { this.assertTenantScope(session, requestedTenantId, "weixin_identity"); return this.store.listWeixinIdentities(session.tenantId); }
  createChannelBinding(session: CustomerSession, input: Parameters<PortalUnifiedOps["createChannelBinding"]>[1]): { binding: ChannelBinding; disabledDuplicateBindingIds: string[] } { return this.unifiedOps.createChannelBinding(session, input); }
  unbindChannelBinding(session: CustomerSession, bindingId: string): ChannelBinding { return this.unifiedOps.unbindChannelBinding(session, bindingId); }
  listChannelBindings(session: CustomerSession, options?: { botId?: string; requestedTenantId?: string | null }): ChannelBinding[] { this.assertTenantScope(session, options?.requestedTenantId, "channel_binding"); return this.store.listChannelBindings({ tenantId: session.tenantId, botId: options?.botId }); }
  getTenantChannelAllowlist(session: CustomerSession, platform: ChannelPlatform, requestedTenantId?: string | null): TenantChannelAllowlist { this.assertTenantScope(session, requestedTenantId, "channel_allowlist"); return this.unifiedOps.getTenantAllowlist(session.tenantId, platform); }
  setTenantChannelAllowlist(session: CustomerSession, platform: ChannelPlatform, allowedSenderIds: string[], requestedTenantId?: string | null): TenantChannelAllowlist { this.assertTenantScope(session, requestedTenantId, "channel_allowlist"); this.assertCustomerAdmin(session, "set_channel_allowlist"); return this.unifiedOps.setTenantAllowlist(session, platform, allowedSenderIds); }
}
