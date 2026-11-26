import { randomUUID } from "node:crypto";

import {
  PATROL_READ_ONLY_TOOL_ALLOWLIST,
  type PatrolToolDenialRecord,
} from "../../shared/patrol.ts";
import type { TicketMandate } from "../../shared/tickets.ts";

const STRICT_READ_ONLY_SET: ReadonlySet<string> = new Set(PATROL_READ_ONLY_TOOL_ALLOWLIST);

const FORBIDDEN_TOOL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "send_message", pattern: /(send|post|reply|notify|broadcast|message|email|feishu|slack|wechat|dm)/i },
  { label: "write_or_mutate", pattern: /(write|update|delete|remove|create|mutate|edit|set_|patch|cancel|ship|restock)/i },
  { label: "payment", pattern: /(pay|payment|purchase|checkout|transfer|refund|order_place|place_order)/i },
  { label: "browser_control", pattern: /(browser|playwright|puppeteer|click|navigate|computer|desktop|shell|bash|exec)/i },
];

export type PatrolToolDecision =
  | { allowed: true; toolName: string }
  | { allowed: false; toolName: string; reason: string; denial: PatrolToolDenialRecord };

/**
 * Tool-layer read-only permission proxy for patrol runs.
 * Enforces read-only access against the patrol Ticket's immutable Mandate allowlist
 * and hard-blocks write, messaging, payment, and browser-control tools regardless of prompt text.
 */
export class PatrolPermissionGuard {
  private readonly runId: string;
  private readonly patrolTicketId: string;
  private readonly mandateAllowlist: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly onDenial?: (record: PatrolToolDenialRecord) => void;
  private readonly denials: PatrolToolDenialRecord[] = [];

  constructor(options: {
    runId: string;
    patrolTicketId: string;
    mandate: Readonly<TicketMandate>;
    now?: () => number;
    onDenial?: (record: PatrolToolDenialRecord) => void;
  }) {
    this.runId = options.runId;
    this.patrolTicketId = options.patrolTicketId;
    this.mandateAllowlist = new Set(options.mandate.toolAllowlist);
    this.now = options.now ?? Date.now;
    this.onDenial = options.onDenial;
  }

  /** Verifies that a patrol Mandate allowlist contains strictly read-only tools and nothing outside the read-only set. */
  static isStrictlyReadOnlyAllowlist(allowlist: readonly string[]): boolean {
    if (allowlist.length === 0) return false;
    return allowlist.every((tool) => STRICT_READ_ONLY_SET.has(tool));
  }

  /** Evaluates a tool invocation at the tool layer; denies and logs any non-allowlisted or side-effecting tool. */
  authorize(toolName: string, attemptedArgs: Record<string, unknown> = {}): PatrolToolDecision {
    const normalized = toolName.trim();
    if (STRICT_READ_ONLY_SET.has(normalized) && this.mandateAllowlist.has(normalized)) {
      return { allowed: true, toolName: normalized };
    }
    const forbidden = FORBIDDEN_TOOL_PATTERNS.find(({ pattern }) => pattern.test(normalized));
    const reason = forbidden
      ? `只读巡检工具层拦截：禁止调用${forbidden.label}类工具 (${normalized})`
      : `只读巡检工具层拦截：工具 ${normalized} 不在巡检 Mandate 只读白名单内`;
    const denial: PatrolToolDenialRecord = {
      id: `pdeny_${randomUUID()}`,
      runId: this.runId,
      patrolTicketId: this.patrolTicketId,
      toolName: normalized,
      attemptedArgs,
      reason,
      blockedAt: this.now(),
    };
    this.denials.push(denial);
    this.onDenial?.(denial);
    return { allowed: false, toolName: normalized, reason, denial };
  }

  listDenials(): PatrolToolDenialRecord[] {
    return [...this.denials];
  }
}
