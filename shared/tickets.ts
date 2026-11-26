/** Public control-plane ticket and immutable mandate contracts (MVP2a). */

export type TicketSource =
  | "feishu_dm"
  | "feishu_group"
  | "new_order"
  | "inventory_change"
  | "webhook"
  | "patrol";

export type TicketStatus =
  | "observe"
  | "ready"
  | "executing"
  | "done"
  | "superseded"
  | "cancelled";

/** Dual budget ceiling: model token cost and business spend are tracked separately. */
export interface TicketBudgetLimit {
  /** Model token budget cap (in USD or workspace credit units). */
  tokenLimit: number;
  /** Business transaction spend cap (e.g. purchase/order amount). */
  businessLimit: number;
  /** Optional currency code for businessLimit, e.g. "CNY" or "USD". */
  currency?: string;
}

/** Immutable mandate attached to a ticket. Any change creates a new ticket with parentId. */
export interface TicketMandate {
  goal: string;
  scope: string;
  toolAllowlist: string[];
  budgetLimit: TicketBudgetLimit;
  /** Epoch milliseconds after which the mandate expires. */
  validUntil: number;
  initiator: string;
  /** Populated during MVP2b approval; null while pending approval. */
  approver: string | null;
}

/** Signed read-only mandate snapshot handed to an agent inside a user VM. */
export interface SignedMandateCopy {
  ticketId: string;
  mandate: Readonly<TicketMandate>;
  mandateHash: string;
  signature: string;
  readonly: true;
  issuedAt: number;
}

/** Control-plane ticket record; only TicketEngine writes this record. */
export interface Ticket {
  id: string;
  createdAt: number;
  updatedAt: number;
  source: TicketSource;
  initiator: string;
  mandate: TicketMandate;
  mandateHash: string;
  toolAllowlist: string[];
  budget: TicketBudgetLimit;
  status: TicketStatus;
  parentId: string | null;
  eventId: string | null;
  dedupeKey: string;
  threadId?: string;
  botId?: string;
  rawText?: string;
}

/** Trigger intake payload sent by Feishu gateway, external events, or mid-conversation hooks. */
export interface TicketIntakeInput {
  source: TicketSource;
  initiator: string;
  text: string;
  /** Platform or webhook event id when available (e.g. Feishu event_id). */
  eventId?: string;
  /** Optional scope override; defaults to source-appropriate scope. */
  scope?: string;
  /** Optional tool allowlist override; defaults to safe minimal list. */
  toolAllowlist?: string[];
  /** Optional budget override; defaults to conservative limits. */
  budget?: Partial<TicketBudgetLimit>;
  /** Optional validity duration in ms (defaults to 24h). */
  validForMs?: number;
  /** Explicit flag when a conversation turns into a side-effect action mid-thread. */
  midConversationSideEffect?: boolean;
  /** Optional conversation thread and bot references. */
  threadId?: string;
  botId?: string;
  /** Optional structured payload for external events. */
  payload?: Record<string, unknown>;
}

export type TicketIntakeDecision =
  | {
      outcome: "created";
      ticket: Ticket;
      /** True when the caller should proceed with normal chat reply (whitelisted DM). */
      replyNormally: boolean;
      observeOnly: boolean;
    }
  | {
      outcome: "duplicate";
      ticket: Ticket;
      dedupeKey: string;
      replyNormally: boolean;
      observeOnly: boolean;
    }
  | {
      outcome: "conversation";
      reason: string;
      replyNormally: true;
      observeOnly: false;
    }
  | {
      outcome: "denied";
      reason: "not_whitelisted";
      replyNormally: false;
      observeOnly: false;
    };

export type TicketAuditAction =
  | "ticket_created"
  | "ticket_deduplicated"
  | "intake_denied"
  | "conversation_bypassed"
  | "mandate_revised"
  | "mandate_mutation_denied";

export interface TicketAuditEntry {
  id: string;
  at: number;
  action: TicketAuditAction;
  ticketId: string | null;
  actor: string;
  source: TicketSource | "agent_tool" | "control_plane";
  detail: Record<string, unknown>;
}
