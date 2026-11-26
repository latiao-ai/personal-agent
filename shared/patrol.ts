/** Public control-plane contracts for MVP4 read-only patrol (add-readonly-patrol). */

import type { ApprovalEvaluationResult } from "./approvals.ts";
import type { Ticket } from "./tickets.ts";

export type PatrolDataCategory =
  | "inventory"
  | "orders"
  | "price"
  | "logistics"
  | "supplier_reply"
  | "hot_product";

/** Strict read-only tool allowlist for every patrol Ticket Mandate. Write/message/payment/browser tools are never permitted. */
export const PATROL_READ_ONLY_TOOL_ALLOWLIST = [
  "patrol_read_inventory",
  "patrol_read_orders",
  "patrol_read_price",
  "patrol_read_logistics",
  "patrol_read_supplier_reply",
  "patrol_read_hot_product",
] as const;

export type PatrolReadOnlyToolName = (typeof PATROL_READ_ONLY_TOOL_ALLOWLIST)[number];

/** Canonical inventory item (minimal Ontology starter fields, unit: pieces). */
export interface CanonicalInventoryItem {
  sku: string;
  available_quantity: number;
  warehouse: string;
  checked_at: string;
  /** Control-plane safety stock threshold in pieces (optional; falls back to engine policy). */
  safety_stock?: number;
  source_platform?: string;
  /** Optional untrusted platform note (e.g. memo/remark); never trusted as instructions. */
  raw_note?: string;
}

/** Canonical order status values mapped from platform-specific status codes in control plane. */
export type CanonicalOrderStatus =
  | "pending_payment"
  | "paid_unshipped"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

export interface CanonicalOrderSkuLine {
  sku: string;
  quantity: number;
}

/** Canonical order item (minimal Ontology starter fields). */
export interface CanonicalOrderItem {
  order_id: string;
  status: CanonicalOrderStatus;
  paid_at: string;
  amount: number;
  currency?: string;
  sku_list: CanonicalOrderSkuLine[];
  checked_at?: string;
  source_platform?: string;
  /** Optional untrusted platform buyer/seller remark; never trusted as instructions. */
  raw_note?: string;
}

/** Stub canonical interfaces for the 4 deferred categories (no real platform connectors in MVP4). */
export interface CanonicalPriceSignal {
  sku: string;
  price: number;
  currency: string;
  checked_at: string;
  source_platform?: string;
}

export interface CanonicalLogisticsSignal {
  tracking_no: string;
  order_id: string;
  status: string;
  checked_at: string;
  source_platform?: string;
}

export interface CanonicalSupplierReplySignal {
  supplier_id: string;
  thread_id: string;
  summary: string;
  received_at: string;
}

export interface CanonicalHotProductSignal {
  sku: string;
  score: number;
  checked_at: string;
  source_platform?: string;
}

export type PatrolSeverity = "ok" | "minor" | "major";

export type PatrolTriggerKind = "scheduled" | "manual" | "order_event";

export type PatrolRunStatus =
  | "completed"
  | "skipped_overlap"
  | "timed_out"
  | "failed";

export interface PatrolInventoryEvidence {
  kind: "inventory_low" | "inventory_near_threshold";
  sku: string;
  available_quantity: number;
  safety_stock: number;
  shortage: number;
  warehouse: string;
  checked_at: string;
}

export interface PatrolOrderEvidence {
  kind: "new_order" | "order_paid_unshipped_overdue";
  order_id: string;
  status: CanonicalOrderStatus;
  paid_at: string;
  amount: number;
  sku_list: CanonicalOrderSkuLine[];
  overdue_hours?: number;
}

export type PatrolEvidence = PatrolInventoryEvidence | PatrolOrderEvidence;

export interface PatrolFinding {
  id: string;
  runId: string;
  category: PatrolDataCategory;
  severity: Exclude<PatrolSeverity, "ok">;
  summary: string;
  evidence: PatrolEvidence;
  /** Populated only when severity === "major" and escalated to TicketEngine. */
  executionTicketId: string | null;
  /** Populated only when escalated execution Ticket is evaluated by ApprovalEngine. */
  approvalDecision: ApprovalEvaluationResult["decision"] | null;
  approvalCardId: string | null;
  createdAt: number;
}

export interface PatrolToolDenialRecord {
  id: string;
  runId: string;
  patrolTicketId: string;
  toolName: string;
  attemptedArgs: Record<string, unknown>;
  reason: string;
  blockedAt: number;
}

export interface PatrolTokenUsage {
  smallModelCalls: number;
  largeModelCalls: number;
  smallModelTokens: number;
  largeModelTokens: number;
  /** Separate patrol token cost accounting (USD), isolated from MVP2b work token budget. */
  patrolTokenCostUsd: number;
  cacheHit: boolean;
  incrementalSkipped: number;
}

export interface PatrolDailyDigest {
  dayKey: string;
  entries: Array<{
    findingId: string;
    runId: string;
    category: PatrolDataCategory;
    summary: string;
    evidence: PatrolEvidence;
    recordedAt: number;
  }>;
  /** Non-null once the single daily digest for this day has been marked dispatched. */
  dispatchedAt: number | null;
  dispatchCount: number;
  updatedAt: number;
}

export interface PatrolRunRecord {
  id: string;
  tenantId: string;
  trigger: PatrolTriggerKind;
  status: PatrolRunStatus;
  severity: PatrolSeverity;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  patrolTicketId: string | null;
  patrolMandateAllowlist: string[];
  summary: string;
  findings: PatrolFinding[];
  escalatedTickets: Ticket[];
  deniedToolCalls: PatrolToolDenialRecord[];
  digestUpdated: boolean;
  digestDayKey: string | null;
  tokenUsage: PatrolTokenUsage;
  reason?: string;
}

export interface PatrolSpendSummary {
  dayKey: string;
  monthKey: string;
  daySmallTokens: number;
  dayLargeTokens: number;
  dayCostUsd: number;
  monthSmallTokens: number;
  monthLargeTokens: number;
  monthCostUsd: number;
  totalRuns: number;
  cacheHits: number;
}
