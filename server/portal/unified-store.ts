import type { DatabaseSync } from "node:sqlite";

import type {
  ChannelBinding,
  ChannelBindingStatus,
  ChannelChatType,
  ChannelPlatform,
  PortalRole,
  PortalUserAccount,
  TenantChannelAllowlist,
  UnifiedAccountRole,
  UserIdentity,
  WeixinIdentity,
} from "../../shared/portal.ts";

export interface StoredPortalUserAccount extends PortalUserAccount {
  passwordHash: string;
  salt: string;
}

export function stripUserSecrets(user: StoredPortalUserAccount): PortalUserAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    tenantId: user.tenantId,
    tenantRole: user.tenantRole,
    legacyLocalAccount: user.legacyLocalAccount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    disabledAt: user.disabledAt,
  };
}

/** SQLite persistence helpers for unified users, channel bindings, identities, and tenant allowlists. */
export class PortalUnifiedStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insertPortalUser(user: StoredPortalUserAccount): void {
    this.db
      .prepare(
        `INSERT INTO portal_users (
          id, username, display_name, password_hash, salt, role, tenant_id, tenant_role,
          legacy_local, created_at, updated_at, disabled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.username,
        user.displayName,
        user.passwordHash,
        user.salt,
        user.role,
        user.tenantId,
        user.tenantRole,
        user.legacyLocalAccount ? 1 : 0,
        user.createdAt,
        user.updatedAt,
        user.disabledAt,
      );
  }

  getPortalUserByUsername(username: string): StoredPortalUserAccount | null {
    const row = this.db.prepare(`SELECT * FROM portal_users WHERE username = ?`).get(username) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPortalUser(row) : null;
  }

  getPortalUserById(id: string): StoredPortalUserAccount | null {
    const row = this.db.prepare(`SELECT * FROM portal_users WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToPortalUser(row) : null;
  }

  listPortalUsers(): PortalUserAccount[] {
    const rows = this.db.prepare(`SELECT * FROM portal_users ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => stripUserSecrets(rowToPortalUser(row)));
  }

  updatePortalUserPassword(id: string, passwordHash: string, salt: string, updatedAt: number): boolean {
    const res = this.db
      .prepare(`UPDATE portal_users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?`)
      .run(passwordHash, salt, updatedAt, id);
    return Number(res.changes) > 0;
  }

  disablePortalUser(id: string, disabledAt: number): boolean {
    const res = this.db
      .prepare(`UPDATE portal_users SET disabled_at = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL`)
      .run(disabledAt, disabledAt, id);
    return Number(res.changes) > 0;
  }

  insertChannelBinding(binding: ChannelBinding): void {
    this.db
      .prepare(
        `INSERT INTO channel_bindings (
          id, bot_id, tenant_id, platform, platform_app_id, chat_id, chat_type, status, label, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.id,
        binding.botId,
        binding.tenantId,
        binding.platform,
        binding.platformAppId,
        binding.chatId,
        binding.chatType,
        binding.status,
        binding.label,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  getChannelBinding(id: string): ChannelBinding | null {
    const row = this.db.prepare(`SELECT * FROM channel_bindings WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToChannelBinding(row) : null;
  }

  findActiveChannelBinding(platform: ChannelPlatform, chatId: string): ChannelBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM channel_bindings WHERE platform = ? AND chat_id = ? AND status = 'active' LIMIT 1`)
      .get(platform, chatId) as Record<string, unknown> | undefined;
    return row ? rowToChannelBinding(row) : null;
  }

  listActiveChannelBindingsByApp(platform: ChannelPlatform, platformAppId: string): ChannelBinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM channel_bindings WHERE platform = ? AND platform_app_id = ? AND status = 'active'`)
      .all(platform, platformAppId) as Record<string, unknown>[];
    return rows.map(rowToChannelBinding);
  }

  listChannelBindings(filter?: { tenantId?: string; botId?: string; status?: ChannelBindingStatus }): ChannelBinding[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.tenantId) {
      clauses.push("tenant_id = ?");
      params.push(filter.tenantId);
    }
    if (filter?.botId) {
      clauses.push("bot_id = ?");
      params.push(filter.botId);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM channel_bindings ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToChannelBinding);
  }

  setChannelBindingStatus(id: string, status: ChannelBindingStatus, updatedAt: number): boolean {
    const res = this.db
      .prepare(`UPDATE channel_bindings SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, updatedAt, id);
    return Number(res.changes) > 0;
  }

  upsertFeishuIdentity(identity: UserIdentity): void {
    this.db
      .prepare(
        `INSERT INTO user_identities (id, user_id, tenant_id, feishu_open_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET feishu_open_id = excluded.feishu_open_id`,
      )
      .run(identity.id, identity.userId, identity.tenantId, identity.feishuOpenId, identity.createdAt);
  }

  findFeishuIdentity(tenantId: string, feishuOpenId: string): UserIdentity | null {
    const row = this.db
      .prepare(`SELECT * FROM user_identities WHERE tenant_id = ? AND feishu_open_id = ?`)
      .get(tenantId, feishuOpenId) as Record<string, unknown> | undefined;
    return row ? rowToFeishuIdentity(row) : null;
  }

  listFeishuIdentities(tenantId: string): UserIdentity[] {
    const rows = this.db
      .prepare(`SELECT * FROM user_identities WHERE tenant_id = ? ORDER BY created_at DESC`)
      .all(tenantId) as Record<string, unknown>[];
    return rows.map(rowToFeishuIdentity);
  }

  upsertWeixinIdentity(identity: WeixinIdentity): void {
    this.db
      .prepare(
        `INSERT INTO weixin_identities (id, user_id, tenant_id, weixin_open_id, ilink_account_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET
           weixin_open_id = excluded.weixin_open_id,
           ilink_account_id = excluded.ilink_account_id`,
      )
      .run(
        identity.id,
        identity.userId,
        identity.tenantId,
        identity.weixinOpenId,
        identity.ilinkAccountId,
        identity.createdAt,
      );
  }

  findWeixinIdentity(tenantId: string, weixinOpenId: string): WeixinIdentity | null {
    const row = this.db
      .prepare(`SELECT * FROM weixin_identities WHERE tenant_id = ? AND weixin_open_id = ?`)
      .get(tenantId, weixinOpenId) as Record<string, unknown> | undefined;
    return row ? rowToWeixinIdentity(row) : null;
  }

  listWeixinIdentities(tenantId: string): WeixinIdentity[] {
    const rows = this.db
      .prepare(`SELECT * FROM weixin_identities WHERE tenant_id = ? ORDER BY created_at DESC`)
      .all(tenantId) as Record<string, unknown>[];
    return rows.map(rowToWeixinIdentity);
  }

  getTenantChannelAllowlist(tenantId: string, platform: ChannelPlatform): TenantChannelAllowlist | null {
    const row = this.db
      .prepare(`SELECT * FROM tenant_channel_allowlists WHERE tenant_id = ? AND platform = ?`)
      .get(tenantId, platform) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      platform: row.platform as ChannelPlatform,
      allowedSenderIds: JSON.parse(String(row.allowed_sender_ids_json)) as string[],
      updatedAt: Number(row.updated_at),
      updatedBy: String(row.updated_by),
    };
  }

  setTenantChannelAllowlist(allowlist: TenantChannelAllowlist): void {
    this.db
      .prepare(
        `INSERT INTO tenant_channel_allowlists (tenant_id, platform, allowed_sender_ids_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, platform) DO UPDATE SET
           allowed_sender_ids_json = excluded.allowed_sender_ids_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        allowlist.tenantId,
        allowlist.platform,
        JSON.stringify(allowlist.allowedSenderIds),
        allowlist.updatedAt,
        allowlist.updatedBy,
      );
  }
}

function rowToPortalUser(row: Record<string, unknown>): StoredPortalUserAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    salt: String(row.salt),
    role: row.role as UnifiedAccountRole,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    tenantRole: row.tenant_role as PortalRole,
    legacyLocalAccount: Number(row.legacy_local) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    disabledAt: row.disabled_at !== null && row.disabled_at !== undefined ? Number(row.disabled_at) : null,
  };
}

function rowToChannelBinding(row: Record<string, unknown>): ChannelBinding {
  return {
    id: String(row.id),
    botId: String(row.bot_id),
    tenantId: String(row.tenant_id),
    platform: row.platform as ChannelPlatform,
    platformAppId: String(row.platform_app_id),
    chatId: String(row.chat_id),
    chatType: row.chat_type as ChannelChatType,
    status: row.status as ChannelBindingStatus,
    label: String(row.label ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToFeishuIdentity(row: Record<string, unknown>): UserIdentity {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    feishuOpenId: String(row.feishu_open_id),
    createdAt: Number(row.created_at),
  };
}

function rowToWeixinIdentity(row: Record<string, unknown>): WeixinIdentity {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    weixinOpenId: String(row.weixin_open_id),
    ilinkAccountId: String(row.ilink_account_id),
    createdAt: Number(row.created_at),
  };
}
