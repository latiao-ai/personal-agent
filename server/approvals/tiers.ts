import type { ActionCategory, ApprovalTier } from "../../shared/approvals.ts";

export interface ReviewerRequest {
  ticketId: string;
  actionSummary: string;
  toolName: string;
  category: ActionCategory;
  tokenCost: number;
  businessCost: number;
}

export interface ReviewerVerdict {
  /** Reviewer may only suggest keeping tier 2 or escalating to 3 / 4; never downgrades. */
  suggestedTier: number;
  reason?: string;
}

export type ApprovalReviewer = (request: ReviewerRequest, signal: AbortSignal) => Promise<ReviewerVerdict>;

const HIGH_RISK_SPEND_PATTERN = /(下单|付款|支付|转账|打款|采购|购买|买\s*\d+|退款|结账|充值|报销|place_order|pay|purchase|refund|transfer)/i;
const DELETE_DATA_PATTERN = /(删除|删掉|清空|移除|销毁|drop|delete|remove|purge)/i;
const OUTWARD_MESSAGE_PATTERN = /(发邮件|发消息|群发|通知客户|通知供应商|回复客户|发给|发送给|send_email|send_message|notify_external|broadcast)/i;
const READ_ONLY_PATTERN = /(查一下|查下|查询|查库存|查订单|查价格|查物流|看看|看下|read|get_|list_|query_|fetch_)/i;

/** Deterministic code classification of action category when not explicitly supplied. */
export function inferActionCategory(actionSummary: string, toolName: string, businessCost: number): ActionCategory {
  const combined = `${actionSummary} ${toolName}`.trim();
  if (businessCost > 0 || HIGH_RISK_SPEND_PATTERN.test(combined)) return "high_risk_spend";
  if (DELETE_DATA_PATTERN.test(combined)) return "delete_data";
  if (OUTWARD_MESSAGE_PATTERN.test(combined)) return "outward_message";
  if (READ_ONLY_PATTERN.test(combined)) return "read_only";
  return "low_risk_write";
}

export function isMandatoryHumanCategory(category: ActionCategory): boolean {
  return category === "high_risk_spend" || category === "delete_data" || category === "outward_message";
}

/**
 * Runs the optional review model for tier-2 low-risk writes with strict fail-closed guards:
 * - Never allowed to lower risk below the floor tier (2 for low_risk_write, 3 for spend/delete/outward).
 * - Timeout, thrown error, or unparseable output always escalates to tier 3 ("ask_human").
 */
export async function runGuardedReviewer(
  reviewer: ApprovalReviewer | undefined,
  request: ReviewerRequest,
  floorTier: ApprovalTier,
  timeoutMs: number,
): Promise<{ tier: ApprovalTier; reason: string }> {
  // Mandatory human-approval actions never rely on reviewer approval; even if invoked, floor is >= 3.
  const effectiveFloor: ApprovalTier = isMandatoryHumanCategory(request.category)
    ? (Math.max(floorTier, 3) as ApprovalTier)
    : floorTier;

  if (!reviewer) {
    return { tier: effectiveFloor, reason: "no_reviewer_configured_keep_floor" };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("reviewer_timeout"));
      }, timeoutMs);
    });
    const verdict = await Promise.race([reviewer(request, controller.signal), timeoutPromise]);
    if (
      !verdict ||
      typeof verdict !== "object" ||
      typeof verdict.suggestedTier !== "number" ||
      !Number.isInteger(verdict.suggestedTier) ||
      verdict.suggestedTier < 1 ||
      verdict.suggestedTier > 4
    ) {
      return { tier: Math.max(effectiveFloor, 3) as ApprovalTier, reason: "reviewer_unparseable_escalated_to_human" };
    }
    // Reviewer can only escalate risk upward, never downgrade below the deterministic code floor.
    const clamped = Math.max(effectiveFloor, verdict.suggestedTier) as ApprovalTier;
    const reason =
      verdict.suggestedTier < effectiveFloor
        ? `reviewer_downgrade_blocked:${verdict.suggestedTier}->${clamped}`
        : verdict.reason || `reviewer_verdict_tier_${clamped}`;
    return { tier: clamped, reason };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      tier: Math.max(effectiveFloor, 3) as ApprovalTier,
      reason: msg === "reviewer_timeout" ? "reviewer_timeout_escalated_to_human" : `reviewer_error_escalated_to_human:${msg}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
