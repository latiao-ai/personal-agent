/** Public control-plane tiered approval, Feishu card, vault surrogate token, and budget contracts (MVP2b). */

export type ApprovalTier = 1 | 2 | 3 | 4;

export type ActionCategory =
  | "read_only"
  | "low_risk_write"
  | "high_risk_spend"
  | "delete_data"
  | "outward_message";

export type ApprovalButtonAction = "allow_once" | "always_allow" | "deny";

export type ApprovalCardStatus = "pending" | "approved" | "denied" | "expired";

/** Channel through which a human approval decision was submitted. */
export type ApprovalChannel = "feishu" | "web";

/** Per-transaction, daily, and monthly caps for both model token cost and business spend. */
export interface DualBudgetPolicy {
  tokenPerTx: number;
  tokenDaily: number;
  tokenMonthly: number;
  businessPerTx: number;
  businessDaily: number;
  businessMonthly: number;
  currency: string;
}

export interface ApprovalEvaluateInput {
  tenantId: string;
  ticketId: string;
  initiator: string;
  /** Designated approver open_id; defaults to initiator when Mandate.approver is null. */
  approver?: string | null;
  actionSummary: string;
  actionCategory?: ActionCategory;
  toolName: string;
  /** Tool allowlist from the Ticket/Mandate. Empty array means no write tool is pre-authorized. */
  toolAllowlist: string[];
  recipient?: string;
  riskSummary?: string;
  tokenCost: number;
  businessCost: number;
  currency?: string;
  /** Mandate expiration epoch ms; defaults to now + 30 minutes for card expiry. */
  validUntil?: number;
}

export interface ApprovalCard {
  id: string;
  ticketId: string;
  tenantId: string;
  initiator: string;
  approverOpenId: string;
  actionSummary: string;
  actionCategory: ActionCategory;
  toolName: string;
  recipient: string;
  riskSummary: string;
  tokenCost: number;
  businessCost: number;
  currency: string;
  status: ApprovalCardStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionAction: ApprovalButtonAction | null;
  decisionChannel?: ApprovalChannel | null;
  /** Ready-to-send Feishu interactive card JSON payload (`card.action.trigger`). */
  feishuCardPayload: Record<string, unknown>;
}

export type ApprovalEvaluationResult =
  | {
      decision: "execute_direct";
      tier: 1 | 2;
      reason: string;
      card: null;
      surrogateToken: EphemeralSurrogateToken | null;
    }
  | {
      decision: "ask_human";
      tier: 3;
      reason: string;
      card: ApprovalCard;
      surrogateToken: null;
    }
  | {
      decision: "rejected";
      tier: 4;
      reason: string;
      card: null;
      surrogateToken: null;
    };

export interface FeishuCardCallbackInput {
  cardId: string;
  operatorOpenId: string;
  action: ApprovalButtonAction;
  /** Decision source channel; defaults to "feishu" for Feishu card callbacks. */
  channel?: ApprovalChannel;
  /** Optional Feishu callback token/event id for tracing. */
  callbackEventId?: string;
}

export type FeishuCardCallbackResult =
  | {
      ok: true;
      outcome: "approved";
      idempotent: false;
      ticketId: string;
      ticketStatus: "executing";
      cardStatus: "approved";
      channel: ApprovalChannel;
      decidedBy: string;
      surrogateToken: EphemeralSurrogateToken;
      alwaysAllowSaved: boolean;
    }
  | {
      ok: true;
      outcome: "denied";
      idempotent: false;
      ticketId: string;
      ticketStatus: "cancelled";
      cardStatus: "denied";
      channel: ApprovalChannel;
      decidedBy: string;
    }
  | {
      ok: true;
      outcome: "already_processed";
      idempotent: true;
      ticketId: string;
      cardStatus: ApprovalCardStatus;
      decidedBy?: string | null;
      decisionChannel?: ApprovalChannel | null;
      statusBanner?: string | null;
      message: string;
    }
  | {
      ok: false;
      outcome: "unauthorized_approver" | "card_expired" | "card_not_found";
      ticketId: string | null;
      ticketStatus?: "cancelled";
      reason: string;
    };

/** Short-lived surrogate token handed to VM agent; embeds budget & tool constraints, never raw secrets. */
export interface EphemeralSurrogateToken {
  token: string;
  tenantId: string;
  ticketId: string;
  toolAllowlist: string[];
  maxTokenSpend: number;
  maxBusinessSpend: number;
  currency: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
}

export interface ApprovalAuditRecord {
  id: string;
  at: number;
  tenantId: string;
  ticketId: string | null;
  cardId: string | null;
  approverOpenId: string | null;
  actor: string;
  mandateSummary: string;
  action: string;
  tier: ApprovalTier;
  decision: "approved" | "denied" | "auto_allowed" | "card_shown" | "rejected" | "expired" | "unauthorized_click" | "duplicate_click";
  tokenCost: number;
  businessCost: number;
  currency: string;
  channel?: ApprovalChannel | null;
  reason: string;
}
