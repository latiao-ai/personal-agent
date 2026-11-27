import { randomBytes, randomUUID } from "node:crypto";

import type {
  AdminSession,
  ChannelBinding,
  ChannelChatType,
  ChannelPlatform,
  CustomerSession,
  PortalAuditEntry,
  PortalRole,
  PortalUserAccount,
  TenantChannelAllowlist,
  UnifiedAccountRole,
  UnifiedLoginResult,
  UserIdentity,
  WeixinIdentity,
} from "../../shared/portal.ts";
import type { ApprovalEngine } from "../approvals/engine.ts";
import type { IsolationEngine } from "../isolation/engine.ts";
import { hashPortalPassword, hashPortalToken, verifyPortalPassword } from "./admin.ts";
import { stripUserSecrets, type PortalStore } from "./store.ts";

const CUSTOMER_SESSION_TTL_MS = 24 * 60 * 60_000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60_000;

export interface UnifiedOpsDeps {
  store: PortalStore;
  approvals: ApprovalEngine;
  isolation: IsolationEngine;
  now: () => number;
  loginAdminAccount: (username: string, password: string) => { token: string; session: AdminSession };
  registerTenantMember: (input: { tenantId: string; openId: string; displayName?: string; role: PortalRole }) => unknown;
  recordAudit: (entry: Omit<PortalAuditEntry, "id" | "at">) => PortalAuditEntry;
  onBindingsChanged: () => void;
  throwError: (status: number, code: string, message: string) => never;
}

/**
 * Control-plane operations for unified username/password login, admin-managed user accounts,
 * Feishu/Weixin identity linking, per-tenant allowlists, and multi-bot channel bindings.
 */
export class PortalUnifiedOps {
  private readonly deps: UnifiedOpsDeps;

  constructor(deps: UnifiedOpsDeps) {
    this.deps = deps;
  }

  // ===========================================================================
  // 1. Unified Login & Session Issuance
  // ===========================================================================

  loginUnified(username: string, password: string): UnifiedLoginResult {
    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      this.deps.throwError(400, "invalid_credentials", "请输入用户名和密码");
    }

    // 1. Check dedicated control-plane admin_accounts first.
    const adminAcc = this.deps.store.getAdminByUsername(cleanUser);
    if (adminAcc) {
      const logged = this.deps.loginAdminAccount(cleanUser, password);
      return {
        kind: "admin",
        redirectTo: "/admin",
        token: logged.token,
        session: logged.session,
      };
    }

    // 2. Check unified portal_users table (customer & ops_admin).
    const user = this.deps.store.getPortalUserByUsername(cleanUser);
    if (!user) {
      this.deps.throwError(401, "invalid_credentials", "用户名或密码错误");
    }
    if (user.disabledAt !== null) {
      this.deps.throwError(401, "account_disabled", "该账号已被停用");
    }
    if (!verifyPortalPassword(password, user.salt, user.passwordHash)) {
      this.deps.throwError(401, "invalid_credentials", "用户名或密码错误");
    }

    if (user.role === "ops_admin") {
      const issued = this.issueAdminSessionForUser(user.id, user.username, user.displayName);
      return {
        kind: "admin",
        redirectTo: "/admin",
        token: issued.token,
        session: issued.session,
      };
    }

    if (!user.tenantId) {
      this.deps.throwError(403, "tenant_not_assigned", "该客户账号未关联租户");
    }
    const issued = this.issueCustomerSessionForUser(user);
    return {
      kind: "customer",
      redirectTo: "/portal",
      token: issued.token,
      session: issued.session,
    };
  }

  private issueAdminSessionForUser(
    userId: string,
    username: string,
    displayName: string,
  ): { token: string; session: AdminSession } {
    const now = this.deps.now();
    const rawToken = `adm_tok_${randomBytes(24).toString("hex")}`;
    const session: AdminSession = {
      sessionId: `ases_${randomUUID()}`,
      adminId: userId,
      username,
      displayName,
      createdAt: now,
      expiresAt: now + ADMIN_SESSION_TTL_MS,
    };
    this.deps.store.insertAdminSession(hashPortalToken(rawToken), session);
    this.deps.recordAudit({
      tenantId: "_control_plane",
      actorId: username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "unified_admin_login",
      targetType: "session",
      targetId: session.sessionId,
      before: null,
      after: { username },
      reason: "管理员通过统一登录入口登录",
    });
    return { token: rawToken, session };
  }

  issueCustomerSessionForUser(user: PortalUserAccount): { token: string; session: CustomerSession } {
    if (!user.tenantId) {
      this.deps.throwError(403, "tenant_not_assigned", "该客户账号未关联租户");
    }
    const now = this.deps.now();
    const rawToken = `cust_${randomBytes(24).toString("hex")}`;
    // Resolve linked Feishu open_id if present, otherwise use stable user identity handle.
    const identities = this.deps.store.listFeishuIdentities(user.tenantId);
    const linked = identities.find((i) => i.userId === user.id);
    const openId = linked?.feishuOpenId ?? `user:${user.username}`;
    const session: CustomerSession = {
      sessionId: `cses_${randomUUID()}`,
      tenantId: user.tenantId,
      openId,
      displayName: user.displayName,
      role: user.tenantRole,
      userId: user.id,
      username: user.username,
      createdAt: now,
      expiresAt: now + CUSTOMER_SESSION_TTL_MS,
    };
    this.deps.store.insertCustomerSession(hashPortalToken(rawToken), session);
    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: user.username,
      actorRole: session.role,
      channel: "web",
      action: "unified_customer_login",
      targetType: "session",
      targetId: session.sessionId,
      before: null,
      after: { userId: user.id, username: user.username, tenantId: session.tenantId },
      reason: "客户通过统一登录入口登录",
    });
    return { token: rawToken, session };
  }

  // ===========================================================================
  // 2. Admin-Only User Provisioning (No Self-Registration)
  // ===========================================================================

  createUserAsAdmin(
    actor: AdminSession,
    input: {
      username: string;
      password: string;
      displayName?: string;
      role: UnifiedAccountRole;
      tenantId?: string;
      tenantRole?: PortalRole;
      legacyLocalAccount?: boolean;
      autoSwitchSession?: boolean;
    },
  ): {
    user: PortalUserAccount;
    autoRedirectTo: "/portal" | null;
    customerSession?: { token: string; session: CustomerSession };
  } {
    const username = input.username.trim();
    if (!username) {
      this.deps.throwError(400, "invalid_username", "用户名不能为空");
    }
    if (input.password.length < 6) {
      this.deps.throwError(400, "weak_password", "密码长度至少 6 位");
    }
    if (this.deps.store.getPortalUserByUsername(username) || this.deps.store.getAdminByUsername(username)) {
      this.deps.throwError(409, "username_exists", "该用户名已存在");
    }

    const now = this.deps.now();
    const tenantId =
      input.role === "customer"
        ? (input.tenantId?.trim() || (input.legacyLocalAccount ? `tenant_legacy_${username}` : `tenant_${username}`))
        : null;
    const tenantRole: PortalRole = input.tenantRole ?? "admin";
    const salt = randomBytes(16).toString("hex");
    const userId = `usr_${randomUUID()}`;

    const stored = {
      id: userId,
      username,
      displayName: input.displayName?.trim() || username,
      passwordHash: hashPortalPassword(input.password, salt),
      salt,
      role: input.role,
      tenantId,
      tenantRole,
      legacyLocalAccount: Boolean(input.legacyLocalAccount),
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    this.deps.store.insertPortalUser(stored);

    // Ensure tenant VM & member record exist for customer accounts so /portal works immediately.
    if (input.role === "customer" && tenantId) {
      const existingVm = this.deps.isolation.store.getTenantVm(tenantId);
      if (!existingVm) {
        this.deps.isolation.provisionTenant({
          tenantId,
          openIds: [`user:${username}`],
        });
      }
      this.deps.registerTenantMember({
        tenantId,
        openId: `user:${username}`,
        displayName: stored.displayName,
        role: tenantRole,
      });
    }

    const user = stripUserSecrets(stored);
    this.deps.recordAudit({
      tenantId: tenantId ?? "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "portal_user_created",
      targetType: "portal_user",
      targetId: user.id,
      before: null,
      after: {
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
        legacyLocalAccount: user.legacyLocalAccount,
      },
      reason: "管理员在后台创建统一登录账号",
    });

    // When creating a customer/test account (e.g. tanghaonan), auto-issue a customer session
    // so the admin console can immediately jump to /portal without putting any password in URL.
    if (input.role === "customer" && input.autoSwitchSession !== false) {
      const customerSession = this.issueCustomerSessionForUser(user);
      return { user, autoRedirectTo: "/portal", customerSession };
    }
    return { user, autoRedirectTo: null };
  }

  changeUserPasswordAsAdmin(actor: AdminSession, userId: string, newPassword: string): { ok: true } {
    if (newPassword.length < 6) {
      this.deps.throwError(400, "weak_password", "新密码长度至少 6 位");
    }
    const existing = this.deps.store.getPortalUserById(userId);
    if (!existing) {
      this.deps.throwError(404, "user_not_found", "账号不存在");
    }
    const salt = randomBytes(16).toString("hex");
    const hash = hashPortalPassword(newPassword, salt);
    this.deps.store.updatePortalUserPassword(userId, hash, salt, this.deps.now());
    this.deps.recordAudit({
      tenantId: existing.tenantId ?? "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "portal_user_password_changed",
      targetType: "portal_user",
      targetId: userId,
      before: null,
      after: { username: existing.username },
      reason: "管理员重置账号密码",
    });
    return { ok: true };
  }

  disableUserAsAdmin(actor: AdminSession, userId: string): { ok: true } {
    const existing = this.deps.store.getPortalUserById(userId);
    if (!existing) {
      this.deps.throwError(404, "user_not_found", "账号不存在");
    }
    const now = this.deps.now();
    this.deps.store.disablePortalUser(userId, now);
    this.deps.store.revokeCustomerSessionsByUserId(userId, now);
    this.deps.store.revokeAdminSessionsByAdminId(userId, now);
    this.deps.recordAudit({
      tenantId: existing.tenantId ?? "_control_plane",
      actorId: actor.username,
      actorRole: "ops_admin",
      channel: "admin",
      action: "portal_user_disabled",
      targetType: "portal_user",
      targetId: userId,
      before: { disabledAt: existing.disabledAt },
      after: { disabledAt: now },
      reason: "管理员停用账号并立即吊销全部会话",
    });
    return { ok: true };
  }

  // ===========================================================================
  // 3. Identity Linking (Feishu UserIdentity & Weixin WeixinIdentity)
  // ===========================================================================

  bindFeishuIdentity(session: CustomerSession, feishuOpenId: string): UserIdentity {
    const clean = feishuOpenId.trim();
    if (!clean) {
      this.deps.throwError(400, "invalid_feishu_open_id", "飞书 open_id 不能为空");
    }
    const userId = session.userId ?? session.openId;
    const identity: UserIdentity = {
      id: `fid_${randomUUID()}`,
      userId,
      tenantId: session.tenantId,
      feishuOpenId: clean,
      createdAt: this.deps.now(),
    };
    this.deps.store.upsertFeishuIdentity(identity);
    this.deps.registerTenantMember({
      tenantId: session.tenantId,
      openId: clean,
      displayName: session.displayName,
      role: session.role,
    });
    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: session.username ?? session.openId,
      actorRole: session.role,
      channel: "web",
      action: "feishu_identity_bound",
      targetType: "user_identity",
      targetId: identity.id,
      before: null,
      after: { userId, feishuOpenId: clean },
      reason: "客户在门户绑定飞书 open_id",
    });
    return identity;
  }

  bindWeixinIdentity(session: CustomerSession, input: { weixinOpenId: string; ilinkAccountId: string }): WeixinIdentity {
    const openId = input.weixinOpenId.trim();
    const ilinkId = input.ilinkAccountId.trim();
    if (!openId || !ilinkId) {
      this.deps.throwError(400, "invalid_weixin_identity", "微信标识与 iLink 账号 ID 不能为空");
    }
    const userId = session.userId ?? session.openId;
    const identity: WeixinIdentity = {
      id: `wxid_${randomUUID()}`,
      userId,
      tenantId: session.tenantId,
      weixinOpenId: openId,
      ilinkAccountId: ilinkId,
      createdAt: this.deps.now(),
    };
    this.deps.store.upsertWeixinIdentity(identity);
    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: session.username ?? session.openId,
      actorRole: session.role,
      channel: "web",
      action: "weixin_identity_bound",
      targetType: "weixin_identity",
      targetId: identity.id,
      before: null,
      after: { userId, weixinOpenId: openId, ilinkAccountId: ilinkId },
      reason: "客户在门户绑定个人微信 iLink 身份",
    });
    return identity;
  }

  // ===========================================================================
  // 4. Multi-Bot Channel Bindings + ControlPlaneVault Credential Isolation
  // ===========================================================================

  createChannelBinding(
    session: CustomerSession,
    input: {
      botId: string;
      platform: ChannelPlatform;
      platformAppId: string;
      platformSecret?: string;
      chatId: string;
      chatType: ChannelChatType;
      label?: string;
      forceReplaceDuplicateCredential?: boolean;
    },
  ): { binding: ChannelBinding; disabledDuplicateBindingIds: string[] } {
    const botId = input.botId.trim();
    const platformAppId = input.platformAppId.trim();
    const chatId = input.chatId.trim();
    if (!botId || !platformAppId || !chatId) {
      this.deps.throwError(400, "invalid_channel_binding", "botId、平台应用 ID 和群/会话 ID 不能为空");
    }

    // Verify bot belongs to this tenant (supports any bot registered in tenant VM or custom bot).
    const vm = this.deps.isolation.store.getTenantVm(session.tenantId);
    if (!vm) {
      this.deps.throwError(404, "tenant_vm_not_found", "当前租户尚未初始化实例");
    }

    // Rule 1: One chat can only have ONE active bot binding at a time.
    const existingChat = this.deps.store.findActiveChannelBinding(input.platform, chatId);
    if (existingChat) {
      this.deps.throwError(
        409,
        "chat_already_bound",
        `该会话已绑定 Bot（${existingChat.botId}），请先解绑旧绑定后再换绑`,
      );
    }

    // Rule 2: Duplicate credential across different bots -> disable conflicting bot binding or reject.
    const sameAppBindings = this.deps.store.listActiveChannelBindingsByApp(input.platform, platformAppId);
    const conflicting = sameAppBindings.filter((b) => b.botId !== botId || b.tenantId !== session.tenantId);
    const disabledDuplicateBindingIds: string[] = [];
    if (conflicting.length > 0) {
      const crossTenant = conflicting.some((b) => b.tenantId !== session.tenantId);
      if (crossTenant) {
        this.deps.throwError(409, "duplicate_credential", "该平台凭据已被其他租户占用");
      }
      if (!input.forceReplaceDuplicateCredential) {
        for (const conflict of conflicting) {
          this.deps.store.setChannelBindingStatus(conflict.id, "disabled", this.deps.now());
          disabledDuplicateBindingIds.push(conflict.id);
        }
      } else {
        for (const conflict of conflicting) {
          this.deps.store.setChannelBindingStatus(conflict.id, "disabled", this.deps.now());
          disabledDuplicateBindingIds.push(conflict.id);
        }
      }
    }

    // Store platform secret strictly in tenant-isolated ControlPlaneVault (never in SQLite or logs).
    if (input.platformSecret?.trim()) {
      const secretKey =
        input.platform === "feishu"
          ? `channel:feishu:${platformAppId}:app_secret`
          : `channel:weixin:${platformAppId}:ilink_token`;
      this.deps.approvals.vault.setSecret(session.tenantId, secretKey, input.platformSecret.trim());
    }

    const now = this.deps.now();
    const binding: ChannelBinding = {
      id: `chb_${randomUUID()}`,
      botId,
      tenantId: session.tenantId,
      platform: input.platform,
      platformAppId,
      chatId,
      chatType: input.chatType,
      status: "active",
      label: input.label?.trim() || `${input.platform}:${chatId}`,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertChannelBinding(binding);

    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: session.username ?? session.openId,
      actorRole: session.role,
      channel: "web",
      action: "channel_binding_created",
      targetType: "channel_binding",
      targetId: binding.id,
      before: null,
      after: {
        botId: binding.botId,
        platform: binding.platform,
        platformAppId: binding.platformAppId,
        chatId: binding.chatId,
        chatType: binding.chatType,
        disabledDuplicates: disabledDuplicateBindingIds,
      },
      reason: "客户在门户为 Bot 绑定消息平台",
    });

    this.deps.onBindingsChanged();
    return { binding, disabledDuplicateBindingIds };
  }

  unbindChannelBinding(session: CustomerSession, bindingId: string): ChannelBinding {
    const existing = this.deps.store.getChannelBinding(bindingId);
    if (!existing) {
      this.deps.throwError(404, "binding_not_found", "绑定记录不存在");
    }
    if (existing.tenantId !== session.tenantId) {
      this.deps.throwError(403, "cross_tenant_forbidden", "无权操作其他租户的频道绑定");
    }
    const now = this.deps.now();
    this.deps.store.setChannelBindingStatus(bindingId, "disabled", now);
    const updated: ChannelBinding = { ...existing, status: "disabled", updatedAt: now };

    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: session.username ?? session.openId,
      actorRole: session.role,
      channel: "web",
      action: "channel_binding_disabled",
      targetType: "channel_binding",
      targetId: bindingId,
      before: { status: existing.status },
      after: { status: "disabled" },
      reason: "客户在门户解绑消息平台",
    });

    this.deps.onBindingsChanged();
    return updated;
  }

  // ===========================================================================
  // 5. Per-Tenant Channel Allowlist (Isolated in DB)
  // ===========================================================================

  getTenantAllowlist(tenantId: string, platform: ChannelPlatform): TenantChannelAllowlist {
    return (
      this.deps.store.getTenantChannelAllowlist(tenantId, platform) ?? {
        tenantId,
        platform,
        allowedSenderIds: [],
        updatedAt: 0,
        updatedBy: "system",
      }
    );
  }

  setTenantAllowlist(
    session: CustomerSession,
    platform: ChannelPlatform,
    allowedSenderIds: string[],
  ): TenantChannelAllowlist {
    const before = this.getTenantAllowlist(session.tenantId, platform);
    const cleaned = [...new Set(allowedSenderIds.map((s) => s.trim()).filter(Boolean))];
    const updated: TenantChannelAllowlist = {
      tenantId: session.tenantId,
      platform,
      allowedSenderIds: cleaned,
      updatedAt: this.deps.now(),
      updatedBy: session.username ?? session.openId,
    };
    this.deps.store.setTenantChannelAllowlist(updated);
    this.deps.recordAudit({
      tenantId: session.tenantId,
      actorId: updated.updatedBy,
      actorRole: session.role,
      channel: "web",
      action: "channel_allowlist_updated",
      targetType: "channel_allowlist",
      targetId: `${session.tenantId}:${platform}`,
      before: { allowedSenderIds: before.allowedSenderIds },
      after: { allowedSenderIds: updated.allowedSenderIds },
      reason: "客户更新本租户消息平台白名单",
    });
    this.deps.onBindingsChanged();
    return updated;
  }
}
