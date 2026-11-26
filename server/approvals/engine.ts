import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ActionCategory,
  ApprovalAuditRecord,
  ApprovalCard,
  ApprovalEvaluateInput,
  ApprovalEvaluationResult,
  DualBudgetPolicy,
  FeishuCardCallbackInput,
  FeishuCardCallbackResult,
} from "../../shared/approvals.ts";
import { DATA_DIR } from "../config.ts";
import { evaluateDualBudget, utcDayKey, utcMonthKey } from "./budget.ts";
import { ApprovalStore } from "./store.ts";
import { inferActionCategory, isMandatoryHumanCategory, runGuardedReviewer, type ApprovalReviewer } from "./tiers.ts";
import { ControlPlaneVault } from "./vault.ts";

const DEFAULT_CARD_TTL_MS = 30 * 60_000;
const DEFAULT_REVIEWER_TIMEOUT_MS = 3_000;

export interface ApprovalEngineOptions {
  dbPath?: string;
  reviewer?: ApprovalReviewer;
  reviewerTimeoutMs?: number;
  now?: () => number;
  vault?: ControlPlaneVault;
}

/**
 * Control-plane 4-tier approval engine (MVP2b).
 * Enforces deterministic hard rules first (allowlist -> dual budget -> action category),
 * guarded upward-only review model second, and human Feishu interactive cards third.
 */
export class ApprovalEngine {
  readonly store: ApprovalStore;
  readonly vault: ControlPlaneVault;
  private reviewer?: ApprovalReviewer;
  private readonly reviewerTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: ApprovalEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = new ApprovalStore(options.dbPath ?? join(DATA_DIR, "approvals.sqlite"));
    this.vault = options.vault ?? new ControlPlaneVault(this.now);
    this.reviewer = options.reviewer;
    this.reviewerTimeoutMs = options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  }

  setReviewer(reviewer: ApprovalReviewer | undefined): void {
    this.reviewer = reviewer;
  }

  setBudgetPolicy(tenantId: string, policy: DualBudgetPolicy): void {
    this.store.setBudgetPolicy(tenantId, policy, this.now());
  }

  getBudgetPolicy(tenantId: string): DualBudgetPolicy {
    return this.store.getBudgetPolicy(tenantId);
  }

  /** Evaluates a Ticket in fixed order: Code rules -> Review model (low-risk write only) -> Human card. */
  async evaluate(input: ApprovalEvaluateInput): Promise<ApprovalEvaluationResult> {
    const now = this.now();
    const category: ActionCategory =
      input.actionCategory ?? inferActionCategory(input.actionSummary, input.toolName, input.businessCost);
    const currency = input.currency ?? this.store.getBudgetPolicy(input.tenantId).currency;
    const approverOpenId = input.approver?.trim() || input.initiator;

    // Step 1a: Tool allowlist hard rule (read-only queries without explicit allowlist still execute directly).
    if (category !== "read_only" && !input.toolAllowlist.includes(input.toolName)) {
      const reason = `工具 ${input.toolName} 不在 Ticket 白名单内`;
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId,
        actor: input.initiator,
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 4,
        decision: "rejected",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason,
      });
      return { decision: "rejected", tier: 4, reason, card: null, surrogateToken: null };
    }

    // Step 1b: Dual budget hard rule (per-tx / daily / monthly for both token and business spend).
    const policy = this.store.getBudgetPolicy(input.tenantId);
    const totals = this.store.getSpendTotals(input.tenantId, utcDayKey(now), utcMonthKey(now));
    const budgetCheck = evaluateDualBudget(policy, totals, {
      tokenCost: input.tokenCost,
      businessCost: input.businessCost,
    });
    if (!budgetCheck.ok) {
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId,
        actor: input.initiator,
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 4,
        decision: "rejected",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason: budgetCheck.reason,
      });
      return { decision: "rejected", tier: 4, reason: budgetCheck.reason, card: null, surrogateToken: null };
    }

    // Step 1c: Tier 1 read-only -> execute directly, no card.
    if (category === "read_only") {
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId: null,
        actor: input.initiator,
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 1,
        decision: "auto_allowed",
        tokenCost: input.tokenCost,
        businessCost: 0,
        currency,
        reason: "tier1_read_only_direct",
      });
      return { decision: "execute_direct", tier: 1, reason: "tier1_read_only_direct", card: null, surrogateToken: null };
    }

    // Step 1d: Mandatory human-approval actions (spend / order / pay / delete / outward message) -> Tier 3 card.
    if (isMandatoryHumanCategory(category)) {
      const card = this.createCard(input, category, approverOpenId, currency, now);
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: card.id,
        approverOpenId,
        actor: input.initiator,
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 3,
        decision: "card_shown",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason: `tier3_mandatory_human:${category}`,
      });
      return { decision: "ask_human", tier: 3, reason: `tier3_mandatory_human:${category}`, card, surrogateToken: null };
    }

    // Step 2: Low-risk write -> check scoped Always-allow first, otherwise guarded review model (upward-only).
    if (
      this.store.matchesAlwaysAllow({
        tenantId: input.tenantId,
        initiator: input.initiator,
        actionCategory: category,
        toolName: input.toolName,
        businessCost: input.businessCost,
      })
    ) {
      const token = this.issueAndBookSpend(input, currency, now);
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId,
        actor: input.initiator,
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 2,
        decision: "auto_allowed",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason: "always_allow_scoped_match",
      });
      return { decision: "execute_direct", tier: 2, reason: "always_allow_scoped_match", card: null, surrogateToken: token };
    }

    const review = await runGuardedReviewer(
      this.reviewer,
      {
        ticketId: input.ticketId,
        actionSummary: input.actionSummary,
        toolName: input.toolName,
        category,
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
      },
      2,
      this.reviewerTimeoutMs,
    );

    if (review.tier === 2) {
      const token = this.issueAndBookSpend(input, currency, now);
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId: null,
        actor: "review_model",
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 2,
        decision: "auto_allowed",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason: review.reason,
      });
      return { decision: "execute_direct", tier: 2, reason: review.reason, card: null, surrogateToken: token };
    }

    if (review.tier === 4) {
      this.recordAudit({
        tenantId: input.tenantId,
        ticketId: input.ticketId,
        cardId: null,
        approverOpenId,
        actor: "review_model",
        mandateSummary: input.actionSummary,
        action: input.toolName,
        tier: 4,
        decision: "rejected",
        tokenCost: input.tokenCost,
        businessCost: input.businessCost,
        currency,
        reason: review.reason,
      });
      return { decision: "rejected", tier: 4, reason: review.reason, card: null, surrogateToken: null };
    }

    // Tier 3 (escalated by reviewer, timeout, error, or unparseable output) -> human card.
    const card = this.createCard(input, category, approverOpenId, currency, now);
    this.recordAudit({
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      cardId: card.id,
      approverOpenId,
      actor: "review_model",
      mandateSummary: input.actionSummary,
      action: input.toolName,
      tier: 3,
      decision: "card_shown",
      tokenCost: input.tokenCost,
      businessCost: input.businessCost,
      currency,
      reason: review.reason,
    });
    return { decision: "ask_human", tier: 3, reason: review.reason, card, surrogateToken: null };
  }

  /**
   * Handles Feishu `card.action.trigger` callback:
   * validates approver open_id, enforces expiration, guarantees atomic idempotency,
   * and issues an ephemeral surrogate token on approval.
   */
  handleCardCallback(input: FeishuCardCallbackInput): FeishuCardCallbackResult {
    const now = this.now();
    const card = this.store.getCard(input.cardId);
    if (!card) {
      return {
        ok: false,
        outcome: "card_not_found",
        ticketId: null,
        reason: `审批卡片不存在: ${input.cardId}`,
      };
    }

    // 1. Validate operator open_id matches designated approver.
    if (input.operatorOpenId !== card.approverOpenId) {
      this.recordAudit({
        tenantId: card.tenantId,
        ticketId: card.ticketId,
        cardId: card.id,
        approverOpenId: card.approverOpenId,
        actor: input.operatorOpenId,
        mandateSummary: card.actionSummary,
        action: input.action,
        tier: 3,
        decision: "unauthorized_click",
        tokenCost: card.tokenCost,
        businessCost: card.businessCost,
        currency: card.currency,
        reason: `非批准人点击卡片: expected=${card.approverOpenId}, actual=${input.operatorOpenId}`,
      });
      return {
        ok: false,
        outcome: "unauthorized_approver",
        ticketId: card.ticketId,
        reason: "非指定批准人，无权操作此审批卡片",
      };
    }

    // 2. Idempotency check if already decided.
    if (card.status !== "pending") {
      this.recordAudit({
        tenantId: card.tenantId,
        ticketId: card.ticketId,
        cardId: card.id,
        approverOpenId: card.approverOpenId,
        actor: input.operatorOpenId,
        mandateSummary: card.actionSummary,
        action: input.action,
        tier: 3,
        decision: "duplicate_click",
        tokenCost: card.tokenCost,
        businessCost: card.businessCost,
        currency: card.currency,
        reason: `卡片已处理(${card.status})，忽略重复点击`,
      });
      return {
        ok: true,
        outcome: "already_processed",
        idempotent: true,
        ticketId: card.ticketId,
        cardStatus: card.status,
        message: "已处理",
      };
    }

    // 3. Expiration check against Mandate valid_until / card expiresAt.
    if (now > card.expiresAt) {
      this.store.transitionPendingCard(card.id, "expired", now, input.operatorOpenId, input.action);
      this.recordAudit({
        tenantId: card.tenantId,
        ticketId: card.ticketId,
        cardId: card.id,
        approverOpenId: card.approverOpenId,
        actor: input.operatorOpenId,
        mandateSummary: card.actionSummary,
        action: input.action,
        tier: 3,
        decision: "expired",
        tokenCost: card.tokenCost,
        businessCost: card.businessCost,
        currency: card.currency,
        reason: "审批卡片已过期，拒绝执行",
      });
      return {
        ok: false,
        outcome: "card_expired",
        ticketId: card.ticketId,
        ticketStatus: "cancelled",
        reason: "审批卡片已过期",
      };
    }

    // 4. Deny branch.
    if (input.action === "deny") {
      const transitioned = this.store.transitionPendingCard(card.id, "denied", now, input.operatorOpenId, "deny");
      if (!transitioned) {
        const latest = this.store.getCard(card.id)!;
        return {
          ok: true,
          outcome: "already_processed",
          idempotent: true,
          ticketId: card.ticketId,
          cardStatus: latest.status,
          message: "已处理",
        };
      }
      this.recordAudit({
        tenantId: card.tenantId,
        ticketId: card.ticketId,
        cardId: card.id,
        approverOpenId: card.approverOpenId,
        actor: input.operatorOpenId,
        mandateSummary: card.actionSummary,
        action: "deny",
        tier: 3,
        decision: "denied",
        tokenCost: card.tokenCost,
        businessCost: card.businessCost,
        currency: card.currency,
        reason: "批准人拒绝执行",
      });
      return {
        ok: true,
        outcome: "denied",
        idempotent: false,
        ticketId: card.ticketId,
        ticketStatus: "cancelled",
        cardStatus: "denied",
      };
    }

    // 5. Approve branch (allow_once / always_allow) - atomic transition prevents double execution.
    const transitioned = this.store.transitionPendingCard(card.id, "approved", now, input.operatorOpenId, input.action);
    if (!transitioned) {
      const latest = this.store.getCard(card.id)!;
      return {
        ok: true,
        outcome: "already_processed",
        idempotent: true,
        ticketId: card.ticketId,
        cardStatus: latest.status,
        message: "已处理",
      };
    }

    // Re-check budget right before issuing surrogate token.
    const policy = this.store.getBudgetPolicy(card.tenantId);
    const totals = this.store.getSpendTotals(card.tenantId, utcDayKey(now), utcMonthKey(now));
    const budgetCheck = evaluateDualBudget(policy, totals, {
      tokenCost: card.tokenCost,
      businessCost: card.businessCost,
    });
    if (!budgetCheck.ok) {
      this.recordAudit({
        tenantId: card.tenantId,
        ticketId: card.ticketId,
        cardId: card.id,
        approverOpenId: card.approverOpenId,
        actor: input.operatorOpenId,
        mandateSummary: card.actionSummary,
        action: input.action,
        tier: 4,
        decision: "rejected",
        tokenCost: card.tokenCost,
        businessCost: card.businessCost,
        currency: card.currency,
        reason: budgetCheck.reason,
      });
      return {
        ok: false,
        outcome: "card_expired",
        ticketId: card.ticketId,
        ticketStatus: "cancelled",
        reason: budgetCheck.reason,
      };
    }

    let alwaysAllowSaved = false;
    // Scoped Always-allow is never saved for high-risk spend/delete/outward actions; only low-risk writes.
    if (input.action === "always_allow" && !isMandatoryHumanCategory(card.actionCategory)) {
      this.store.saveAlwaysAllowRule({
        tenantId: card.tenantId,
        initiator: card.initiator,
        actionCategory: card.actionCategory,
        toolName: card.toolName,
        maxBusinessLimit: card.businessCost,
        createdBy: input.operatorOpenId,
        createdAt: now,
      });
      alwaysAllowSaved = true;
    }

    const surrogateToken = this.vault.issueSurrogateToken({
      tenantId: card.tenantId,
      ticketId: card.ticketId,
      toolAllowlist: [card.toolName],
      maxTokenSpend: card.tokenCost,
      maxBusinessSpend: card.businessCost,
      currency: card.currency,
    });

    this.store.recordSpend({
      id: `spd_${randomUUID()}`,
      tenantId: card.tenantId,
      ticketId: card.ticketId,
      dayKey: utcDayKey(now),
      monthKey: utcMonthKey(now),
      tokenCost: card.tokenCost,
      businessCost: card.businessCost,
      currency: card.currency,
      recordedAt: now,
    });

    this.recordAudit({
      tenantId: card.tenantId,
      ticketId: card.ticketId,
      cardId: card.id,
      approverOpenId: card.approverOpenId,
      actor: input.operatorOpenId,
      mandateSummary: card.actionSummary,
      action: input.action,
      tier: 3,
      decision: "approved",
      tokenCost: card.tokenCost,
      businessCost: card.businessCost,
      currency: card.currency,
      reason: input.action === "always_allow" ? "批准人允许（请求同类放行）" : "批准人单次允许",
    });

    return {
      ok: true,
      outcome: "approved",
      idempotent: false,
      ticketId: card.ticketId,
      ticketStatus: "executing",
      cardStatus: "approved",
      surrogateToken,
      alwaysAllowSaved,
    };
  }

  getCard(cardId: string): ApprovalCard | null {
    return this.store.getCard(cardId);
  }

  listCards(limit = 100): ApprovalCard[] {
    return this.store.listCards(limit);
  }

  listAudit(filter?: { ticketId?: string; approverOpenId?: string; limit?: number }): ApprovalAuditRecord[] {
    return this.store.listAudit(filter);
  }

  close(): void {
    this.store.close();
  }

  private issueAndBookSpend(input: ApprovalEvaluateInput, currency: string, now: number) {
    const token = this.vault.issueSurrogateToken({
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      toolAllowlist: [input.toolName],
      maxTokenSpend: input.tokenCost,
      maxBusinessSpend: input.businessCost,
      currency,
    });
    this.store.recordSpend({
      id: `spd_${randomUUID()}`,
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      dayKey: utcDayKey(now),
      monthKey: utcMonthKey(now),
      tokenCost: input.tokenCost,
      businessCost: input.businessCost,
      currency,
      recordedAt: now,
    });
    return token;
  }

  private createCard(
    input: ApprovalEvaluateInput,
    category: ActionCategory,
    approverOpenId: string,
    currency: string,
    now: number,
  ): ApprovalCard {
    const id = `crd_${randomUUID()}`;
    const expiresAt = input.validUntil ?? now + DEFAULT_CARD_TTL_MS;
    const recipient = input.recipient?.trim() || "系统/默认对象";
    const riskSummary = input.riskSummary?.trim() || `高风险动作(${category})，需人工确认`;
    const feishuCardPayload = buildFeishuCardPayload({
      cardId: id,
      ticketId: input.ticketId,
      actionSummary: input.actionSummary,
      businessCost: input.businessCost,
      tokenCost: input.tokenCost,
      currency,
      recipient,
      riskSummary,
    });
    const card: ApprovalCard = {
      id,
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      initiator: input.initiator,
      approverOpenId,
      actionSummary: input.actionSummary,
      actionCategory: category,
      toolName: input.toolName,
      recipient,
      riskSummary,
      tokenCost: input.tokenCost,
      businessCost: input.businessCost,
      currency,
      status: "pending",
      createdAt: now,
      expiresAt,
      decidedAt: null,
      decidedBy: null,
      decisionAction: null,
      feishuCardPayload,
    };
    this.store.insertCard(card);
    return card;
  }

  private recordAudit(entry: Omit<ApprovalAuditRecord, "id" | "at">): void {
    this.store.appendAudit({
      id: `aaud_${randomUUID()}`,
      at: this.now(),
      ...entry,
    });
  }
}

function buildFeishuCardPayload(input: {
  cardId: string;
  ticketId: string;
  actionSummary: string;
  businessCost: number;
  tokenCost: number;
  currency: string;
  recipient: string;
  riskSummary: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `审批请求 · ${input.ticketId}` },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**工单 ID**：${input.ticketId}`,
            `**操作内容**：${input.actionSummary}`,
            `**预计花费**：业务 ${input.businessCost} ${input.currency} / 模型 ${input.tokenCost}`,
            `**目标对象**：${input.recipient}`,
            `**风险提示**：${input.riskSummary}`,
          ].join("\n"),
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "Allow once" },
              type: "primary",
              value: { cardId: input.cardId, ticketId: input.ticketId, action: "allow_once" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "Always allow" },
              type: "default",
              value: { cardId: input.cardId, ticketId: input.ticketId, action: "always_allow" },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "Deny" },
              type: "danger",
              value: { cardId: input.cardId, ticketId: input.ticketId, action: "deny" },
            },
          ],
        },
      ],
    },
  };
}
