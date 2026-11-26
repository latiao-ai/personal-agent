import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  SignedMandateCopy,
  Ticket,
  TicketAuditAction,
  TicketAuditEntry,
  TicketBudgetLimit,
  TicketIntakeDecision,
  TicketIntakeInput,
  TicketMandate,
  TicketSource,
} from "../../shared/tickets.ts";
import { DATA_DIR } from "../config.ts";
import { EVENT_RETRY_WINDOW_MS } from "../routine-event-receipts.ts";
import { createRunGate } from "../routine-run-gate.ts";
import { classifyIntake, isExternalEventSource } from "./classifier.ts";
import { hashMandate, signMandateCopy, verifySignedMandateCopy } from "./mandate.ts";
import { TicketStore } from "./store.ts";

const DEFAULT_VALID_FOR_MS = 24 * 60 * 60_000;
const DEFAULT_CONTENT_DEDUPE_WINDOW_MS = 5 * 60_000;
const DEFAULT_BUDGET: TicketBudgetLimit = { tokenLimit: 1, businessLimit: 0, currency: "CNY" };

export interface TicketEngineOptions {
  /** Path to standalone control-plane SQLite file (defaults to DATA_DIR/tickets.sqlite). */
  dbPath?: string;
  /** Signing secret for read-only mandate copies handed to VM agents. */
  signingSecret?: string;
  /** Dynamic or static allowlist of authorized user initiators (e.g. Feishu open_id). */
  allowlist?: ReadonlySet<string> | (() => ReadonlySet<string>);
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Content-hash deduplication window when eventId is absent. */
  contentDedupeWindowMs?: number;
  /** Receipt retention window (defaults to routine-event-receipts EVENT_RETRY_WINDOW_MS). */
  eventRetryWindowMs?: number;
}

export interface ReviseMandateInput {
  goal?: string;
  scope?: string;
  toolAllowlist?: string[];
  budgetLimit?: Partial<TicketBudgetLimit>;
  validUntil?: number;
}

export class TicketEngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "ticket_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseAllowlistEnv(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Sole writer of control-plane tickets (MVP2a).
 * Enforces allowlist auth, deduplication, deterministic side-effect classification,
 * external-event observe mode, immutable hashed mandates, and agent mutation refusal.
 */
export class TicketEngine {
  readonly store: TicketStore;
  private readonly signingSecret: string;
  private readonly allowlistProvider: () => ReadonlySet<string>;
  private readonly now: () => number;
  private readonly contentDedupeWindowMs: number;
  private readonly eventRetryWindowMs: number;
  private readonly gate = createRunGate<{ id: string }>(undefined, () => {});

  constructor(options: TicketEngineOptions = {}) {
    const dbPath = options.dbPath ?? join(DATA_DIR, "tickets.sqlite");
    this.store = new TicketStore(dbPath);
    this.signingSecret =
      options.signingSecret ??
      process.env.OMB_TICKET_SIGNING_SECRET?.trim() ??
      randomBytes(32).toString("hex");
    if (typeof options.allowlist === "function") {
      this.allowlistProvider = options.allowlist;
    } else if (options.allowlist) {
      const fixed = new Set(options.allowlist);
      this.allowlistProvider = () => fixed;
    } else {
      this.allowlistProvider = () => parseAllowlistEnv(process.env.OMB_TICKET_ALLOWLIST);
    }
    this.now = options.now ?? Date.now;
    this.contentDedupeWindowMs = options.contentDedupeWindowMs ?? DEFAULT_CONTENT_DEDUPE_WINDOW_MS;
    this.eventRetryWindowMs = options.eventRetryWindowMs ?? EVENT_RETRY_WINDOW_MS;
  }

  /** Evaluates an incoming trigger event and creates a ticket only when rules require it. */
  intake(input: TicketIntakeInput): TicketIntakeDecision {
    const now = this.now();
    const external = isExternalEventSource(input.source);

    if (!external) {
      const allowed = this.allowlistProvider();
      if (!allowed.has(input.initiator)) {
        this.recordAudit("intake_denied", null, input.initiator, input.source, {
          reason: "not_whitelisted",
          eventId: input.eventId ?? null,
        });
        return {
          outcome: "denied",
          reason: "not_whitelisted",
          replyNormally: false,
          observeOnly: false,
        };
      }
    }

    const classification = classifyIntake({
      source: input.source,
      text: input.text,
      midConversationSideEffect: input.midConversationSideEffect,
    });

    if (classification.kind === "conversation") {
      this.recordAudit("conversation_bypassed", null, input.initiator, input.source, {
        reason: classification.reason,
        eventId: input.eventId ?? null,
      });
      return {
        outcome: "conversation",
        reason: classification.reason,
        replyNormally: true,
        observeOnly: false,
      };
    }

    const dedupeKey = this.computeDedupeKey(input, now);
    const minAcceptedAt = now - this.eventRetryWindowMs;
    const existingReceipt = this.store.findReceipt(dedupeKey, minAcceptedAt);
    if (existingReceipt) {
      const existingTicket = this.store.getTicket(existingReceipt.ticketId);
      if (existingTicket) {
        this.recordAudit("ticket_deduplicated", existingTicket.id, input.initiator, input.source, {
          dedupeKey,
          eventId: input.eventId ?? null,
        });
        return {
          outcome: "duplicate",
          ticket: existingTicket,
          dedupeKey,
          replyNormally: !external,
          observeOnly: existingTicket.status === "observe",
        };
      }
    }

    const budget: TicketBudgetLimit = {
      tokenLimit: input.budget?.tokenLimit ?? DEFAULT_BUDGET.tokenLimit,
      businessLimit: input.budget?.businessLimit ?? DEFAULT_BUDGET.businessLimit,
      ...(input.budget?.currency ?? DEFAULT_BUDGET.currency
        ? { currency: input.budget?.currency ?? DEFAULT_BUDGET.currency }
        : {}),
    };
    const toolAllowlist = [...(input.toolAllowlist ?? [])];
    const mandate: TicketMandate = {
      goal: input.text.trim(),
      scope: input.scope ?? (external ? `observe:${input.source}` : `user_request:${input.source}`),
      toolAllowlist,
      budgetLimit: budget,
      validUntil: now + (input.validForMs ?? DEFAULT_VALID_FOR_MS),
      initiator: input.initiator,
      approver: null,
    };
    const mandateHash = hashMandate(mandate);
    const status = external ? "observe" : "ready";
    const ticket: Ticket = {
      id: `tkt_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      initiator: input.initiator,
      mandate,
      mandateHash,
      toolAllowlist,
      budget,
      status,
      parentId: null,
      eventId: input.eventId ?? null,
      dedupeKey,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
      rawText: input.text,
    };

    // Gate check keeps parity with routine-run-gate semantics before persisting.
    this.gate.hold({ id: ticket.id });
    this.store.insertTicketWithReceipt(ticket, now);
    this.recordAudit("ticket_created", ticket.id, input.initiator, input.source, {
      status: ticket.status,
      classification: classification.reason,
      dedupeKey,
      mandateHash,
      eventId: ticket.eventId,
    });

    return {
      outcome: "created",
      ticket,
      replyNormally: !external,
      observeOnly: status === "observe",
    };
  }

  /** Bridges an external webhook delivery from WebhookManager into an observe-only ticket. */
  intakeExternalWebhook(input: {
    webhookId: string;
    webhookName: string;
    deliveryId: string;
    prompt: string;
    botId: string;
  }): TicketIntakeDecision {
    return this.intake({
      source: "webhook",
      initiator: `webhook:${input.webhookId}`,
      text: input.prompt,
      eventId: `${input.webhookId}:${input.deliveryId}`,
      scope: `webhook:${input.webhookName}`,
      botId: input.botId,
    });
  }

  getTicket(id: string): Ticket | null {
    return this.store.getTicket(id);
  }

  listTickets(limit = 100): Ticket[] {
    return this.store.listTickets(limit);
  }

  /** Issues a signed read-only Mandate snapshot for an agent running inside a user VM. */
  readMandateForAgent(ticketId: string): SignedMandateCopy {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) {
      throw new TicketEngineError(`Ticket not found: ${ticketId}`, 404, "ticket_not_found");
    }
    const recomputed = hashMandate(ticket.mandate);
    if (recomputed !== ticket.mandateHash) {
      throw new TicketEngineError("Mandate hash integrity check failed", 500, "mandate_corrupted");
    }
    return signMandateCopy(ticket.id, ticket.mandate, ticket.mandateHash, this.signingSecret, this.now());
  }

  verifyMandateCopy(copy: SignedMandateCopy): boolean {
    return verifySignedMandateCopy(copy, this.signingSecret);
  }

  /**
   * Revising a Mandate never mutates in place: marks the old ticket `superseded` and creates a
   * new ticket linked via `parentId` with `approver: null` so MVP2b requires fresh approval.
   */
  reviseMandate(ticketId: string, patch: ReviseMandateInput, actor: string): { oldTicket: Ticket; newTicket: Ticket } {
    const current = this.store.getTicket(ticketId);
    if (!current) {
      throw new TicketEngineError(`Ticket not found: ${ticketId}`, 404, "ticket_not_found");
    }
    if (current.status === "superseded" || current.status === "cancelled" || current.status === "done") {
      throw new TicketEngineError(
        `Cannot revise ticket in terminal status: ${current.status}`,
        409,
        "ticket_not_revisable",
      );
    }

    const now = this.now();
    const nextBudget: TicketBudgetLimit = {
      tokenLimit: patch.budgetLimit?.tokenLimit ?? current.mandate.budgetLimit.tokenLimit,
      businessLimit: patch.budgetLimit?.businessLimit ?? current.mandate.budgetLimit.businessLimit,
      ...(patch.budgetLimit?.currency ?? current.mandate.budgetLimit.currency
        ? { currency: patch.budgetLimit?.currency ?? current.mandate.budgetLimit.currency }
        : {}),
    };
    const nextAllowlist = patch.toolAllowlist ? [...patch.toolAllowlist] : [...current.mandate.toolAllowlist];
    const nextMandate: TicketMandate = {
      goal: patch.goal?.trim() || current.mandate.goal,
      scope: patch.scope?.trim() || current.mandate.scope,
      toolAllowlist: nextAllowlist,
      budgetLimit: nextBudget,
      validUntil: patch.validUntil ?? current.mandate.validUntil,
      initiator: current.mandate.initiator,
      approver: null,
    };
    const nextHash = hashMandate(nextMandate);
    if (nextHash === current.mandateHash) {
      throw new TicketEngineError("Mandate unchanged", 400, "mandate_unchanged");
    }

    const nextTicket: Ticket = {
      id: `tkt_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      source: current.source,
      initiator: current.initiator,
      mandate: nextMandate,
      mandateHash: nextHash,
      toolAllowlist: nextAllowlist,
      budget: nextBudget,
      status: isExternalEventSource(current.source) ? "observe" : "ready",
      parentId: current.id,
      eventId: current.eventId,
      dedupeKey: `revision:${current.id}:${now}:${randomUUID().slice(0, 8)}`,
      ...(current.threadId ? { threadId: current.threadId } : {}),
      ...(current.botId ? { botId: current.botId } : {}),
      ...(current.rawText ? { rawText: current.rawText } : {}),
    };

    this.store.supersedeAndInsert(current.id, nextTicket, now);
    this.recordAudit("mandate_revised", nextTicket.id, actor, "control_plane", {
      oldTicketId: current.id,
      oldMandateHash: current.mandateHash,
      newMandateHash: nextHash,
      requiresReapproval: true,
    });

    const superseded = this.store.getTicket(current.id)!;
    return { oldTicket: superseded, newTicket: nextTicket };
  }

  /**
   * Explicitly rejects any attempt by a VM agent tool to mutate a Mandate in place,
   * recording an audit entry while leaving stored Mandate and hash untouched.
   */
  rejectAgentMandateMutation(
    ticketId: string,
    actor: string,
    toolName: string,
    attemptedPatch: Record<string, unknown>,
  ): { denied: true; reason: "mandate_immutable"; ticketId: string; mandateHash: string | null } {
    const ticket = this.store.getTicket(ticketId);
    this.recordAudit("mandate_mutation_denied", ticket ? ticket.id : ticketId, actor, "agent_tool", {
      toolName,
      attemptedPatch,
      mandateHash: ticket?.mandateHash ?? null,
    });
    return {
      denied: true,
      reason: "mandate_immutable",
      ticketId,
      mandateHash: ticket?.mandateHash ?? null,
    };
  }

  listAudit(ticketId?: string, limit = 100): TicketAuditEntry[] {
    return this.store.listAudit(ticketId, limit);
  }

  close(): void {
    this.store.close();
  }

  private computeDedupeKey(input: TicketIntakeInput, now: number): string {
    if (input.eventId && input.eventId.trim()) {
      return `event:${input.source}:${input.eventId.trim()}`;
    }
    const normalizedText = input.text.trim().replace(/\s+/g, " ");
    const contentHash = createHash("sha256").update(normalizedText, "utf8").digest("hex").slice(0, 24);
    const bucket = Math.floor(now / this.contentDedupeWindowMs);
    return `content:${input.source}:${input.initiator}:${contentHash}:${bucket}`;
  }

  private recordAudit(
    action: TicketAuditAction,
    ticketId: string | null,
    actor: string,
    source: TicketSource | "agent_tool" | "control_plane",
    detail: Record<string, unknown>,
  ): void {
    this.store.appendAudit({
      id: `aud_${randomUUID()}`,
      at: this.now(),
      action,
      ticketId,
      actor,
      source,
      detail,
    });
  }
}
