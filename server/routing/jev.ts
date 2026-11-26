import type { JevDecision, RoutingRole } from "../../shared/routing.ts";

export const JEV_CONFIDENCE_THRESHOLD = 0.6;
export const JEV_DEFAULT_TIMEOUT_MS = 500;

export interface JevRoster {
  managerBotId: string;
  leadBotId: string;
  botsByRole: Record<RoutingRole, string>;
}

export const DEFAULT_JEV_ROSTER: JevRoster = {
  managerBotId: "bot_chief_of_staff",
  leadBotId: "bot_chief_of_staff",
  botsByRole: {
    lead: "bot_chief_of_staff",
    procurement: "bot_procurement",
    order: "bot_order",
    followup: "bot_followup",
  },
};

export interface JevModelVerdict {
  role: RoutingRole;
  confidence: number;
  reason?: string;
}

export type JevSmallModel = (text: string, signal: AbortSignal) => Promise<JevModelVerdict>;

const CHITCHAT_PATTERNS: ReadonlyArray<RegExp> = [
  /^(你好|您好|嗨|哈喽|早安|早上好|下午好|晚上好|谢谢|辛苦了|哈哈+|hi|hello|thanks)/i,
  /(天气不错|今天天气|中午吃什么|晚饭吃什么|周末去哪|太逗了|聊聊)/i,
];

/** Deterministic fast rules executed before any small model call (sub-millisecond, zero drift). */
const ROLE_RULES: ReadonlyArray<{ role: Exclude<RoutingRole, "lead">; label: string; pattern: RegExp }> = [
  {
    role: "order",
    label: "order_action",
    pattern: /(下单|下个单|下一个.*单|采购单|付款|打款|支付|转账|取消订单|申请退款|退款|结账|place\s+order|refund|pay)/i,
  },
  {
    role: "followup",
    label: "factory_or_logistics",
    pattern: /(跟一下工厂|跟进.*厂|跟工厂|催.*工厂|工厂|打样|排产|交期|验货|质检|尾货|物流|顺丰|快递|海运|货柜|清关|头程|签收|在途|入仓|海外仓|到货)/i,
  },
  {
    role: "procurement",
    label: "inventory_or_price",
    pattern: /(查库存|库存|现货|余量|补货|盘点|安全库存|缺口|查价格|报价|单价|拿货价|拿货价格|成本价|含税价|比一下.*供应商|1688|供应商.*价|询价)/i,
  },
];

/** Strips Feishu @mention tags (e.g. `@_user_1` or `@BotName`) before classification. */
export function stripMentions(text: string): string {
  return text.replace(/@\S+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Gate Jev fast router (control-plane):
 * 1. Deterministic fixed rules first (instantaneous).
 * 2. Optional small decision model with 500ms budget & 0.6 confidence threshold.
 * 3. Unsure / timeout / error -> falls back cleanly to lead bot without creating any ticket.
 */
export async function decideWithJev(
  rawText: string,
  options?: {
    roster?: JevRoster;
    smallModel?: JevSmallModel;
    timeoutMs?: number;
    now?: () => number;
  },
): Promise<JevDecision> {
  const now = options?.now ?? Date.now;
  const startedAt = now();
  const roster = options?.roster ?? DEFAULT_JEV_ROSTER;
  const cleaned = stripMentions(rawText);

  if (!cleaned) {
    return {
      managerBotId: roster.managerBotId,
      targetRole: "lead",
      targetBotId: roster.leadBotId,
      confidence: 0,
      method: "fallback",
      fallbackToLead: true,
      reason: "empty_message_fallback_lead",
      latencyMs: Math.max(0, now() - startedAt),
    };
  }

  for (const pattern of CHITCHAT_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        managerBotId: roster.managerBotId,
        targetRole: "lead",
        targetBotId: roster.leadBotId,
        confidence: 0.95,
        method: "rule",
        fallbackToLead: false,
        reason: "chitchat_rule",
        latencyMs: Math.max(0, now() - startedAt),
      };
    }
  }

  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(cleaned)) {
      return {
        managerBotId: roster.managerBotId,
        targetRole: rule.role,
        targetBotId: roster.botsByRole[rule.role],
        confidence: 0.95,
        method: "rule",
        fallbackToLead: false,
        reason: `rule:${rule.label}`,
        latencyMs: Math.max(0, now() - startedAt),
      };
    }
  }

  if (options?.smallModel) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        options.smallModel(cleaned, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("jev_timeout"));
          }, timeoutMs);
        }),
      ]);
      if (
        verdict &&
        typeof verdict.confidence === "number" &&
        verdict.confidence >= JEV_CONFIDENCE_THRESHOLD &&
        verdict.role in roster.botsByRole
      ) {
        return {
          managerBotId: roster.managerBotId,
          targetRole: verdict.role,
          targetBotId: roster.botsByRole[verdict.role],
          confidence: verdict.confidence,
          method: "model",
          fallbackToLead: false,
          reason: verdict.reason || `model:${verdict.role}`,
          latencyMs: Math.max(0, now() - startedAt),
        };
      }
    } catch {
      // Fail open to lead bot on model error or timeout (docs/decision-model.md).
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    managerBotId: roster.managerBotId,
    targetRole: "lead",
    targetBotId: roster.leadBotId,
    confidence: 0,
    method: "fallback",
    fallbackToLead: true,
    reason: "ambiguous_fallback_lead",
    latencyMs: Math.max(0, now() - startedAt),
  };
}
