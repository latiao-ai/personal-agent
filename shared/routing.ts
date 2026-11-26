/** Public two-layer routing contracts: Gate Jev + Inner Router-Worker (MVP3). */

import type { Ticket } from "./tickets.ts";

export type RoutingRole = "lead" | "procurement" | "order" | "followup";

export interface GroupMessageInput {
  /** Platform event id (e.g. Feishu event_id) for deduplication. */
  eventId?: string;
  chatId: string;
  senderId: string;
  /** True when the sender is a bot itself (loop guard). */
  senderIsBot?: boolean;
  /** Open IDs / bot IDs mentioned in this group message. */
  mentions?: string[];
  /** Explicit boolean when gateway already resolved whether this bot was mentioned. */
  mentionedBot?: boolean;
  text: string;
  /** Current handoff hop count (defaults to 0; >= max_hops escalates to human). */
  hops?: number;
  /** Optional thread id inside the VM. */
  threadId?: string;
}

export interface JevDecision {
  managerBotId: string;
  targetRole: RoutingRole;
  targetBotId: string;
  confidence: number;
  method: "rule" | "model" | "fallback";
  fallbackToLead: boolean;
  reason: string;
  latencyMs: number;
}

export type GroupRouteResult =
  | {
      outcome: "ignored_bot_self" | "ignored_no_mention";
      reason: string;
      ticket: null;
      jev: null;
    }
  | {
      outcome: "escalated_to_human";
      reason: string;
      hops: number;
      maxHops: number;
      ticket: null;
      jev: null;
    }
  | {
      outcome: "replied_by_manager";
      managerBotId: string;
      jev: JevDecision;
      ticket: null;
      replyChannel: "manager_only";
      specialistMayPostDirectly: false;
      hops: number;
    }
  | {
      outcome: "dispatched_to_specialist";
      managerBotId: string;
      specialistBotId: string;
      specialistRole: Exclude<RoutingRole, "lead">;
      jev: JevDecision;
      ticket: Ticket | null;
      replyChannel: "manager_only";
      specialistMayPostDirectly: false;
      hops: number;
    };

export interface SpecialistReplyInput {
  chatId: string;
  ticketId?: string | null;
  specialistBotId: string;
  managerBotId: string;
  text: string;
  /** Attempted delivery mode: "direct_group" is always refused; must be "via_manager". */
  deliveryMode?: "direct_group" | "via_manager";
  /** If specialist requests another handoff to a peer role. */
  handoffToRole?: Exclude<RoutingRole, "lead">;
  hops: number;
}

export type SpecialistReplyResult =
  | {
      ok: false;
      outcome: "direct_group_forbidden";
      reason: string;
      mustRelayThrough: string;
    }
  | {
      ok: false;
      outcome: "escalated_to_human";
      reason: string;
      hops: number;
      maxHops: number;
    }
  | {
      ok: true;
      outcome: "relayed_via_manager";
      managerBotId: string;
      specialistBotId: string;
      hops: number;
      replyChannel: "manager_only";
    }
  | {
      ok: true;
      outcome: "handed_off";
      nextRole: Exclude<RoutingRole, "lead">;
      nextBotId: string;
      hops: number;
      maxHops: number;
    };

export interface RoutingAuditEntry {
  id: string;
  at: number;
  action:
    | "ignored_bot_self"
    | "ignored_no_mention"
    | "jev_routed"
    | "jev_fallback_lead"
    | "dispatched_specialist"
    | "replied_manager"
    | "specialist_direct_denied"
    | "max_hops_escalated";
  chatId: string;
  senderId: string;
  ticketId: string | null;
  hops: number;
  detail: Record<string, unknown>;
}
