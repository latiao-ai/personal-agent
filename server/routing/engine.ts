import { randomUUID } from "node:crypto";

import type {
  GroupMessageInput,
  GroupRouteResult,
  RoutingAuditEntry,
  SpecialistReplyInput,
  SpecialistReplyResult,
} from "../../shared/routing.ts";
import { classifyIntake } from "../tickets/classifier.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import {
  DEFAULT_JEV_ROSTER,
  decideWithJev,
  stripMentions,
  type JevRoster,
  type JevSmallModel,
} from "./jev.ts";

export const MAX_ROUTING_HOPS = 4;

export interface RoutingEngineOptions {
  tickets: TicketEngine;
  roster?: JevRoster;
  /** Registered bot sender IDs (e.g. Feishu bot open_ids) filtered out to prevent self-routing loops. */
  botSenderIds?: Iterable<string>;
  /** Optional small decision model used when fixed Jev rules do not match. */
  smallModel?: JevSmallModel;
  jevTimeoutMs?: number;
  maxHops?: number;
  now?: () => number;
}

/**
 * Two-layer group routing engine (MVP3):
 * - Control-plane Gate Jev: fast rule + small-model routing with lead-bot fallback, no ticket creation.
 * - Inner Router-Worker: reuses MVP2a classifier & TicketEngine, enforces Manager-only group replies,
 *   bot-self loop filtering, @mention gating, and max_hops = 4 escalation to human.
 */
export class RoutingEngine {
  readonly roster: JevRoster;
  readonly maxHops: number;
  private readonly tickets: TicketEngine;
  private readonly botSenderIds: Set<string>;
  private readonly smallModel?: JevSmallModel;
  private readonly jevTimeoutMs?: number;
  private readonly now: () => number;
  private readonly auditLog: RoutingAuditEntry[] = [];

  constructor(options: RoutingEngineOptions) {
    this.tickets = options.tickets;
    this.roster = options.roster ?? DEFAULT_JEV_ROSTER;
    this.maxHops = options.maxHops ?? MAX_ROUTING_HOPS;
    this.smallModel = options.smallModel;
    this.jevTimeoutMs = options.jevTimeoutMs;
    this.now = options.now ?? Date.now;
    this.botSenderIds = new Set([
      this.roster.managerBotId,
      this.roster.leadBotId,
      ...Object.values(this.roster.botsByRole),
      ...(options.botSenderIds ?? []),
    ]);
  }

  async routeGroupMessage(input: GroupMessageInput): Promise<GroupRouteResult> {
    const hops = input.hops ?? 0;

    // 1. Loop guard: messages sent by any bot itself never re-enter routing.
    if (input.senderIsBot === true || this.botSenderIds.has(input.senderId)) {
      this.recordAudit("ignored_bot_self", input.chatId, input.senderId, null, hops, {
        eventId: input.eventId ?? null,
      });
      return {
        outcome: "ignored_bot_self",
        reason: "sender_is_bot",
        ticket: null,
        jev: null,
      };
    }

    // 2. Feishu group @mention gate: only respond when the bot is explicitly mentioned.
    if (!this.isBotMentioned(input)) {
      this.recordAudit("ignored_no_mention", input.chatId, input.senderId, null, hops, {
        eventId: input.eventId ?? null,
      });
      return {
        outcome: "ignored_no_mention",
        reason: "group_message_without_bot_mention",
        ticket: null,
        jev: null,
      };
    }

    // 3. Handoff hop limit guard: max_hops = 4 -> escalate to human.
    if (hops >= this.maxHops) {
      this.recordAudit("max_hops_escalated", input.chatId, input.senderId, null, hops, {
        maxHops: this.maxHops,
        eventId: input.eventId ?? null,
      });
      return {
        outcome: "escalated_to_human",
        reason: `max_hops_reached:${hops}/${this.maxHops}`,
        hops,
        maxHops: this.maxHops,
        ticket: null,
        jev: null,
      };
    }

    // 4. Gate Jev fast decision (never creates a ticket).
    const jev = await decideWithJev(input.text, {
      roster: this.roster,
      smallModel: this.smallModel,
      timeoutMs: this.jevTimeoutMs,
      now: this.now,
    });
    this.recordAudit(
      jev.fallbackToLead ? "jev_fallback_lead" : "jev_routed",
      input.chatId,
      input.senderId,
      null,
      hops,
      {
        targetRole: jev.targetRole,
        targetBotId: jev.targetBotId,
        method: jev.method,
        confidence: jev.confidence,
        reason: jev.reason,
        latencyMs: jev.latencyMs,
      },
    );

    // 5. Inner Router: reuse MVP2a deterministic classifier + TicketEngine.
    const cleanedText = stripMentions(input.text);
    const classification = classifyIntake({
      source: "feishu_group",
      text: cleanedText,
    });

    if (jev.targetRole === "lead") {
      this.recordAudit("replied_manager", input.chatId, input.senderId, null, hops, {
        managerBotId: jev.managerBotId,
        classification: classification.kind,
        fallbackToLead: jev.fallbackToLead,
      });
      return {
        outcome: "replied_by_manager",
        managerBotId: jev.managerBotId,
        jev,
        ticket: null,
        replyChannel: "manager_only",
        specialistMayPostDirectly: false,
        hops,
      };
    }

    // Only side-effect work creates a Ticket via MVP2a TicketEngine; read-only specialist queries do not.
    let ticket = null;
    if (classification.kind === "side_effect") {
      const intake = this.tickets.intake({
        source: "feishu_group",
        initiator: input.senderId,
        text: cleanedText,
        eventId: input.eventId,
        scope: `group:${input.chatId}:hop:${hops + 1}`,
        botId: jev.targetBotId,
        threadId: input.threadId,
      });
      if (intake.outcome === "created" || intake.outcome === "duplicate") {
        ticket = intake.ticket;
      }
    }

    const nextHops = hops + 1;
    this.recordAudit("dispatched_specialist", input.chatId, input.senderId, ticket?.id ?? null, nextHops, {
      managerBotId: jev.managerBotId,
      specialistBotId: jev.targetBotId,
      specialistRole: jev.targetRole,
      classification: classification.kind,
    });

    return {
      outcome: "dispatched_to_specialist",
      managerBotId: jev.managerBotId,
      specialistBotId: jev.targetBotId,
      specialistRole: jev.targetRole,
      jev,
      ticket,
      replyChannel: "manager_only",
      specialistMayPostDirectly: false,
      hops: nextHops,
    };
  }

  /**
   * Enforces Specialist reply discipline:
   * - Direct posts to group chat are strictly refused; replies must relay through Manager Bot.
   * - Handoffs increment hop count and escalate to human when reaching max_hops = 4.
   */
  handleSpecialistReply(input: SpecialistReplyInput): SpecialistReplyResult {
    if (input.deliveryMode === "direct_group") {
      this.recordAudit("specialist_direct_denied", input.chatId, input.specialistBotId, input.ticketId ?? null, input.hops, {
        mustRelayThrough: input.managerBotId,
      });
      return {
        ok: false,
        outcome: "direct_group_forbidden",
        reason: "Specialist Bot 不得直接回群，必须通过 Manager Bot 汇总转发",
        mustRelayThrough: input.managerBotId,
      };
    }

    if (input.handoffToRole) {
      const nextHops = input.hops + 1;
      if (nextHops >= this.maxHops) {
        this.recordAudit("max_hops_escalated", input.chatId, input.specialistBotId, input.ticketId ?? null, nextHops, {
          maxHops: this.maxHops,
          requestedRole: input.handoffToRole,
        });
        return {
          ok: false,
          outcome: "escalated_to_human",
          reason: `转手次数达到上限 (${nextHops}/${this.maxHops})，已交回给人处理`,
          hops: nextHops,
          maxHops: this.maxHops,
        };
      }
      const nextBotId = this.roster.botsByRole[input.handoffToRole];
      this.recordAudit("dispatched_specialist", input.chatId, input.specialistBotId, input.ticketId ?? null, nextHops, {
        nextRole: input.handoffToRole,
        nextBotId,
      });
      return {
        ok: true,
        outcome: "handed_off",
        nextRole: input.handoffToRole,
        nextBotId,
        hops: nextHops,
        maxHops: this.maxHops,
      };
    }

    return {
      ok: true,
      outcome: "relayed_via_manager",
      managerBotId: input.managerBotId,
      specialistBotId: input.specialistBotId,
      hops: input.hops,
      replyChannel: "manager_only",
    };
  }

  listAudit(limit = 100): RoutingAuditEntry[] {
    return this.auditLog.slice(-limit).reverse();
  }

  private isBotMentioned(input: GroupMessageInput): boolean {
    if (input.mentionedBot === true) return true;
    if (input.mentionedBot === false) return false;
    if (input.mentions && input.mentions.some((id) => this.botSenderIds.has(id))) return true;
    return false;
  }

  private recordAudit(
    action: RoutingAuditEntry["action"],
    chatId: string,
    senderId: string,
    ticketId: string | null,
    hops: number,
    detail: Record<string, unknown>,
  ): void {
    this.auditLog.push({
      id: `raud_${randomUUID()}`,
      at: this.now(),
      action,
      chatId,
      senderId,
      ticketId,
      hops,
      detail,
    });
    if (this.auditLog.length > 2_000) {
      this.auditLog.splice(0, this.auditLog.length - 2_000);
    }
  }
}
