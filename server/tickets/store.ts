import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Ticket, TicketAuditEntry } from "../../shared/tickets.ts";

/**
 * Control-plane SQLite persistence for tickets, deduplication receipts, and audit logs.
 * During development this resides in a standalone SQLite file owned by the harness (`tickets.sqlite`)
 * with 0600 permissions; VM agents must never access this file directly.
 */
export class TicketStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.path = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Ignore on filesystems that do not support POSIX chmod.
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        initiator TEXT NOT NULL,
        mandate_json TEXT NOT NULL,
        mandate_hash TEXT NOT NULL,
        tool_allowlist_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        event_id TEXT,
        dedupe_key TEXT NOT NULL,
        thread_id TEXT,
        bot_id TEXT,
        raw_text TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_dedupe ON tickets(dedupe_key);

      CREATE TABLE IF NOT EXISTS ticket_receipts (
        dedupe_key TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        event_id TEXT,
        accepted_at INTEGER NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_receipts_accepted ON ticket_receipts(accepted_at);

      CREATE TABLE IF NOT EXISTS ticket_audit_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        ticket_id TEXT,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_audit_ticket ON ticket_audit_log(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_ticket_audit_at ON ticket_audit_log(at);
    `);
  }

  insertTicketWithReceipt(ticket: Ticket, acceptedAt: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO tickets (
            id, created_at, updated_at, source, initiator,
            mandate_json, mandate_hash, tool_allowlist_json, budget_json,
            status, parent_id, event_id, dedupe_key, thread_id, bot_id, raw_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticket.id,
          ticket.createdAt,
          ticket.updatedAt,
          ticket.source,
          ticket.initiator,
          JSON.stringify(ticket.mandate),
          ticket.mandateHash,
          JSON.stringify(ticket.toolAllowlist),
          JSON.stringify(ticket.budget),
          ticket.status,
          ticket.parentId,
          ticket.eventId,
          ticket.dedupeKey,
          ticket.threadId ?? null,
          ticket.botId ?? null,
          ticket.rawText ?? null,
        );
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ticket_receipts (dedupe_key, ticket_id, event_id, accepted_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(ticket.dedupeKey, ticket.id, ticket.eventId, acceptedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  supersedeAndInsert(oldTicketId: string, nextTicket: Ticket, updatedAt: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(`UPDATE tickets SET status = 'superseded', updated_at = ? WHERE id = ?`)
        .run(updatedAt, oldTicketId);
      if (result.changes === 0) {
        throw new Error(`Ticket not found: ${oldTicketId}`);
      }
      this.db
        .prepare(
          `INSERT INTO tickets (
            id, created_at, updated_at, source, initiator,
            mandate_json, mandate_hash, tool_allowlist_json, budget_json,
            status, parent_id, event_id, dedupe_key, thread_id, bot_id, raw_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextTicket.id,
          nextTicket.createdAt,
          nextTicket.updatedAt,
          nextTicket.source,
          nextTicket.initiator,
          JSON.stringify(nextTicket.mandate),
          nextTicket.mandateHash,
          JSON.stringify(nextTicket.toolAllowlist),
          JSON.stringify(nextTicket.budget),
          nextTicket.status,
          nextTicket.parentId,
          nextTicket.eventId,
          nextTicket.dedupeKey,
          nextTicket.threadId ?? null,
          nextTicket.botId ?? null,
          nextTicket.rawText ?? null,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTicket(row) : null;
  }

  listTickets(limit = 100): Ticket[] {
    const rows = this.db
      .prepare(`SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToTicket);
  }

  findReceipt(dedupeKey: string, minAcceptedAt: number): { ticketId: string; acceptedAt: number } | null {
    const row = this.db
      .prepare(`SELECT ticket_id, accepted_at FROM ticket_receipts WHERE dedupe_key = ? AND accepted_at >= ?`)
      .get(dedupeKey, minAcceptedAt) as { ticket_id: string; accepted_at: number } | undefined;
    return row ? { ticketId: row.ticket_id, acceptedAt: row.accepted_at } : null;
  }

  pruneOldReceipts(minAcceptedAt: number): void {
    this.db.prepare(`DELETE FROM ticket_receipts WHERE accepted_at < ?`).run(minAcceptedAt);
  }

  appendAudit(entry: TicketAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO ticket_audit_log (id, at, action, ticket_id, actor, source, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.at,
        entry.action,
        entry.ticketId,
        entry.actor,
        entry.source,
        JSON.stringify(entry.detail),
      );
  }

  listAudit(ticketId?: string, limit = 100): TicketAuditEntry[] {
    const rows = ticketId
      ? (this.db
          .prepare(`SELECT * FROM ticket_audit_log WHERE ticket_id = ? ORDER BY at DESC LIMIT ?`)
          .all(ticketId, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM ticket_audit_log ORDER BY at DESC LIMIT ?`)
          .all(limit) as Record<string, unknown>[]);
    return rows.map((row) => ({
      id: String(row.id),
      at: Number(row.at),
      action: row.action as TicketAuditEntry["action"],
      ticketId: row.ticket_id ? String(row.ticket_id) : null,
      actor: String(row.actor),
      source: row.source as TicketAuditEntry["source"],
      detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    source: row.source as Ticket["source"],
    initiator: String(row.initiator),
    mandate: JSON.parse(String(row.mandate_json)) as Ticket["mandate"],
    mandateHash: String(row.mandate_hash),
    toolAllowlist: JSON.parse(String(row.tool_allowlist_json)) as string[],
    budget: JSON.parse(String(row.budget_json)) as Ticket["budget"],
    status: row.status as Ticket["status"],
    parentId: row.parent_id ? String(row.parent_id) : null,
    eventId: row.event_id ? String(row.event_id) : null,
    dedupeKey: String(row.dedupe_key),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.bot_id ? { botId: String(row.bot_id) } : {}),
    ...(row.raw_text !== null && row.raw_text !== undefined ? { rawText: String(row.raw_text) } : {}),
  };
}
