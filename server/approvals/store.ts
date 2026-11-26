import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ActionCategory,
  ApprovalAuditRecord,
  ApprovalButtonAction,
  ApprovalCard,
  ApprovalCardStatus,
  DualBudgetPolicy,
} from "../../shared/approvals.ts";
import { DEFAULT_DUAL_BUDGET_POLICY, type SpendTotals } from "./budget.ts";

/**
 * Control-plane SQLite persistence for approval cards, scoped always-allow rules,
 * dual-dimension budget policies/ledger, and immutable approval audit logs.
 */
export class ApprovalStore {
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
      CREATE TABLE IF NOT EXISTS approval_cards (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        initiator TEXT NOT NULL,
        approver_open_id TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        action_category TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        recipient TEXT NOT NULL,
        risk_summary TEXT NOT NULL,
        token_cost REAL NOT NULL,
        business_cost REAL NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_action TEXT,
        feishu_card_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_cards_ticket ON approval_cards(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_approval_cards_status ON approval_cards(status);

      CREATE TABLE IF NOT EXISTS always_allow_rules (
        rule_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        initiator TEXT NOT NULL,
        action_category TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        max_business_limit REAL NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_policies (
        tenant_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_ledger (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        token_cost REAL NOT NULL,
        business_cost REAL NOT NULL,
        currency TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budget_ledger_tenant_day ON budget_ledger(tenant_id, day_key);
      CREATE INDEX IF NOT EXISTS idx_budget_ledger_tenant_month ON budget_ledger(tenant_id, month_key);

      CREATE TABLE IF NOT EXISTS approval_audit_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        ticket_id TEXT,
        card_id TEXT,
        approver_open_id TEXT,
        actor TEXT NOT NULL,
        mandate_summary TEXT NOT NULL,
        action TEXT NOT NULL,
        tier INTEGER NOT NULL,
        decision TEXT NOT NULL,
        token_cost REAL NOT NULL,
        business_cost REAL NOT NULL,
        currency TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_audit_ticket ON approval_audit_log(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_approval_audit_at ON approval_audit_log(at);
    `);
  }

  insertCard(card: ApprovalCard): void {
    this.db
      .prepare(
        `INSERT INTO approval_cards (
          id, ticket_id, tenant_id, initiator, approver_open_id,
          action_summary, action_category, tool_name, recipient, risk_summary,
          token_cost, business_cost, currency, status,
          created_at, expires_at, decided_at, decided_by, decision_action, feishu_card_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.id,
        card.ticketId,
        card.tenantId,
        card.initiator,
        card.approverOpenId,
        card.actionSummary,
        card.actionCategory,
        card.toolName,
        card.recipient,
        card.riskSummary,
        card.tokenCost,
        card.businessCost,
        card.currency,
        card.status,
        card.createdAt,
        card.expiresAt,
        card.decidedAt,
        card.decidedBy,
        card.decisionAction,
        JSON.stringify(card.feishuCardPayload),
      );
  }

  getCard(cardId: string): ApprovalCard | null {
    const row = this.db
      .prepare(`SELECT * FROM approval_cards WHERE id = ?`)
      .get(cardId) as Record<string, unknown> | undefined;
    return row ? rowToCard(row) : null;
  }

  listCards(limit = 100): ApprovalCard[] {
    const rows = this.db
      .prepare(`SELECT * FROM approval_cards ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToCard);
  }

  /** Atomically transitions a pending card so duplicate clicks can never execute twice. */
  transitionPendingCard(
    cardId: string,
    nextStatus: Exclude<ApprovalCardStatus, "pending">,
    decidedAt: number,
    decidedBy: string | null,
    decisionAction: ApprovalButtonAction | null,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approval_cards
         SET status = ?, decided_at = ?, decided_by = ?, decision_action = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(nextStatus, decidedAt, decidedBy, decisionAction, cardId);
    return Number(result.changes) > 0;
  }

  saveAlwaysAllowRule(rule: {
    tenantId: string;
    initiator: string;
    actionCategory: ActionCategory;
    toolName: string;
    maxBusinessLimit: number;
    createdBy: string;
    createdAt: number;
  }): void {
    const key = `${rule.tenantId}:${rule.initiator}:${rule.actionCategory}:${rule.toolName}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO always_allow_rules (
          rule_key, tenant_id, initiator, action_category, tool_name, max_business_limit, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        rule.tenantId,
        rule.initiator,
        rule.actionCategory,
        rule.toolName,
        rule.maxBusinessLimit,
        rule.createdBy,
        rule.createdAt,
      );
  }

  matchesAlwaysAllow(input: {
    tenantId: string;
    initiator: string;
    actionCategory: ActionCategory;
    toolName: string;
    businessCost: number;
  }): boolean {
    const key = `${input.tenantId}:${input.initiator}:${input.actionCategory}:${input.toolName}`;
    const row = this.db
      .prepare(`SELECT max_business_limit FROM always_allow_rules WHERE rule_key = ?`)
      .get(key) as { max_business_limit: number } | undefined;
    if (!row) return false;
    return input.businessCost <= Number(row.max_business_limit);
  }

  setBudgetPolicy(tenantId: string, policy: DualBudgetPolicy, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO budget_policies (tenant_id, policy_json, updated_at) VALUES (?, ?, ?)`,
      )
      .run(tenantId, JSON.stringify(policy), updatedAt);
  }

  getBudgetPolicy(tenantId: string): DualBudgetPolicy {
    const row = this.db
      .prepare(`SELECT policy_json FROM budget_policies WHERE tenant_id = ?`)
      .get(tenantId) as { policy_json: string } | undefined;
    return row ? (JSON.parse(row.policy_json) as DualBudgetPolicy) : { ...DEFAULT_DUAL_BUDGET_POLICY };
  }

  recordSpend(entry: {
    id: string;
    tenantId: string;
    ticketId: string;
    dayKey: string;
    monthKey: string;
    tokenCost: number;
    businessCost: number;
    currency: string;
    recordedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO budget_ledger (
          id, tenant_id, ticket_id, day_key, month_key, token_cost, business_cost, currency, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.ticketId,
        entry.dayKey,
        entry.monthKey,
        entry.tokenCost,
        entry.businessCost,
        entry.currency,
        entry.recordedAt,
      );
  }

  getSpendTotals(tenantId: string, dayKey: string, monthKey: string): SpendTotals {
    const day = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_cost), 0) AS tok, COALESCE(SUM(business_cost), 0) AS biz
         FROM budget_ledger WHERE tenant_id = ? AND day_key = ?`,
      )
      .get(tenantId, dayKey) as { tok: number; biz: number };
    const month = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_cost), 0) AS tok, COALESCE(SUM(business_cost), 0) AS biz
         FROM budget_ledger WHERE tenant_id = ? AND month_key = ?`,
      )
      .get(tenantId, monthKey) as { tok: number; biz: number };
    return {
      tokenDay: Number(day.tok),
      businessDay: Number(day.biz),
      tokenMonth: Number(month.tok),
      businessMonth: Number(month.biz),
    };
  }

  appendAudit(record: ApprovalAuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO approval_audit_log (
          id, at, tenant_id, ticket_id, card_id, approver_open_id, actor,
          mandate_summary, action, tier, decision, token_cost, business_cost, currency, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.at,
        record.tenantId,
        record.ticketId,
        record.cardId,
        record.approverOpenId,
        record.actor,
        record.mandateSummary,
        record.action,
        record.tier,
        record.decision,
        record.tokenCost,
        record.businessCost,
        record.currency,
        record.reason,
      );
  }

  listAudit(filter?: { ticketId?: string; approverOpenId?: string; limit?: number }): ApprovalAuditRecord[] {
    const limit = filter?.limit ?? 100;
    let rows: Record<string, unknown>[];
    if (filter?.ticketId) {
      rows = this.db
        .prepare(`SELECT * FROM approval_audit_log WHERE ticket_id = ? ORDER BY at DESC LIMIT ?`)
        .all(filter.ticketId, limit) as Record<string, unknown>[];
    } else if (filter?.approverOpenId) {
      rows = this.db
        .prepare(`SELECT * FROM approval_audit_log WHERE approver_open_id = ? ORDER BY at DESC LIMIT ?`)
        .all(filter.approverOpenId, limit) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM approval_audit_log ORDER BY at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
    }
    return rows.map((row) => ({
      id: String(row.id),
      at: Number(row.at),
      tenantId: String(row.tenant_id),
      ticketId: row.ticket_id ? String(row.ticket_id) : null,
      cardId: row.card_id ? String(row.card_id) : null,
      approverOpenId: row.approver_open_id ? String(row.approver_open_id) : null,
      actor: String(row.actor),
      mandateSummary: String(row.mandate_summary),
      action: String(row.action),
      tier: Number(row.tier) as ApprovalAuditRecord["tier"],
      decision: row.decision as ApprovalAuditRecord["decision"],
      tokenCost: Number(row.token_cost),
      businessCost: Number(row.business_cost),
      currency: String(row.currency),
      reason: String(row.reason),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToCard(row: Record<string, unknown>): ApprovalCard {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    tenantId: String(row.tenant_id),
    initiator: String(row.initiator),
    approverOpenId: String(row.approver_open_id),
    actionSummary: String(row.action_summary),
    actionCategory: row.action_category as ApprovalCard["actionCategory"],
    toolName: String(row.tool_name),
    recipient: String(row.recipient),
    riskSummary: String(row.risk_summary),
    tokenCost: Number(row.token_cost),
    businessCost: Number(row.business_cost),
    currency: String(row.currency),
    status: row.status as ApprovalCard["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at !== null && row.decided_at !== undefined ? Number(row.decided_at) : null,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decisionAction: row.decision_action ? (row.decision_action as ApprovalCard["decisionAction"]) : null,
    feishuCardPayload: JSON.parse(String(row.feishu_card_json)) as Record<string, unknown>,
  };
}
