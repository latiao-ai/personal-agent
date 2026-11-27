import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import type { VmQuota } from "../../shared/isolation.ts";
import type { AdminLlmProviderView, LlmPricing, TenantLlmUsage } from "../../shared/llm-proxy.ts";
import type {
  AdminAccount,
  AdminOffboardResult,
  AdminSession,
  AdminTenantOverview,
  CoreSkillHashChangeRequest,
  PortalApprovalView,
  PortalAuditEntry,
  PortalRole,
} from "../../shared/portal.ts";
import { formatApprovalStatusBanner, type ApprovalEngine } from "../approvals/engine.ts";
import type { IsolationEngine } from "../isolation/engine.ts";
import type { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";
import type { LlmProxyStore } from "../llm-proxy/store.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import type { PortalStore } from "./store.ts";

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60_000;

export function hashPortalToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function hashPortalPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function verifyPortalPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPortalPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface AdminOpsDeps {
  store: PortalStore;
  approvals: ApprovalEngine;
  isolation: IsolationEngine;
  memorySkill: MemorySkillEngine;
  llmProxy: ControlPlaneLlmProxy;
  llmStore: LlmProxyStore;
  now: () => number;
  registerTenantMember: (input: { tenantId: string; openId: string; displayName?: string; role: PortalRole }) => unknown;
  recordAudit: (entry: Omit<PortalAuditEntry, "id" | "at">) => PortalAuditEntry;
  throwError: (status: number, code: string, message: string) => never;
}

/** Control-plane cross-tenant admin operations: tenant overview, provision, offboard, and core-skill hash approvals. */
export class PortalAdminOps {
  private readonly deps: AdminOpsDeps;

  constructor(deps: AdminOpsDeps) {
    this.deps = deps;
  }

  ensureBootstrapAdmin(input: { username: string; password: string; displayName?: string }): void {
    if (this.deps.store.getAdminByUsername(input.username)) return;
    this.createAdminAccountInternal(input.username, input.password, input.displayName ?? input.username);
  }

  private createAdminAccountInternal(username: string, password: string, displayName: string): AdminAccount {
    const salt = randomBytes(16).toString("hex");
    const account = {
      id: `adm_${randomUUID()}`,
      username,
      displayName,
      passwordHash: hashPortalPassword(password, salt),
      salt,
      createdAt: this.deps.now(),
      revokedAt: null,
    };
    this.deps.store.insertAdminAccount(account);
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAt: account.createdAt,
      revokedAt: account.revokedAt,
    };
  }

  createAdminAccount(
    actor: AdminSession | "bootstrap",
    input: { username: string; password: string; displayName?: string },
  ): AdminAccount {
    if (this.deps.store.getAdminByUsername(input.username)) {
      this.deps.throwError(409, "admin_exists", "管理员账号已存在");
    }
    const created = this.createAdminAccountInternal(
      input.username,
      input.password,
      input.displayName?.trim() || input.username,
    );
    if (actor !== "bootstrap") {
      this.deps.recordAudit({
        tenantId: "_control_plane",
        actorId: actor.username,
        actorRole: "ops_admin",
        channel: "admin",
        action: "admin_account_created",
        targetType: "admin_account",
        targetId: created.id,
        before: null,
        after: { username: created.username },
        reason: "创建控制面管理员账号",
      });
    }
    return created;
  }

  loginAdmin(username: string, password: string): { token: string; session: AdminSession } {
    const account = this.deps.store.getAdminByUsername(username);
    if (!account || account.revokedAt !== null || !verifyPortalPassword(password, account.salt, account.passwordHash)) {
      this.deps.throwError(401, "invalid_admin_credentials", "管理员账号不存在、已吊销或密码错误");
    }
    const now = this.deps.now();
    const rawToken = `adm_tok_${randomBytes(24).toString("hex")}`;
    const session: AdminSession = {
      sessionId: `ases_${randomUUID()}`,
      adminId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAt: now,
      expiresAt: now + ADMIN_SESSION_TTL_MS,
    };
    this.deps.store.insertAdminSession(hashPortalToken(rawToken), session);
    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: account.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "admin_login",
      targetType: "admin_session",
      targetId: session.sessionId,
      before: null,
      after: { username: account.username },
      reason: "管理员登录控制面管理后台",
    });
    return { token: rawToken, session };
  }

  authenticateAdmin(rawToken: string | null | undefined): AdminSession | null {
    if (!rawToken) return null;
    const session = this.deps.store.getAdminSession(hashPortalToken(rawToken));
    if (!session || session.revokedAt !== null || this.deps.now() > session.expiresAt) return null;
    const account = this.deps.store.getAdminById(session.adminId);
    if (!account || account.revokedAt !== null) return null;
    return {
      sessionId: session.sessionId,
      adminId: session.adminId,
      username: session.username,
      displayName: session.displayName,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  logoutAdmin(rawToken: string): void {
    this.deps.store.revokeAdminSession(hashPortalToken(rawToken), this.deps.now());
  }

  revokeAdminAccount(actor: AdminSession, targetAdminId: string): { ok: true } {
    const target = this.deps.store.getAdminById(targetAdminId);
    if (!target) {
      this.deps.throwError(404, "admin_not_found", "管理员账号不存在");
    }
    this.deps.store.revokeAdminAccount(targetAdminId, this.deps.now());
    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "admin_account_revoked",
      targetType: "admin_account",
      targetId: targetAdminId,
      before: { revokedAt: null },
      after: { revokedAt: this.deps.now() },
      reason: `吊销管理员账号 ${target.username}`,
    });
    return { ok: true };
  }

  listAllTenantsOverview(): AdminTenantOverview[] {
    const vms = this.deps.isolation.store.listTenantVms();
    const tenantIds = new Set<string>(vms.map((v) => v.tenantId));
    for (const card of this.deps.approvals.listCards(500)) {
      tenantIds.add(card.tenantId);
    }

    const result: AdminTenantOverview[] = [];
    for (const tenantId of tenantIds) {
      const vm = this.deps.isolation.getTenantVm(tenantId);
      const bots = this.deps.isolation.store.listBotProfiles(tenantId);
      const members = this.deps.store.listTenantMembers(tenantId);
      const cards = this.deps.approvals.listCardsByTenant(tenantId, 200);
      const policy = this.deps.approvals.getBudgetPolicy(tenantId);
      const totals = this.deps.approvals.getSpendTotals(tenantId);
      // Vault exposes only connection names/status, NEVER raw secret values.
      const vaultNames = this.deps.approvals.vault.listSecretNames(tenantId);
      const audits = this.deps.store.listAudit(tenantId, 500);
      result.push({
        tenantId,
        vm,
        botCount: bots.length,
        memberCount: members.length,
        pendingApprovalCount: cards.filter((c) => c.status === "pending").length,
        tokenSpendMonth: totals.tokenMonth,
        businessSpendMonth: totals.businessMonth,
        currency: policy.currency,
        vaultConnections: vaultNames.map((name) => ({ name, status: "connected" })),
        auditCount: audits.length,
      });
    }
    return result;
  }

  provisionTenant(
    actor: AdminSession,
    input: { tenantId: string; openIds: string[]; hostNodeId?: string; quota?: Partial<VmQuota> },
  ) {
    const provisioned = this.deps.isolation.provisionTenant(input);
    input.openIds.forEach((openId, idx) => {
      this.deps.registerTenantMember({
        tenantId: input.tenantId,
        openId,
        displayName: openId,
        role: idx === 0 ? "admin" : "member",
      });
    });
    this.deps.recordAudit({
      tenantId: input.tenantId,
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "tenant_provisioned",
      targetType: "tenant",
      targetId: input.tenantId,
      before: null,
      after: { vmId: provisioned.vm.vmId, openIds: input.openIds },
      reason: "管理员按 MVP6 流程开通租户与 microVM",
    });
    return provisioned;
  }

  offboardTenant(actor: AdminSession, tenantId: string, confirm: boolean): AdminOffboardResult {
    if (!confirm) {
      this.deps.throwError(400, "confirmation_required", "销户操作必须二次确认 (confirm: true)");
    }
    const { exportBundle, deletionReceipt } = this.deps.isolation.offboardTenant(tenantId);
    this.deps.store.deleteTenantData(tenantId);
    this.deps.recordAudit({
      tenantId,
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "tenant_offboarded",
      targetType: "tenant",
      targetId: tenantId,
      before: { vmId: deletionReceipt.deletedVmId },
      after: {
        exportId: exportBundle.exportId,
        exportSha256: exportBundle.sha256,
        receiptId: deletionReceipt.receiptId,
        deletedAt: deletionReceipt.deletedAt,
      },
      reason: "管理员执行租户销户：已先导出单租户数据再彻底删除",
    });
    return { tenantId, exportBundle, deletionReceipt };
  }

  directMutateCoreSkillForbidden(actor: AdminSession, tenantId: string, skillId: string): never {
    this.deps.recordAudit({
      tenantId,
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "core_skill_direct_mutation_denied",
      targetType: "skill",
      targetId: skillId,
      before: null,
      after: null,
      reason: "未走审批直接修改核心技能哈希被服务端拒绝 (403)",
    });
    this.deps.throwError(403, "approval_required_for_core_skill", "修改核心技能哈希必须先提交审批申请并经二次确认批准");
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
    const skill = this.deps.memorySkill.store.getSkill(input.tenantId, input.skillId);
    if (!skill) {
      this.deps.throwError(404, "skill_not_found", "未找到目标技能");
    }
    if (!skill.isCore) {
      this.deps.throwError(400, "not_core_skill", "目标技能不是核心技能");
    }
    const req: CoreSkillHashChangeRequest = {
      id: `csreq_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: skill.id,
      skillName: skill.name,
      requestedBy: actor.username,
      approvedBy: null,
      status: "pending",
      patch: input.patch,
      previousHash: skill.contentHash,
      newHash: null,
      reason: input.reason,
      createdAt: this.deps.now(),
      decidedAt: null,
    };
    this.deps.store.insertCoreSkillChangeRequest(req);
    this.deps.recordAudit({
      tenantId: input.tenantId,
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "core_skill_change_requested",
      targetType: "skill",
      targetId: skill.id,
      before: { contentHash: skill.contentHash },
      after: { requestId: req.id, status: "pending" },
      reason: input.reason,
    });
    return req;
  }

  approveCoreSkillHashChange(
    actor: AdminSession,
    requestId: string,
    confirm: boolean,
  ): { request: CoreSkillHashChangeRequest; newHash: string } {
    if (!confirm) {
      this.deps.throwError(400, "confirmation_required", "批准核心技能哈希变更必须二次确认 (confirm: true)");
    }
    const req = this.deps.store.getCoreSkillChangeRequest(requestId);
    if (!req) {
      this.deps.throwError(404, "request_not_found", "未找到核心技能变更审批单");
    }
    if (req.status !== "pending") {
      this.deps.throwError(409, "request_already_decided", "该核心技能变更审批单已处理");
    }
    const updated = this.deps.memorySkill.updateSkill({
      tenantId: req.tenantId,
      skillId: req.skillId,
      name: req.patch.name,
      description: req.patch.description,
      triggerPhrases: req.patch.triggerPhrases,
      spec: req.patch.spec,
      actor: `admin:${actor.username}`,
      actorType: "human",
      reason: `经管理后台审批单 ${req.id} 批准：${req.reason}`,
    });
    if (!updated.ok) {
      this.deps.throwError(400, updated.error, "更新核心技能失败");
    }
    const decidedAt = this.deps.now();
    this.deps.store.updateCoreSkillChangeRequest(req.id, "applied", actor.username, updated.skill.contentHash, decidedAt);
    this.deps.recordAudit({
      tenantId: req.tenantId,
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "core_skill_hash_updated",
      targetType: "skill",
      targetId: req.skillId,
      before: { contentHash: req.previousHash },
      after: { contentHash: updated.skill.contentHash, requestId: req.id },
      reason: `审批通过并更新核心技能哈希: ${req.reason}`,
    });
    return {
      request: this.deps.store.getCoreSkillChangeRequest(req.id)!,
      newHash: updated.skill.contentHash,
    };
  }

  listAllApprovals(tenantId?: string, limit = 200): PortalApprovalView[] {
    const cards = tenantId ? this.deps.approvals.listCardsByTenant(tenantId, limit) : this.deps.approvals.listCards(limit);
    return cards.map((c) => ({
      ...c,
      statusBanner: formatApprovalStatusBanner(c),
      canAct: false,
    }));
  }

  // --- LLM Provider, Pricing & Tenant Quota Management ---

  private toAdminLlmProviderView(row: {
    id: string;
    name: string;
    baseUrl: string;
    defaultModel: string;
    fastModel: string;
    enabled: boolean;
    priority: number;
    updatedBy: string;
    updatedAt: number;
  }): AdminLlmProviderView {
    const mask = this.deps.llmProxy.getApiKeyMask(row.id);
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      defaultModel: row.defaultModel,
      fastModel: row.fastModel,
      enabled: row.enabled,
      priority: row.priority,
      apiKeyConfigured: mask.apiKeyConfigured,
      apiKeyLast4: mask.apiKeyLast4,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  listLlmProviders(_actor: AdminSession): AdminLlmProviderView[] {
    return this.deps.llmStore.listProviders().map((row) => this.toAdminLlmProviderView(row));
  }

  saveLlmProvider(
    actor: AdminSession,
    input: {
      id?: string;
      name: string;
      baseUrl: string;
      apiKey?: string;
      defaultModel: string;
      fastModel?: string;
      enabled?: boolean;
      priority?: number;
    },
  ): AdminLlmProviderView {
    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const defaultModel = input.defaultModel.trim();
    if (!name) {
      this.deps.throwError(400, "missing_provider_name", "供应商名称必填");
    }
    if (!baseUrl.startsWith("https://")) {
      this.deps.throwError(400, "invalid_base_url", "中转站地址必须以 https:// 开头");
    }
    if (!defaultModel) {
      this.deps.throwError(400, "missing_default_model", "默认模型必填");
    }

    const id = input.id?.trim() || `prov_${randomUUID()}`;
    const existing = this.deps.llmStore.getProvider(id);
    const fastModel = input.fastModel?.trim() || defaultModel;
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const priority = input.priority ?? existing?.priority ?? 1;
    const apiKey = input.apiKey?.trim() || undefined;
    const updatedAt = this.deps.now();

    const saved = this.deps.llmStore.upsertProvider({
      id,
      name,
      baseUrl,
      defaultModel,
      fastModel,
      enabled,
      priority,
      updatedBy: actor.username,
      updatedAt,
    });
    this.deps.llmProxy.updateProvider({
      id: saved.id,
      name: saved.name,
      baseUrl: saved.baseUrl,
      apiKey,
      defaultModel: saved.defaultModel,
      fastModel: saved.fastModel,
      enabled: saved.enabled,
      priority: saved.priority,
    });

    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "llm_provider_saved",
      targetType: "llm_provider",
      targetId: saved.id,
      before: existing
        ? {
            name: existing.name,
            baseUrl: existing.baseUrl,
            defaultModel: existing.defaultModel,
            fastModel: existing.fastModel,
            enabled: existing.enabled,
            priority: existing.priority,
          }
        : null,
      after: {
        name: saved.name,
        baseUrl: saved.baseUrl,
        defaultModel: saved.defaultModel,
        fastModel: saved.fastModel,
        enabled: saved.enabled,
        priority: saved.priority,
        apiKeyUpdated: Boolean(apiKey),
      },
      reason: existing ? "管理员更新模型供应商配置" : "管理员新建模型供应商配置",
    });

    return this.toAdminLlmProviderView(saved);
  }

  rotateLlmApiKey(
    actor: AdminSession,
    providerId: string,
    newApiKey: string,
    confirm: boolean,
  ): AdminLlmProviderView {
    if (!confirm) {
      this.deps.throwError(400, "confirmation_required", "轮换 API Key 必须二次确认 (confirm: true)");
    }
    const trimmedKey = newApiKey.trim();
    if (!trimmedKey) {
      this.deps.throwError(400, "missing_api_key", "新 API Key 不能为空");
    }
    const existing = this.deps.llmStore.getProvider(providerId);
    if (!existing) {
      this.deps.throwError(404, "provider_not_found", "未找到目标模型供应商");
    }

    const mask = this.deps.llmProxy.rotateProviderApiKey(providerId, trimmedKey);
    const updated = this.deps.llmStore.upsertProvider({
      ...existing,
      updatedBy: actor.username,
      updatedAt: this.deps.now(),
    });

    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "llm_api_key_rotated",
      targetType: "llm_provider",
      targetId: providerId,
      before: null,
      after: { apiKeyLast4: mask.apiKeyLast4 },
      reason: "管理员轮换模型供应商 API Key，旧 Key 已立即失效",
    });

    return this.toAdminLlmProviderView(updated);
  }

  async testLlmProvider(
    actor: AdminSession,
    providerId: string,
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const result = await this.deps.llmProxy.testProvider(providerId);
    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "llm_provider_tested",
      targetType: "llm_provider",
      targetId: providerId,
      before: null,
      after: { ok: result.ok, latencyMs: result.latencyMs },
      reason: result.ok ? "模型供应商连通性测试通过" : "模型供应商连通性测试失败",
    });
    return result;
  }

  getLlmPricing(providerId: string): LlmPricing {
    return (
      this.deps.llmStore.getPricing(providerId) ?? {
        providerId,
        costPer1MInputTokens: 0,
        costPer1MOutputTokens: 0,
        pricePer1MInputTokens: 0,
        pricePer1MOutputTokens: 0,
        currency: "CNY",
      }
    );
  }

  setLlmPricing(
    actor: AdminSession,
    providerId: string,
    input: {
      costPer1MInputTokens: number;
      costPer1MOutputTokens: number;
      pricePer1MInputTokens: number;
      pricePer1MOutputTokens: number;
    },
  ): LlmPricing {
    if (
      input.costPer1MInputTokens < 0 ||
      input.costPer1MOutputTokens < 0 ||
      input.pricePer1MInputTokens < 0 ||
      input.pricePer1MOutputTokens < 0
    ) {
      this.deps.throwError(400, "invalid_pricing", "成本价与售价不能为负数");
    }
    if (
      input.pricePer1MInputTokens < input.costPer1MInputTokens ||
      input.pricePer1MOutputTokens < input.costPer1MOutputTokens
    ) {
      this.deps.throwError(400, "price_below_cost", "售价必须大于或等于成本价");
    }

    const before = this.deps.llmStore.getPricing(providerId);
    const saved = this.deps.llmStore.upsertPricing({
      providerId,
      costPer1MInputTokens: input.costPer1MInputTokens,
      costPer1MOutputTokens: input.costPer1MOutputTokens,
      pricePer1MInputTokens: input.pricePer1MInputTokens,
      pricePer1MOutputTokens: input.pricePer1MOutputTokens,
      currency: "CNY",
    });

    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "llm_pricing_set",
      targetType: "llm_pricing",
      targetId: providerId,
      before: before ? { ...before } : null,
      after: { ...saved },
      reason: "管理员更新模型定价表",
    });
    return saved;
  }

  setTenantLlmBudget(
    actor: AdminSession,
    tenantId: string,
    input: { maxTokensPerDay?: number; maxCostPerDay?: number },
  ): { tenantId: string; maxTokensPerDay: number; maxCostPerDay: number } {
    if (
      (input.maxTokensPerDay !== undefined && input.maxTokensPerDay < 0) ||
      (input.maxCostPerDay !== undefined && input.maxCostPerDay < 0)
    ) {
      this.deps.throwError(400, "invalid_budget", "租户额度上限不能为负数");
    }
    const before = this.deps.llmProxy.getTenantBudget(tenantId);
    const updated = this.deps.llmProxy.setTenantBudget(tenantId, input);
    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "llm_budget_set",
      targetType: "tenant_llm_budget",
      targetId: tenantId,
      before: { ...before },
      after: { ...updated },
      reason: "管理员更新租户每日模型额度上限",
    });
    return { tenantId, ...updated };
  }

  getTenantLlmUsage(_actor: AdminSession, tenantId: string, date?: string): TenantLlmUsage {
    const targetDate = date?.trim() || new Date(this.deps.now()).toISOString().slice(0, 10);
    const usage = this.deps.llmStore.getUsage(tenantId, targetDate);
    const budget = this.deps.llmProxy.getTenantBudget(tenantId);
    return {
      tenantId,
      date: targetDate,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
      revenue: usage.revenue,
      maxTokensPerDay: budget.maxTokensPerDay,
      maxCostPerDay: budget.maxCostPerDay,
    };
  }
}
