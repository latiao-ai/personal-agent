import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AdminAccount,
  AdminSession,
  CoreSkillHashChangeRequest,
  CustomerSession,
  MemoryChangeSuggestion,
  PortalAuditEntry,
  PortalRole,
  QrChallengeStatus,
  TenantMember,
  TenantScheduleConfig,
} from "../../shared/portal.ts";

export interface StoredQrChallenge {
  qrToken: string;
  qrUrl: string;
  status: QrChallengeStatus;
  openId: string | null;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
}

export interface StoredAdminAccount extends AdminAccount {
  passwordHash: string;
  salt: string;
}

/** Control-plane SQLite store for Customer Web Portal & Admin Console auth, config, and audit. */
export class PortalStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.path = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Ignore on filesystems without POSIX chmod.
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS tenant_members (
        tenant_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, open_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_members_open_id ON tenant_members(open_id);

      CREATE TABLE IF NOT EXISTS qr_challenges (
        qr_token TEXT PRIMARY KEY,
        qr_url TEXT NOT NULL,
        status TEXT NOT NULL,
        open_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS customer_sessions (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_customer_sessions_tenant ON customer_sessions(tenant_id);

      CREATE TABLE IF NOT EXISTS admin_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);

      CREATE TABLE IF NOT EXISTS tenant_bot_states (
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (tenant_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS tenant_schedules (
        tenant_id TEXT PRIMARY KEY,
        patrol_frequency_per_day INTEGER NOT NULL,
        daily_digest_time TEXT NOT NULL,
        patrol_enabled INTEGER NOT NULL,
        digest_enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_approvers (
        tenant_id TEXT PRIMARY KEY,
        approver_open_ids_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_suggestions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        suggested_content TEXT NOT NULL,
        reason TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_suggestions_tenant ON memory_suggestions(tenant_id);

      CREATE TABLE IF NOT EXISTS core_skill_change_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        approved_by TEXT,
        status TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        new_hash TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_core_skill_req_tenant ON core_skill_change_requests(tenant_id);

      CREATE TABLE IF NOT EXISTS portal_audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        reason TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_portal_audit_tenant ON portal_audit_log(tenant_id, at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- Tenant Members ---

  upsertTenantMember(member: TenantMember): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tenant_members (tenant_id, open_id, display_name, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(member.tenantId, member.openId, member.displayName, member.role, member.createdAt);
  }

  getMemberByOpenId(openId: string): TenantMember | null {
    const row = this.db
      .prepare(`SELECT * FROM tenant_members WHERE open_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(openId) as Record<string, unknown> | undefined;
    return row ? rowToMember(row) : null;
  }

  listTenantMembers(tenantId: string): TenantMember[] {
    const rows = this.db
      .prepare(`SELECT * FROM tenant_members WHERE tenant_id = ? ORDER BY created_at ASC`)
      .all(tenantId) as Record<string, unknown>[];
    return rows.map(rowToMember);
  }

  deleteTenantData(tenantId: string): void {
    this.db.prepare(`DELETE FROM tenant_members WHERE tenant_id = ?`).run(tenantId);
    this.db.prepare(`DELETE FROM customer_sessions WHERE tenant_id = ?`).run(tenantId);
    this.db.prepare(`DELETE FROM tenant_bot_states WHERE tenant_id = ?`).run(tenantId);
    this.db.prepare(`DELETE FROM tenant_schedules WHERE tenant_id = ?`).run(tenantId);
    this.db.prepare(`DELETE FROM tenant_approvers WHERE tenant_id = ?`).run(tenantId);
    this.db.prepare(`DELETE FROM memory_suggestions WHERE tenant_id = ?`).run(tenantId);
  }

  // --- Feishu QR Challenges ---

  insertQrChallenge(challenge: StoredQrChallenge): void {
    this.db
      .prepare(
        `INSERT INTO qr_challenges (qr_token, qr_url, status, open_id, created_at, expires_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        challenge.qrToken,
        challenge.qrUrl,
        challenge.status,
        challenge.openId,
        challenge.createdAt,
        challenge.expiresAt,
        challenge.confirmedAt,
      );
  }

  getQrChallenge(qrToken: string): StoredQrChallenge | null {
    const row = this.db
      .prepare(`SELECT * FROM qr_challenges WHERE qr_token = ?`)
      .get(qrToken) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      qrToken: String(row.qr_token),
      qrUrl: String(row.qr_url),
      status: row.status as QrChallengeStatus,
      openId: row.open_id ? String(row.open_id) : null,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      confirmedAt: row.confirmed_at !== null && row.confirmed_at !== undefined ? Number(row.confirmed_at) : null,
    };
  }

  confirmQrChallenge(qrToken: string, openId: string, confirmedAt: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE qr_challenges SET status = 'confirmed', open_id = ?, confirmed_at = ?
         WHERE qr_token = ? AND status = 'pending'`,
      )
      .run(openId, confirmedAt, qrToken);
    return Number(res.changes) > 0;
  }

  consumeQrChallenge(qrToken: string): boolean {
    const res = this.db
      .prepare(`UPDATE qr_challenges SET status = 'consumed' WHERE qr_token = ? AND status = 'confirmed'`)
      .run(qrToken);
    return Number(res.changes) > 0;
  }

  expireQrChallenge(qrToken: string): void {
    this.db
      .prepare(`UPDATE qr_challenges SET status = 'expired' WHERE qr_token = ? AND status = 'pending'`)
      .run(qrToken);
  }

  // --- Customer Sessions ---

  insertCustomerSession(tokenHash: string, session: CustomerSession): void {
    this.db
      .prepare(
        `INSERT INTO customer_sessions (
          token_hash, session_id, tenant_id, open_id, display_name, role, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        tokenHash,
        session.sessionId,
        session.tenantId,
        session.openId,
        session.displayName,
        session.role,
        session.createdAt,
        session.expiresAt,
      );
  }

  getCustomerSession(tokenHash: string): (CustomerSession & { revokedAt: number | null }) | null {
    const row = this.db
      .prepare(`SELECT * FROM customer_sessions WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      tenantId: String(row.tenant_id),
      openId: String(row.open_id),
      displayName: String(row.display_name),
      role: row.role as PortalRole,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
    };
  }

  revokeCustomerSession(tokenHash: string, revokedAt: number): void {
    this.db.prepare(`UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ?`).run(revokedAt, tokenHash);
  }

  // --- Admin Accounts & Sessions ---

  insertAdminAccount(account: StoredAdminAccount): void {
    this.db
      .prepare(
        `INSERT INTO admin_accounts (id, username, display_name, password_hash, salt, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.username,
        account.displayName,
        account.passwordHash,
        account.salt,
        account.createdAt,
        account.revokedAt,
      );
  }

  getAdminByUsername(username: string): StoredAdminAccount | null {
    const row = this.db
      .prepare(`SELECT * FROM admin_accounts WHERE username = ?`)
      .get(username) as Record<string, unknown> | undefined;
    return row ? rowToAdmin(row) : null;
  }

  getAdminById(id: string): StoredAdminAccount | null {
    const row = this.db
      .prepare(`SELECT * FROM admin_accounts WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToAdmin(row) : null;
  }

  listAdminAccounts(): AdminAccount[] {
    const rows = this.db
      .prepare(`SELECT * FROM admin_accounts ORDER BY created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => {
      const a = rowToAdmin(row);
      return {
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        createdAt: a.createdAt,
        revokedAt: a.revokedAt,
      };
    });
  }

  revokeAdminAccount(adminId: string, revokedAt: number): boolean {
    const res = this.db
      .prepare(`UPDATE admin_accounts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(revokedAt, adminId);
    this.db
      .prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL`)
      .run(revokedAt, adminId);
    return Number(res.changes) > 0;
  }

  insertAdminSession(tokenHash: string, session: AdminSession): void {
    this.db
      .prepare(
        `INSERT INTO admin_sessions (
          token_hash, session_id, admin_id, username, display_name, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        tokenHash,
        session.sessionId,
        session.adminId,
        session.username,
        session.displayName,
        session.createdAt,
        session.expiresAt,
      );
  }

  getAdminSession(tokenHash: string): (AdminSession & { revokedAt: number | null }) | null {
    const row = this.db
      .prepare(`SELECT * FROM admin_sessions WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      adminId: String(row.admin_id),
      username: String(row.username),
      displayName: String(row.display_name),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
    };
  }

  revokeAdminSession(tokenHash: string, revokedAt: number): void {
    this.db.prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ?`).run(revokedAt, tokenHash);
  }

  // --- Bot Enable/Disable States ---

  setBotState(tenantId: string, botId: string, enabled: boolean, updatedAt: number, updatedBy: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tenant_bot_states (tenant_id, bot_id, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenantId, botId, enabled ? 1 : 0, updatedAt, updatedBy);
  }

  getBotStates(tenantId: string): Map<string, { enabled: boolean; updatedAt: number; updatedBy: string }> {
    const rows = this.db
      .prepare(`SELECT * FROM tenant_bot_states WHERE tenant_id = ?`)
      .all(tenantId) as Record<string, unknown>[];
    const map = new Map<string, { enabled: boolean; updatedAt: number; updatedBy: string }>();
    for (const row of rows) {
      map.set(String(row.bot_id), {
        enabled: Number(row.enabled) === 1,
        updatedAt: Number(row.updated_at),
        updatedBy: String(row.updated_by),
      });
    }
    return map;
  }

  // --- Schedule Config ---

  getSchedule(tenantId: string): TenantScheduleConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM tenant_schedules WHERE tenant_id = ?`)
      .get(tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      patrolFrequencyPerDay: Number(row.patrol_frequency_per_day),
      dailyDigestTime: String(row.daily_digest_time),
      patrolEnabled: Number(row.patrol_enabled) === 1,
      digestEnabled: Number(row.digest_enabled) === 1,
      updatedAt: Number(row.updated_at),
      updatedBy: String(row.updated_by),
      effectiveNote: "已生效，下次巡检与日报将按当前配置执行",
    };
  }

  upsertSchedule(config: Omit<TenantScheduleConfig, "effectiveNote">): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tenant_schedules (
          tenant_id, patrol_frequency_per_day, daily_digest_time, patrol_enabled, digest_enabled, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.tenantId,
        config.patrolFrequencyPerDay,
        config.dailyDigestTime,
        config.patrolEnabled ? 1 : 0,
        config.digestEnabled ? 1 : 0,
        config.updatedAt,
        config.updatedBy,
      );
  }

  // --- Approver Lists ---

  getApprovers(tenantId: string): { approverOpenIds: string[]; updatedAt: number } | null {
    const row = this.db
      .prepare(`SELECT * FROM tenant_approvers WHERE tenant_id = ?`)
      .get(tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      approverOpenIds: JSON.parse(String(row.approver_open_ids_json)) as string[],
      updatedAt: Number(row.updated_at),
    };
  }

  setApprovers(tenantId: string, approverOpenIds: string[], updatedAt: number, updatedBy: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tenant_approvers (tenant_id, approver_open_ids_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tenantId, JSON.stringify(approverOpenIds), updatedAt, updatedBy);
  }

  // --- Memory Suggestions ---

  insertMemorySuggestion(suggestion: MemoryChangeSuggestion): void {
    this.db
      .prepare(
        `INSERT INTO memory_suggestions (
          id, tenant_id, memory_id, suggested_content, reason, submitted_by, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        suggestion.id,
        suggestion.tenantId,
        suggestion.memoryId,
        suggestion.suggestedContent,
        suggestion.reason,
        suggestion.submittedBy,
        suggestion.status,
        suggestion.createdAt,
      );
  }

  listMemorySuggestions(tenantId: string): MemoryChangeSuggestion[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_suggestions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(tenantId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      memoryId: String(row.memory_id),
      suggestedContent: String(row.suggested_content),
      reason: String(row.reason),
      submittedBy: String(row.submitted_by),
      status: row.status as MemoryChangeSuggestion["status"],
      createdAt: Number(row.created_at),
    }));
  }

  // --- Core Skill Hash Change Approval Requests ---

  insertCoreSkillChangeRequest(req: CoreSkillHashChangeRequest): void {
    this.db
      .prepare(
        `INSERT INTO core_skill_change_requests (
          id, tenant_id, skill_id, skill_name, requested_by, approved_by, status,
          patch_json, previous_hash, new_hash, reason, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.tenantId,
        req.skillId,
        req.skillName,
        req.requestedBy,
        req.approvedBy,
        req.status,
        JSON.stringify(req.patch),
        req.previousHash,
        req.newHash,
        req.reason,
        req.createdAt,
        req.decidedAt,
      );
  }

  getCoreSkillChangeRequest(id: string): CoreSkillHashChangeRequest | null {
    const row = this.db
      .prepare(`SELECT * FROM core_skill_change_requests WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToCoreSkillReq(row) : null;
  }

  updateCoreSkillChangeRequest(
    id: string,
    status: CoreSkillHashChangeRequest["status"],
    approvedBy: string,
    newHash: string | null,
    decidedAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE core_skill_change_requests
         SET status = ?, approved_by = ?, new_hash = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(status, approvedBy, newHash, decidedAt, id);
  }

  listCoreSkillChangeRequests(tenantId?: string): CoreSkillHashChangeRequest[] {
    const rows = tenantId
      ? (this.db
          .prepare(`SELECT * FROM core_skill_change_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`)
          .all(tenantId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM core_skill_change_requests ORDER BY created_at DESC LIMIT 100`)
          .all() as Record<string, unknown>[]);
    return rows.map(rowToCoreSkillReq);
  }

  // --- Portal Audit Log ---

  appendAudit(entry: PortalAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO portal_audit_log (
          id, tenant_id, actor_id, actor_role, channel, action, target_type, target_id,
          before_json, after_json, reason, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.actorId,
        entry.actorRole,
        entry.channel,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.reason,
        entry.at,
      );
  }

  listAudit(tenantId?: string, limit = 100): PortalAuditEntry[] {
    const rows = tenantId
      ? (this.db
          .prepare(`SELECT * FROM portal_audit_log WHERE tenant_id = ? ORDER BY at DESC LIMIT ?`)
          .all(tenantId, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM portal_audit_log ORDER BY at DESC LIMIT ?`)
          .all(limit) as Record<string, unknown>[]);
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      actorId: String(row.actor_id),
      actorRole: row.actor_role as PortalAuditEntry["actorRole"],
      channel: row.channel as PortalAuditEntry["channel"],
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      before: row.before_json ? (JSON.parse(String(row.before_json)) as Record<string, unknown>) : null,
      after: row.after_json ? (JSON.parse(String(row.after_json)) as Record<string, unknown>) : null,
      reason: String(row.reason),
      at: Number(row.at),
    }));
  }
}

function rowToMember(row: Record<string, unknown>): TenantMember {
  return {
    tenantId: String(row.tenant_id),
    openId: String(row.open_id),
    displayName: String(row.display_name),
    role: row.role as PortalRole,
    createdAt: Number(row.created_at),
  };
}

function rowToAdmin(row: Record<string, unknown>): StoredAdminAccount {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    salt: String(row.salt),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
  };
}

function rowToCoreSkillReq(row: Record<string, unknown>): CoreSkillHashChangeRequest {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    skillId: String(row.skill_id),
    skillName: String(row.skill_name),
    requestedBy: String(row.requested_by),
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    status: row.status as CoreSkillHashChangeRequest["status"],
    patch: JSON.parse(String(row.patch_json)) as CoreSkillHashChangeRequest["patch"],
    previousHash: String(row.previous_hash),
    newHash: row.new_hash ? String(row.new_hash) : null,
    reason: String(row.reason),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at !== null && row.decided_at !== undefined ? Number(row.decided_at) : null,
  };
}
