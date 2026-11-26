import type {
  CoreSkillCategory,
  HighImpactMemoryCategory,
  LongMemoryCategory,
  ManagedSkill,
  SkillSpec,
} from "../../shared/memory-skill.ts";
import { hashMemoryText } from "../memory-store.ts";

export const CRYSTALLIZATION_THRESHOLD = 3;
export const CURATOR_STALE_DAYS = 30;
export const CURATOR_ARCHIVE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60_000;

export const HIGH_IMPACT_CATEGORIES: ReadonlySet<LongMemoryCategory> = new Set<HighImpactMemoryCategory>([
  "whitelist",
  "payment_rule",
  "supplier_policy",
  "price_floor",
]);

export const CORE_SKILL_CATEGORIES: ReadonlySet<CoreSkillCategory> = new Set<CoreSkillCategory>([
  "procurement",
  "payment",
  "data_deletion",
]);

export const HIGH_IMPACT_PATTERNS: ReadonlyArray<{ category: HighImpactMemoryCategory; regex: RegExp; reason: string }> = [
  {
    category: "payment_rule",
    regex: /(?:付款|支付|打款|结算|预付|尾款|银行账号|收款账户|先付\s*\d+%|payment|bank\s*account)/i,
    reason: "涉及付款规则，属于高影响记忆，必须由人确认后写入长期记忆",
  },
  {
    category: "whitelist",
    regex: /(?:白名单|允许账号|授权账号|免审批名单|whitelist|allowlist)/i,
    reason: "涉及白名单变更，属于高影响记忆，必须由人确认后写入长期记忆",
  },
  {
    category: "supplier_policy",
    regex: /(?:指定供应商|全部从.*下单|以后都从.*下单|只向.*采购|切换供应商|exclusiv.*supplier)/i,
    reason: "涉及供应商选择规则，属于高影响记忆，必须由人确认后写入长期记忆",
  },
  {
    category: "price_floor",
    regex: /(?:价格底线|最低价|底价|不低于\s*\d+|price\s*floor|minimum\s*price)/i,
    reason: "涉及价格底线，属于高影响记忆，必须由人确认后写入长期记忆",
  },
];

export const POLLUTION_PATTERNS: ReadonlyArray<{
  rule: string;
  regex: RegExp;
  disposition: "dropped" | "queued_for_confirmation";
}> = [
  {
    rule: "prompt_injection_override",
    regex: /(?:ignore\s+previous\s+instructions|忽略以上|忽略之前|系统提示|system\s+prompt|越权)/i,
    disposition: "dropped",
  },
  {
    rule: "external_supplier_steering",
    regex: /(?:以后都从我这里下单|全部从我这里采购|直接把货款打到|改打到我新账号|order\s+only\s+from\s+me|wire\s+payment\s+to)/i,
    disposition: "queued_for_confirmation",
  },
];

export const GENERAL_PREFERENCE_PATTERNS: ReadonlyArray<{ category: "preference" | "rule"; key: string; regex: RegExp }> = [
  {
    category: "rule",
    key: "no_weekend_orders",
    regex: /(?:不要在周末下单|周末不下单|周末不要下单|no\s+weekend\s+orders?)/i,
  },
  {
    category: "preference",
    key: "morning_inventory_check",
    regex: /(?:每天早上查库存|早上查库存|晨间查库存|morning\s+inventory\s+check)/i,
  },
];

/** Validates all 5 mandatory elements of a skill specification. */
export function validateSkillSpec(
  spec: Partial<SkillSpec> | undefined | null,
): { ok: true; spec: SkillSpec } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!spec?.inputs || !spec.inputs.trim()) missing.push("inputs");
  if (!spec?.outputs || !spec.outputs.trim()) missing.push("outputs");
  if (!Array.isArray(spec?.tools) || spec.tools.filter((t) => typeof t === "string" && t.trim().length > 0).length === 0) {
    missing.push("tools");
  }
  if (!spec?.boundaries || !spec.boundaries.trim()) missing.push("boundaries");
  if (!spec?.failureHandling || !spec.failureHandling.trim()) missing.push("failureHandling");
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    spec: {
      inputs: spec!.inputs!.trim(),
      outputs: spec!.outputs!.trim(),
      tools: spec!.tools!.map((t) => t.trim()).filter(Boolean),
      boundaries: spec!.boundaries!.trim(),
      failureHandling: spec!.failureHandling!.trim(),
    },
  };
}

/** Deterministic SHA-256 hash of a skill's executable content for control-plane lock verification. */
export function computeSkillContentHash(payload: {
  name: string;
  description: string;
  triggerPhrases: readonly string[];
  spec: SkillSpec;
  coreCategory?: CoreSkillCategory | null;
}): string {
  const canonical = JSON.stringify({
    name: payload.name.trim(),
    description: payload.description.trim(),
    triggerPhrases: [...payload.triggerPhrases].map((p) => p.trim()).sort(),
    spec: {
      inputs: payload.spec.inputs.trim(),
      outputs: payload.spec.outputs.trim(),
      tools: [...payload.spec.tools].map((t) => t.trim()).sort(),
      boundaries: payload.spec.boundaries.trim(),
      failureHandling: payload.spec.failureHandling.trim(),
    },
    coreCategory: payload.coreCategory ?? null,
  });
  return hashMemoryText(canonical);
}

export function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[\s，。！？,.!?:：;；"'`（）()\-_]+/g, "");
}

export function isWeekendTimestamp(isoOrMs: string | number): boolean {
  const date = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return false;
  const day = typeof isoOrMs === "string" && isoOrMs.endsWith("Z") ? date.getUTCDay() : date.getDay();
  return day === 0 || day === 6;
}

export function detectHighImpactCategory(
  category: LongMemoryCategory,
  text: string,
): { category: HighImpactMemoryCategory; reason: string } | null {
  if (HIGH_IMPACT_CATEGORIES.has(category)) {
    return {
      category: category as HighImpactMemoryCategory,
      reason: `类别 ${category} 属于高影响记忆，必须由人确认后写入长期记忆`,
    };
  }
  for (const pattern of HIGH_IMPACT_PATTERNS) {
    if (pattern.regex.test(text)) {
      return { category: pattern.category, reason: pattern.reason };
    }
  }
  return null;
}

export function detectPollution(text: string): { rule: string; disposition: "dropped" | "queued_for_confirmation" } | null {
  for (const pattern of POLLUTION_PATTERNS) {
    if (pattern.regex.test(text)) {
      return { rule: pattern.rule, disposition: pattern.disposition };
    }
  }
  return null;
}

export function areSkillsDuplicate(a: ManagedSkill, b: ManagedSkill): boolean {
  const toolsA = [...a.spec.tools].map((t) => t.toLowerCase()).sort().join(",");
  const toolsB = [...b.spec.tools].map((t) => t.toLowerCase()).sort().join(",");
  if (toolsA !== toolsB) return false;
  const phrasesA = [a.name, ...a.triggerPhrases].map(normalizePhrase).filter(Boolean);
  const phrasesB = [b.name, ...b.triggerPhrases].map(normalizePhrase).filter(Boolean);
  for (const pa of phrasesA) {
    for (const pb of phrasesB) {
      if (pa.length >= 2 && pb.length >= 2 && (pa.includes(pb) || pb.includes(pa))) {
        return true;
      }
    }
  }
  return false;
}
