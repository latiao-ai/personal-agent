import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CoreSkillCategory,
  DreamSpendSummary,
  DreamTokenUsage,
  LongMemoryCategory,
  LongTermMemoryRecord,
  ManagedSkill,
  MediumMemoryCategory,
  MediumTermMemoryRecord,
  MemoryPollutionEvent,
  MemoryScope,
  MemorySourceTrust,
  PendingConfirmationStatus,
  PendingMemoryConfirmation,
  ShortMemoryCategory,
  ShortTermMemoryRecord,
  SkillChangeLogEntry,
  SkillLifecycleState,
  SkillLockDenialRecord,
  SkillSpec,
  SkillVersionSnapshot,
} from "../../shared/memory-skill.ts";

/**
 * Control-plane SQLite store for MVP5 (`memory-skill.sqlite`).
 * Keeps long-term memories, pending confirmations, core skill lock hashes,
 * skill version snapshots, change logs, and dream token ledger outside any user VM.
 */
export class MemorySkillStore {
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
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS short_term_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_short_term_session
        ON short_term_memories(tenant_id, bot_id, session_id);

      CREATE TABLE IF NOT EXISTS medium_term_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        category TEXT NOT NULL,
        period_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        highlights_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_medium_term_tenant
        ON medium_term_memories(tenant_id, category, period_key);

      CREATE TABLE IF NOT EXISTS long_term_memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bot_id TEXT,
        scope TEXT NOT NULL,
        category TEXT NOT NULL,
        mem_key TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_json TEXT,
        high_impact INTEGER NOT NULL DEFAULT 0,
        source_trust TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_long_term_tenant
        ON long_term_memories(tenant_id, scope, category);

      CREATE TABLE IF NOT EXISTS pending_memory_confirmations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        category TEXT NOT NULL,
        mem_key TEXT NOT NULL,
        content TEXT NOT NULL,
        source_trust TEXT NOT NULL,
        source_excerpt TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        feishu_card_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT,
        committed_memory_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_confirmations_tenant
        ON pending_memory_confirmations(tenant_id, status);

      CREATE TABLE IF NOT EXISTS memory_pollution_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        matched_rule TEXT NOT NULL,
        disposition TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dream_token_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_occurrences (
        tenant_id TEXT NOT NULL,
        workflow_key TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        crystallized_skill_id TEXT,
        PRIMARY KEY (tenant_id, workflow_key)
      );

      CREATE TABLE IF NOT EXISTS managed_skills (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        trigger_phrases_json TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        is_core INTEGER NOT NULL DEFAULT 0,
        core_category TEXT,
        lifecycle TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL,
        merged_into_skill_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_managed_skills_tenant
        ON managed_skills(tenant_id, lifecycle);

      CREATE TABLE IF NOT EXISTS core_skill_locks (
        skill_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        core_category TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        trigger_phrases_json TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill
        ON skill_versions(tenant_id, skill_id, version);

      CREATE TABLE IF NOT EXISTS skill_change_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_version INTEGER,
        to_version INTEGER NOT NULL,
        actor TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_lock_denials (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        core_category TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        actual_hash TEXT,
        recorded_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- Short-term memory ---

  insertShortTerm(record: ShortTermMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO short_term_memories (id, tenant_id, bot_id, session_id, category, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.botId,
        record.sessionId,
        record.category,
        record.content,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      );
  }

  listShortTerm(tenantId: string, botId: string, sessionId: string): ShortTermMemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM short_term_memories
         WHERE tenant_id = ? AND bot_id = ? AND session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(tenantId, botId, sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      sessionId: String(row.session_id),
      scope: "bot_private",
      category: String(row.category) as ShortMemoryCategory,
      content: String(row.content),
      ...(row.metadata_json ? { metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown> } : {}),
      createdAt: Number(row.created_at),
    }));
  }

  clearShortTermSession(tenantId: string, botId: string, sessionId: string): number {
    const result = this.db
      .prepare(`DELETE FROM short_term_memories WHERE tenant_id = ? AND bot_id = ? AND session_id = ?`)
      .run(tenantId, botId, sessionId);
    return Number(result.changes ?? 0);
  }

  // --- Medium-term memory ---

  insertMediumTerm(record: MediumTermMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO medium_term_memories (id, tenant_id, bot_id, scope, category, period_key, summary, highlights_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.botId,
        record.scope,
        record.category,
        record.periodKey,
        record.summary,
        JSON.stringify(record.highlights),
        record.createdAt,
      );
  }

  listMediumTerm(
    tenantId: string,
    botId: string,
    options: { category?: MediumMemoryCategory; periodKey?: string; query?: string } = {},
  ): MediumTermMemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM medium_term_memories
         WHERE tenant_id = ? AND (scope = 'user_shared' OR bot_id = ?)
         ORDER BY created_at DESC`,
      )
      .all(tenantId, botId) as Array<Record<string, unknown>>;
    const queryLower = options.query?.trim().toLowerCase() ?? "";
    return rows
      .map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        botId: String(row.bot_id),
        scope: String(row.scope) as MemoryScope,
        category: String(row.category) as MediumMemoryCategory,
        periodKey: String(row.period_key),
        summary: String(row.summary),
        highlights: JSON.parse(String(row.highlights_json)) as string[],
        createdAt: Number(row.created_at),
      }))
      .filter((item) => {
        if (options.category && item.category !== options.category) return false;
        if (options.periodKey && item.periodKey !== options.periodKey) return false;
        if (queryLower) {
          const hay = `${item.summary} ${item.highlights.join(" ")}`.toLowerCase();
          if (!hay.includes(queryLower)) return false;
        }
        return true;
      });
  }

  // --- Long-term memory ---

  upsertLongTerm(record: LongTermMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO long_term_memories (
           id, tenant_id, bot_id, scope, category, mem_key, content, structured_json,
           high_impact, source_trust, confirmed_by, confirmed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           structured_json = excluded.structured_json,
           confirmed_by = excluded.confirmed_by,
           confirmed_at = excluded.confirmed_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.tenantId,
        record.botId,
        record.scope,
        record.category,
        record.key,
        record.content,
        record.structured ? JSON.stringify(record.structured) : null,
        record.highImpact ? 1 : 0,
        record.sourceTrust,
        record.confirmedBy,
        record.confirmedAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  listLongTerm(
    tenantId: string,
    botId: string,
    options: { scope?: MemoryScope; category?: LongMemoryCategory } = {},
  ): LongTermMemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM long_term_memories
         WHERE tenant_id = ? AND (scope = 'user_shared' OR bot_id = ?)
         ORDER BY updated_at DESC`,
      )
      .all(tenantId, botId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        botId: row.bot_id === null ? null : String(row.bot_id),
        scope: String(row.scope) as MemoryScope,
        category: String(row.category) as LongMemoryCategory,
        key: String(row.mem_key),
        content: String(row.content),
        ...(row.structured_json ? { structured: JSON.parse(String(row.structured_json)) as Record<string, unknown> } : {}),
        highImpact: Number(row.high_impact) === 1,
        sourceTrust: String(row.source_trust) as MemorySourceTrust,
        confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
        confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }))
      .filter((item) => {
        if (options.scope && item.scope !== options.scope) return false;
        if (options.category && item.category !== options.category) return false;
        return true;
      });
  }

  // --- Pending confirmations & pollution ---

  insertPendingConfirmation(record: PendingMemoryConfirmation): void {
    this.db
      .prepare(
        `INSERT INTO pending_memory_confirmations (
           id, tenant_id, bot_id, scope, category, mem_key, content, source_trust,
           source_excerpt, reason, status, feishu_card_json, created_at, resolved_at, resolved_by, committed_memory_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.botId,
        record.scope,
        record.category,
        record.key,
        record.content,
        record.sourceTrust,
        record.sourceExcerpt,
        record.reason,
        record.status,
        JSON.stringify(record.feishuCard),
        record.createdAt,
        record.resolvedAt,
        record.resolvedBy,
        record.committedMemoryId,
      );
  }

  getPendingConfirmation(tenantId: string, id: string): PendingMemoryConfirmation | null {
    const row = this.db
      .prepare(`SELECT * FROM pending_memory_confirmations WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? this.mapPendingRow(row) : null;
  }

  listPendingConfirmations(tenantId: string, status?: PendingConfirmationStatus): PendingMemoryConfirmation[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM pending_memory_confirmations WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC`)
          .all(tenantId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM pending_memory_confirmations WHERE tenant_id = ? ORDER BY created_at DESC`)
          .all(tenantId) as Array<Record<string, unknown>>);
    return rows.map((row) => this.mapPendingRow(row));
  }

  resolvePendingConfirmation(
    tenantId: string,
    id: string,
    update: { status: PendingConfirmationStatus; resolvedAt: number; resolvedBy: string; committedMemoryId: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE pending_memory_confirmations
         SET status = ?, resolved_at = ?, resolved_by = ?, committed_memory_id = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(update.status, update.resolvedAt, update.resolvedBy, update.committedMemoryId, tenantId, id);
  }

  private mapPendingRow(row: Record<string, unknown>): PendingMemoryConfirmation {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      scope: String(row.scope) as MemoryScope,
      category: String(row.category) as LongMemoryCategory,
      key: String(row.mem_key),
      content: String(row.content),
      sourceTrust: String(row.source_trust) as MemorySourceTrust,
      sourceExcerpt: String(row.source_excerpt),
      reason: String(row.reason),
      status: String(row.status) as PendingConfirmationStatus,
      feishuCard: JSON.parse(String(row.feishu_card_json)),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
      committedMemoryId: row.committed_memory_id === null ? null : String(row.committed_memory_id),
    };
  }

  insertPollutionEvent(event: MemoryPollutionEvent): void {
    this.db
      .prepare(
        `INSERT INTO memory_pollution_events (id, tenant_id, run_id, source_kind, excerpt, matched_rule, disposition, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tenantId,
        event.runId,
        event.sourceKind,
        event.excerpt,
        event.matchedRule,
        event.disposition,
        event.recordedAt,
      );
  }

  listPollutionEvents(tenantId: string, limit = 50): MemoryPollutionEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_pollution_events WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT ?`)
      .all(tenantId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      runId: String(row.run_id),
      sourceKind: String(row.source_kind),
      excerpt: String(row.excerpt),
      matchedRule: String(row.matched_rule),
      disposition: String(row.disposition) as "dropped" | "queued_for_confirmation",
      recordedAt: Number(row.recorded_at),
    }));
  }

  // --- Dream token ledger ---

  recordDreamTokenUsage(
    tenantId: string,
    runId: string,
    dayKey: string,
    monthKey: string,
    usage: DreamTokenUsage,
    recordedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO dream_token_ledger (tenant_id, run_id, day_key, month_key, input_tokens, output_tokens, cost_usd, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, runId, dayKey, monthKey, usage.inputTokens, usage.outputTokens, usage.costUsd, recordedAt);
  }

  getDreamSpendSummary(tenantId: string, dayKey: string, monthKey: string): DreamSpendSummary {
    const dayRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost
         FROM dream_token_ledger WHERE tenant_id = ? AND day_key = ?`,
      )
      .get(tenantId, dayKey) as Record<string, unknown>;
    const monthRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS runs
         FROM dream_token_ledger WHERE tenant_id = ? AND month_key = ?`,
      )
      .get(tenantId, monthKey) as Record<string, unknown>;
    return {
      tenantId,
      dayKey,
      monthKey,
      dayTokens: Number(dayRow.tokens ?? 0),
      monthTokens: Number(monthRow.tokens ?? 0),
      dayCostUsd: Number(dayRow.cost ?? 0),
      monthCostUsd: Number(monthRow.cost ?? 0),
      runCount: Number(monthRow.runs ?? 0),
    };
  }

  // --- Workflow occurrences ---

  incrementWorkflowOccurrence(
    tenantId: string,
    workflowKey: string,
    workflowName: string,
    now: number,
  ): { occurrences: number; crystallizedSkillId: string | null } {
    this.db
      .prepare(
        `INSERT INTO workflow_occurrences (tenant_id, workflow_key, workflow_name, occurrences, last_seen_at, crystallized_skill_id)
         VALUES (?, ?, ?, 1, ?, NULL)
         ON CONFLICT(tenant_id, workflow_key) DO UPDATE SET
           workflow_name = excluded.workflow_name,
           occurrences = workflow_occurrences.occurrences + 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(tenantId, workflowKey, workflowName, now);
    const row = this.db
      .prepare(`SELECT occurrences, crystallized_skill_id FROM workflow_occurrences WHERE tenant_id = ? AND workflow_key = ?`)
      .get(tenantId, workflowKey) as Record<string, unknown>;
    return {
      occurrences: Number(row.occurrences ?? 1),
      crystallizedSkillId: row.crystallized_skill_id === null ? null : String(row.crystallized_skill_id),
    };
  }

  markWorkflowCrystallized(tenantId: string, workflowKey: string, skillId: string): void {
    this.db
      .prepare(`UPDATE workflow_occurrences SET crystallized_skill_id = ? WHERE tenant_id = ? AND workflow_key = ?`)
      .run(skillId, tenantId, workflowKey);
  }

  // --- Managed skills, core locks, versions & logs ---

  saveSkill(skill: ManagedSkill): void {
    this.db
      .prepare(
        `INSERT INTO managed_skills (
           id, tenant_id, name, description, trigger_phrases_json, spec_json,
           is_core, core_category, lifecycle, version, content_hash, usage_count,
           last_used_at, merged_into_skill_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           trigger_phrases_json = excluded.trigger_phrases_json,
           spec_json = excluded.spec_json,
           lifecycle = excluded.lifecycle,
           version = excluded.version,
           content_hash = excluded.content_hash,
           usage_count = excluded.usage_count,
           last_used_at = excluded.last_used_at,
           merged_into_skill_id = excluded.merged_into_skill_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        skill.id,
        skill.tenantId,
        skill.name,
        skill.description,
        JSON.stringify(skill.triggerPhrases),
        JSON.stringify(skill.spec),
        skill.isCore ? 1 : 0,
        skill.coreCategory,
        skill.lifecycle,
        skill.version,
        skill.contentHash,
        skill.usageCount,
        skill.lastUsedAt,
        skill.mergedIntoSkillId,
        skill.createdAt,
        skill.updatedAt,
      );
  }

  getSkill(tenantId: string, skillId: string): ManagedSkill | null {
    const row = this.db
      .prepare(`SELECT * FROM managed_skills WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, skillId) as Record<string, unknown> | undefined;
    return row ? this.mapSkillRow(row) : null;
  }

  listSkills(tenantId: string, options: { lifecycles?: readonly SkillLifecycleState[] } = {}): ManagedSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM managed_skills WHERE tenant_id = ? ORDER BY updated_at DESC`)
      .all(tenantId) as Array<Record<string, unknown>>;
    const skills = rows.map((row) => this.mapSkillRow(row));
    if (!options.lifecycles || options.lifecycles.length === 0) return skills;
    const allowed = new Set(options.lifecycles);
    return skills.filter((skill) => allowed.has(skill.lifecycle));
  }

  private mapSkillRow(row: Record<string, unknown>): ManagedSkill {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      description: String(row.description),
      triggerPhrases: JSON.parse(String(row.trigger_phrases_json)) as string[],
      spec: JSON.parse(String(row.spec_json)) as SkillSpec,
      isCore: Number(row.is_core) === 1,
      coreCategory: row.core_category === null ? null : (String(row.core_category) as CoreSkillCategory),
      lifecycle: String(row.lifecycle) as SkillLifecycleState,
      version: Number(row.version),
      contentHash: String(row.content_hash),
      usageCount: Number(row.usage_count),
      lastUsedAt: Number(row.last_used_at),
      mergedIntoSkillId: row.merged_into_skill_id === null ? null : String(row.merged_into_skill_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertCoreSkillLock(
    skillId: string,
    tenantId: string,
    coreCategory: CoreSkillCategory,
    expectedHash: string,
    updatedBy: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO core_skill_locks (skill_id, tenant_id, core_category, expected_hash, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           expected_hash = excluded.expected_hash,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(skillId, tenantId, coreCategory, expectedHash, updatedBy, updatedAt);
  }

  getCoreSkillLock(tenantId: string, skillId: string): { expectedHash: string; coreCategory: CoreSkillCategory } | null {
    const row = this.db
      .prepare(`SELECT expected_hash, core_category FROM core_skill_locks WHERE tenant_id = ? AND skill_id = ?`)
      .get(tenantId, skillId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      expectedHash: String(row.expected_hash),
      coreCategory: String(row.core_category) as CoreSkillCategory,
    };
  }

  insertSkillVersion(snapshot: SkillVersionSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions (
           id, tenant_id, skill_id, version, name, description, trigger_phrases_json,
           spec_json, content_hash, actor, actor_type, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.tenantId,
        snapshot.skillId,
        snapshot.version,
        snapshot.name,
        snapshot.description,
        JSON.stringify(snapshot.triggerPhrases),
        JSON.stringify(snapshot.spec),
        snapshot.contentHash,
        snapshot.actor,
        snapshot.actorType,
        snapshot.reason,
        snapshot.createdAt,
      );
  }

  listSkillVersions(tenantId: string, skillId: string): SkillVersionSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM skill_versions WHERE tenant_id = ? AND skill_id = ? ORDER BY version DESC`)
      .all(tenantId, skillId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      skillId: String(row.skill_id),
      version: Number(row.version),
      name: String(row.name),
      description: String(row.description),
      triggerPhrases: JSON.parse(String(row.trigger_phrases_json)) as string[],
      spec: JSON.parse(String(row.spec_json)) as SkillSpec,
      contentHash: String(row.content_hash),
      actor: String(row.actor),
      actorType: String(row.actor_type) as "agent" | "human" | "curator",
      reason: String(row.reason),
      createdAt: Number(row.created_at),
    }));
  }

  insertSkillChangeLog(entry: SkillChangeLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO skill_change_logs (id, tenant_id, skill_id, action, from_version, to_version, actor, actor_type, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.skillId,
        entry.action,
        entry.fromVersion,
        entry.toVersion,
        entry.actor,
        entry.actorType,
        entry.summary,
        entry.createdAt,
      );
  }

  listSkillChangeLogs(tenantId: string, skillId?: string): SkillChangeLogEntry[] {
    const rows = skillId
      ? (this.db
          .prepare(`SELECT * FROM skill_change_logs WHERE tenant_id = ? AND skill_id = ? ORDER BY created_at DESC`)
          .all(tenantId, skillId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM skill_change_logs WHERE tenant_id = ? ORDER BY created_at DESC`)
          .all(tenantId) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      skillId: String(row.skill_id),
      action: String(row.action) as SkillChangeLogEntry["action"],
      fromVersion: row.from_version === null ? null : Number(row.from_version),
      toVersion: Number(row.to_version),
      actor: String(row.actor),
      actorType: String(row.actor_type) as "agent" | "human" | "curator",
      summary: String(row.summary),
      createdAt: Number(row.created_at),
    }));
  }

  insertSkillLockDenial(record: SkillLockDenialRecord): void {
    this.db
      .prepare(
        `INSERT INTO skill_lock_denials (id, tenant_id, skill_id, skill_name, core_category, actor, reason, expected_hash, actual_hash, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.skillId,
        record.skillName,
        record.coreCategory,
        record.actor,
        record.reason,
        record.expectedHash,
        record.actualHash,
        record.recordedAt,
      );
  }

  listSkillLockDenials(tenantId: string, limit = 50): SkillLockDenialRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM skill_lock_denials WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT ?`)
      .all(tenantId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      skillId: String(row.skill_id),
      skillName: String(row.skill_name),
      coreCategory: String(row.core_category) as CoreSkillCategory,
      actor: String(row.actor),
      reason: String(row.reason),
      expectedHash: String(row.expected_hash),
      actualHash: row.actual_hash === null ? null : String(row.actual_hash),
      recordedAt: Number(row.recorded_at),
    }));
  }
}
