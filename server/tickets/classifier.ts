import type { TicketSource } from "../../shared/tickets.ts";

export interface ClassificationResult {
  kind: "conversation" | "side_effect" | "external_event";
  reason: string;
}

const EXTERNAL_SOURCES: ReadonlySet<TicketSource> = new Set([
  "new_order",
  "inventory_change",
  "webhook",
  "patrol",
]);

/** Deterministic code-only side-effect patterns (never delegated to an LLM to prevent drift). */
const SIDE_EFFECT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "spend_or_order", pattern: /(下单|付款|支付|转账|打款|采购|购买|买\s*\d+|退款|结账|充值|报销|place\s+order|pay|purchase|refund|transfer)/i },
  { label: "mutate_data", pattern: /(改成|改为|修改|更新|删除|删掉|移除|清空|覆盖|写入|创建|新建|取消订单|发货|入库|出库|调价|扣减|增加库存|减少库存|update|delete|remove|modify|set\s+\w+\s+to|write\s+to)/i },
  { label: "outward_message", pattern: /(发邮件|发消息|群发|通知客户|通知供应商|回复客户|发给|发送给|send\s+email|send\s+message|notify|broadcast)/i },
  { label: "long_task", pattern: /(批量处理|全量同步|定时执行|每天自动|每周自动|持续监控|定时巡检|batch\s+process|sync\s+all|schedule)/i },
];

const READ_ONLY_QUERY_PATTERNS: ReadonlyArray<RegExp> = [
  /^(查一下|查下|查询|看看|看下|帮我查|帮我看|告诉我|问一下|什么|怎么|为什么|多少|有没有|是否|你好|嗨|hi|hello|天气|今天天气)/i,
];

export function isExternalEventSource(source: TicketSource): boolean {
  return EXTERNAL_SOURCES.has(source);
}

/** Deterministic classifier: external events -> observe ticket; user chat -> side_effect or conversation. */
export function classifyIntake(input: {
  source: TicketSource;
  text: string;
  midConversationSideEffect?: boolean;
}): ClassificationResult {
  if (isExternalEventSource(input.source)) {
    return { kind: "external_event", reason: `external_source:${input.source}` };
  }
  if (input.midConversationSideEffect) {
    return { kind: "side_effect", reason: "mid_conversation_side_effect" };
  }
  const normalized = input.text.trim();
  if (!normalized) {
    return { kind: "conversation", reason: "empty_text" };
  }
  for (const { label, pattern } of SIDE_EFFECT_PATTERNS) {
    if (pattern.test(normalized)) {
      return { kind: "side_effect", reason: `matched:${label}` };
    }
  }
  for (const pattern of READ_ONLY_QUERY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { kind: "conversation", reason: "read_only_query_or_greeting" };
    }
  }
  return { kind: "conversation", reason: "default_conversation" };
}
