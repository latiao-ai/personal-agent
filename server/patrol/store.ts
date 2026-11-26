import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  PatrolDailyDigest,
  PatrolDataCategory,
  PatrolEvidence,
  PatrolRunRecord,
  PatrolSpendSummary,
  PatrolTokenUsage,
  PatrolToolDenialRecord,
} from "../../shared/patrol.ts";

export interface PatrolWatermark {
  tenantId: string;
  lastCheckedAt: string | null;
  lastSnapshotHash: string | null;
  lastSummary: string | null;
  updatedAt: number;
}

/**
 * Control-plane SQLite persistence for MVP4 read-only patrol (`patrol.sqlite`).
 * Stores patrol run logs, daily digests (1/day), incremental watermarks + summary cache,
 * tool-layer permission denials, and separate patrol token spend ledger.
 */
export class PatrolStore {
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

      CREATE TABLE IF NOT EXISTS patrol_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patrol_daily_digests (
        tenant_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        dispatched_at INTEGER,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, day_key)
      );

      CREATE TABLE IF NOT EXISTS patrol_watermarks (
        tenant_id TEXT PRIMARY KEY,
        last_checked_at TEXT,
        last_snapshot_hash TEXT,
        last_summary TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patrol_tool_denials (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        patrol_ticket_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        attempted_args_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        blocked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patrol_token_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        small_tokens INTEGER NOT NULL,
        large_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL
      );
    `);
  }

  saveRun(record: PatrolRunRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO patrol_runs (id, tenant_id, trigger_kind, status, severity, started_at, finished_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.trigger,
        record.status,
        record.severity,
        record.startedAt,
        record.finishedAt,
        JSON.stringify(record),
      );
  }

  listRuns(limit = 50, tenantId?: string): PatrolRunRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = tenantId
      ? (this.db
          .prepare(
            `SELECT record_json FROM patrol_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?`,
          )
          .all(tenantId, safeLimit) as Array<{ record_json: string }>)
      : (this.db
          .prepare(`SELECT record_json FROM patrol_runs ORDER BY started_at DESC LIMIT ?`)
          .all(safeLimit) as Array<{ record_json: string }>);
    return rows.map((row) => JSON.parse(row.record_json) as PatrolRunRecord);
  }

  saveToolDenial(denial: PatrolToolDenialRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO patrol_tool_denials (id, run_id, patrol_ticket_id, tool_name, attempted_args_json, reason, blocked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        denial.id,
        denial.runId,
        denial.patrolTicketId,
        denial.toolName,
        JSON.stringify(denial.attemptedArgs),
        denial.reason,
        denial.blockedAt,
      );
  }

  listToolDenials(limit = 100): PatrolToolDenialRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(`SELECT * FROM patrol_tool_denials ORDER BY blocked_at DESC LIMIT ?`)
      .all(safeLimit) as Array<{
      id: string;
      run_id: string;
      patrol_ticket_id: string;
      tool_name: string;
      attempted_args_json: string;
      reason: string;
      blocked_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      patrolTicketId: row.patrol_ticket_id,
      toolName: row.tool_name,
      attemptedArgs: JSON.parse(row.attempted_args_json) as Record<string, unknown>,
      reason: row.reason,
      blockedAt: row.blocked_at,
    }));
  }

  getWatermark(tenantId: string): PatrolWatermark | null {
    const row = this.db
      .prepare(`SELECT * FROM patrol_watermarks WHERE tenant_id = ?`)
      .get(tenantId) as
      | {
          tenant_id: string;
          last_checked_at: string | null;
          last_snapshot_hash: string | null;
          last_summary: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      lastCheckedAt: row.last_checked_at,
      lastSnapshotHash: row.last_snapshot_hash,
      lastSummary: row.last_summary,
      updatedAt: row.updated_at,
    };
  }

  saveWatermark(watermark: PatrolWatermark): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO patrol_watermarks (tenant_id, last_checked_at, last_snapshot_hash, last_summary, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        watermark.tenantId,
        watermark.lastCheckedAt,
        watermark.lastSnapshotHash,
        watermark.lastSummary,
        watermark.updatedAt,
      );
  }

  getDailyDigest(tenantId: string, dayKey: string): PatrolDailyDigest | null {
    const row = this.db
      .prepare(`SELECT * FROM patrol_daily_digests WHERE tenant_id = ? AND day_key = ?`)
      .get(tenantId, dayKey) as
      | {
          day_key: string;
          entries_json: string;
          dispatched_at: number | null;
          dispatch_count: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      dayKey: row.day_key,
      entries: JSON.parse(row.entries_json) as PatrolDailyDigest["entries"],
      dispatchedAt: row.dispatched_at,
      dispatchCount: row.dispatch_count,
      updatedAt: row.updated_at,
    };
  }

  appendDailyDigestEntry(
    tenantId: string,
    dayKey: string,
    entry: {
      findingId: string;
      runId: string;
      category: PatrolDataCategory;
      summary: string;
      evidence: PatrolEvidence;
      recordedAt: number;
    },
  ): PatrolDailyDigest {
    const existing = this.getDailyDigest(tenantId, dayKey);
    const entries = existing ? [...existing.entries] : [];
    const dedupeSig = JSON.stringify([entry.category, entry.evidence]);
    const alreadyExists = entries.some(
      (item) => JSON.stringify([item.category, item.evidence]) === dedupeSig,
    );
    if (!alreadyExists) {
      entries.push(entry);
    }
    const dispatchedAt = existing?.dispatchedAt ?? null;
    const dispatchCount = existing?.dispatchCount ?? 0;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO patrol_daily_digests (tenant_id, day_key, entries_json, dispatched_at, dispatch_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        dayKey,
        JSON.stringify(entries),
        dispatchedAt,
        dispatchCount,
        entry.recordedAt,
      );
    return {
      dayKey,
      entries,
      dispatchedAt,
      dispatchCount,
      updatedAt: entry.recordedAt,
    };
  }

  /** Marks a daily digest as dispatched at most once per day (enforces "一天一次"). */
  markDailyDigestDispatched(
    tenantId: string,
    dayKey: string,
    nowMs: number,
  ): { dispatched: boolean; digest: PatrolDailyDigest | null } {
    const existing = this.getDailyDigest(tenantId, dayKey);
    if (!existing || existing.entries.length === 0) {
      return { dispatched: false, digest: existing };
    }
    if (existing.dispatchedAt !== null) {
      return { dispatched: false, digest: existing };
    }
    this.db
      .prepare(
        `UPDATE patrol_daily_digests
         SET dispatched_at = ?, dispatch_count = dispatch_count + 1, updated_at = ?
         WHERE tenant_id = ? AND day_key = ?`,
      )
      .run(nowMs, nowMs, tenantId, dayKey);
    return {
      dispatched: true,
      digest: this.getDailyDigest(tenantId, dayKey),
    };
  }

  recordTokenUsage(
    tenantId: string,
    runId: string,
    dayKey: string,
    monthKey: string,
    usage: PatrolTokenUsage,
    recordedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO patrol_token_ledger (tenant_id, run_id, day_key, month_key, small_tokens, large_tokens, cost_usd, cache_hit, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        runId,
        dayKey,
        monthKey,
        usage.smallModelTokens,
        usage.largeModelTokens,
        usage.patrolTokenCostUsd,
        usage.cacheHit ? 1 : 0,
        recordedAt,
      );
  }

  getSpendSummary(tenantId: string, dayKey: string, monthKey: string): PatrolSpendSummary {
    const dayRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(small_tokens), 0) AS small_tokens,
                COALESCE(SUM(large_tokens), 0) AS large_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM patrol_token_ledger
         WHERE tenant_id = ? AND day_key = ?`,
      )
      .get(tenantId, dayKey) as { small_tokens: number; large_tokens: number; cost_usd: number };

    const monthRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(small_tokens), 0) AS small_tokens,
                COALESCE(SUM(large_tokens), 0) AS large_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) AS total_runs,
                COALESCE(SUM(cache_hit), 0) AS cache_hits
         FROM patrol_token_ledger
         WHERE tenant_id = ? AND month_key = ?`,
      )
      .get(tenantId, monthKey) as {
      small_tokens: number;
      large_tokens: number;
      cost_usd: number;
      total_runs: number;
      cache_hits: number;
    };

    return {
      dayKey,
      monthKey,
      daySmallTokens: Number(dayRow.small_tokens ?? 0),
      dayLargeTokens: Number(dayRow.large_tokens ?? 0),
      dayCostUsd: Number(Number(dayRow.cost_usd ?? 0).toFixed(6)),
      monthSmallTokens: Number(monthRow.small_tokens ?? 0),
      monthLargeTokens: Number(monthRow.large_tokens ?? 0),
      monthCostUsd: Number(Number(monthRow.cost_usd ?? 0).toFixed(6)),
      totalRuns: Number(monthRow.total_runs ?? 0),
      cacheHits: Number(monthRow.cache_hits ?? 0),
    };
  }

  close(): void {
    this.db.close();
  }
}
