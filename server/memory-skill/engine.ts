import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  CoreSkillCategory,
  CuratorRunResult,
  DreamSessionMessage,
  DreamSpendSummary,
  LongMemoryCategory,
  LongTermMemoryRecord,
  ManagedSkill,
  MediumMemoryCategory,
  MediumTermMemoryRecord,
  MemoryConfirmationCard,
  MemoryPollutionEvent,
  MemoryScope,
  MemorySourceTrust,
  MinimalOntologyCategory,
  NightlyDreamResult,
  PendingConfirmationStatus,
  PendingMemoryConfirmation,
  RuleCheckResult,
  ShortMemoryCategory,
  ShortTermMemoryRecord,
  SkillChangeLogEntry,
  SkillLifecycleState,
  SkillLockDenialRecord,
  SkillVersionSnapshot,
  TenantOntologySlice,
  WorkflowOccurrenceResult,
} from "../../shared/memory-skill.ts";
import type { CanonicalInventoryItem, CanonicalOrderItem } from "../../shared/patrol.ts";
import { utcDayKey, utcMonthKey } from "../approvals/budget.ts";
import { DATA_DIR } from "../config.ts";
import { DREAM_MARKER } from "../memory-dream.ts";
import {
  CORE_SKILL_CATEGORIES,
  CRYSTALLIZATION_THRESHOLD,
  CURATOR_ARCHIVE_DAYS,
  CURATOR_STALE_DAYS,
  GENERAL_PREFERENCE_PATTERNS,
  HIGH_IMPACT_CATEGORIES,
  computeSkillContentHash,
  detectHighImpactCategory,
  detectPollution,
  isWeekendTimestamp,
  normalizePhrase,
  validateSkillSpec,
} from "./rules.ts";
import { SkillManager } from "./skill-manager.ts";
import { MemorySkillStore } from "./store.ts";

export {
  CORE_SKILL_CATEGORIES,
  CRYSTALLIZATION_THRESHOLD,
  CURATOR_ARCHIVE_DAYS,
  CURATOR_STALE_DAYS,
  HIGH_IMPACT_CATEGORIES,
  computeSkillContentHash,
  validateSkillSpec,
};

export interface MemorySkillEngineOptions {
  dbPath?: string;
  now?: () => number;
}

/**
 * Control-plane engine for MVP5 (Memory & Skills).
 * Implements 3-tier memory + 4th-tier procedural skills, read-only nightly dream,
 * memory pollution defense + human confirmation queue, Curator lifecycle, and core skill locks.
 */
export class MemorySkillEngine {
  readonly store: MemorySkillStore;
  private readonly skills: SkillManager;
  private readonly now: () => number;

  constructor(options: MemorySkillEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = new MemorySkillStore(options.dbPath ?? join(DATA_DIR, "memory-skill.sqlite"));
    this.skills = new SkillManager(this.store, this.now);
  }

  close(): void {
    this.store.close();
  }

  // --- 1. Three-Tier Memory & Same-VM Multi-Bot Scoping ---

  writeShortTerm(input: {
    tenantId: string;
    botId: string;
    sessionId: string;
    category?: ShortMemoryCategory;
    content: string;
    metadata?: Record<string, unknown>;
  }): ShortTermMemoryRecord {
    const record: ShortTermMemoryRecord = {
      id: `stm_${randomUUID()}`,
      tenantId: input.tenantId,
      botId: input.botId,
      sessionId: input.sessionId,
      scope: "bot_private",
      category: input.category ?? "working_note",
      content: input.content.trim(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: this.now(),
    };
    this.store.insertShortTerm(record);
    return record;
  }

  readShortTerm(tenantId: string, botId: string, sessionId: string): ShortTermMemoryRecord[] {
    return this.store.listShortTerm(tenantId, botId, sessionId);
  }

  clearShortTermSession(tenantId: string, botId: string, sessionId: string): number {
    return this.store.clearShortTermSession(tenantId, botId, sessionId);
  }

  writeMediumTerm(input: {
    tenantId: string;
    botId: string;
    scope?: MemoryScope;
    category: MediumMemoryCategory;
    periodKey?: string;
    summary: string;
    highlights?: string[];
  }): MediumTermMemoryRecord {
    const now = this.now();
    const record: MediumTermMemoryRecord = {
      id: `mtm_${randomUUID()}`,
      tenantId: input.tenantId,
      botId: input.botId,
      scope: input.scope ?? "user_shared",
      category: input.category,
      periodKey: input.periodKey ?? utcDayKey(now),
      summary: input.summary.trim(),
      highlights: (input.highlights ?? []).map((h) => h.trim()).filter(Boolean),
      createdAt: now,
    };
    this.store.insertMediumTerm(record);
    return record;
  }

  readMediumTerm(
    tenantId: string,
    botId: string,
    options: { category?: MediumMemoryCategory; periodKey?: string; query?: string } = {},
  ): MediumTermMemoryRecord[] {
    return this.store.listMediumTerm(tenantId, botId, options);
  }

  writeLongTerm(input: {
    tenantId: string;
    botId?: string | null;
    scope?: MemoryScope;
    category: LongMemoryCategory;
    key?: string;
    content: string;
    structured?: Record<string, unknown>;
    sourceTrust?: MemorySourceTrust;
    confirmedBy?: string | null;
    sourceExcerpt?: string;
  }): { status: "written"; memory: LongTermMemoryRecord } | { status: "pending_confirmation"; pending: PendingMemoryConfirmation } {
    const now = this.now();
    const sourceTrust: MemorySourceTrust = input.sourceTrust ?? "owner_chat";
    const detectedHighImpact = detectHighImpactCategory(input.category, input.content);
    const isHighImpact = detectedHighImpact !== null || HIGH_IMPACT_CATEGORIES.has(input.category);
    const effectiveCategory: LongMemoryCategory = detectedHighImpact?.category ?? input.category;
    const scope: MemoryScope = input.scope ?? "user_shared";
    const key =
      input.key?.trim() || `${effectiveCategory}_${normalizePhrase(input.content).slice(0, 24) || randomUUID().slice(0, 8)}`;

    if ((isHighImpact || sourceTrust === "external_content") && !input.confirmedBy) {
      const pending = this.enqueuePendingConfirmation({
        tenantId: input.tenantId,
        botId: input.botId ?? "system",
        scope,
        category: effectiveCategory,
        key,
        content: input.content.trim(),
        sourceTrust,
        sourceExcerpt: input.sourceExcerpt ?? input.content.trim(),
        reason:
          sourceTrust === "external_content"
            ? "内容来自外部来源，疑似指令注入或高风险变更，需人工确认"
            : detectedHighImpact?.reason ?? "高影响记忆必须由人确认后写入长期记忆",
      });
      return { status: "pending_confirmation", pending };
    }

    const record: LongTermMemoryRecord = {
      id: `ltm_${randomUUID()}`,
      tenantId: input.tenantId,
      botId: scope === "bot_private" ? (input.botId ?? "unknown_bot") : null,
      scope,
      category: effectiveCategory,
      key,
      content: input.content.trim(),
      ...(input.structured ? { structured: input.structured } : {}),
      highImpact: isHighImpact,
      sourceTrust,
      confirmedBy: input.confirmedBy ?? null,
      confirmedAt: input.confirmedBy ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertLongTerm(record);
    return { status: "written", memory: record };
  }

  readLongTerm(
    tenantId: string,
    botId: string,
    options: { scope?: MemoryScope; category?: LongMemoryCategory } = {},
  ): LongTermMemoryRecord[] {
    return this.store.listLongTerm(tenantId, botId, options);
  }

  getOntologySlice(input: {
    tenantId: string;
    botId: string;
    categories: readonly MinimalOntologyCategory[];
    inventory?: CanonicalInventoryItem[];
    orders?: CanonicalOrderItem[];
  }): TenantOntologySlice {
    const requested = new Set(input.categories);
    const sharedLong = this.store.listLongTerm(input.tenantId, input.botId, { scope: "user_shared" });
    return {
      tenantId: input.tenantId,
      botId: input.botId,
      requestedCategories: [...requested],
      preferences: requested.has("preference")
        ? sharedLong
            .filter((m) => m.category === "preference")
            .map((m) => ({ id: m.id, key: m.key, content: m.content, confirmedBy: m.confirmedBy, updatedAt: m.updatedAt }))
        : [],
      rules: requested.has("rule")
        ? sharedLong
            .filter((m) => m.category === "rule" || HIGH_IMPACT_CATEGORIES.has(m.category))
            .map((m) => ({
              id: m.id,
              key: m.key,
              content: m.content,
              highImpact: m.highImpact,
              confirmedBy: m.confirmedBy,
              updatedAt: m.updatedAt,
            }))
        : [],
      ...(requested.has("inventory") ? { inventory: input.inventory ?? [] } : {}),
      ...(requested.has("order") ? { orders: input.orders ?? [] } : {}),
    };
  }

  checkActionAgainstMemory(input: {
    tenantId: string;
    botId: string;
    actionText: string;
    timestamp?: string | number;
  }): RuleCheckResult {
    const memories = this.store.listLongTerm(input.tenantId, input.botId);
    const reminders: string[] = [];
    const matchedMemoryIds: string[] = [];
    let blocked = false;
    const weekend = isWeekendTimestamp(input.timestamp ?? this.now());
    const isOrderAction = /(?:下单|采购单|提交订单|place\s*order|create\s*order)/i.test(input.actionText);

    for (const mem of memories) {
      const isWeekendRule =
        mem.key === "no_weekend_orders" || /(?:不要在周末下单|周末不下单|周末不要下单|no\s+weekend\s+orders?)/i.test(mem.content);
      if (isWeekendRule && weekend && isOrderAction) {
        blocked = true;
        matchedMemoryIds.push(mem.id);
        reminders.push(`客户说过周末不下单（规则：${mem.content}），已拦截直接下单并提醒确认`);
      }
    }
    return { tenantId: input.tenantId, botId: input.botId, allowed: !blocked, blocked, reminders, matchedMemoryIds };
  }

  // --- 2. Pending Confirmations & Nightly Dream ---

  listPendingConfirmations(tenantId: string, status?: PendingConfirmationStatus): PendingMemoryConfirmation[] {
    return this.store.listPendingConfirmations(tenantId, status);
  }

  confirmPendingMemory(
    tenantId: string,
    pendingId: string,
    confirmedBy: string,
  ): { ok: true; memory: LongTermMemoryRecord; pending: PendingMemoryConfirmation } | { ok: false; error: string } {
    const pending = this.store.getPendingConfirmation(tenantId, pendingId);
    if (!pending) return { ok: false, error: "pending_confirmation_not_found" };
    if (pending.status !== "pending") return { ok: false, error: `already_${pending.status}` };
    const now = this.now();
    const memory: LongTermMemoryRecord = {
      id: `ltm_${randomUUID()}`,
      tenantId,
      botId: pending.scope === "bot_private" ? pending.botId : null,
      scope: pending.scope,
      category: pending.category,
      key: pending.key,
      content: pending.content,
      highImpact: HIGH_IMPACT_CATEGORIES.has(pending.category),
      sourceTrust: pending.sourceTrust,
      confirmedBy,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertLongTerm(memory);
    this.store.resolvePendingConfirmation(tenantId, pendingId, {
      status: "confirmed",
      resolvedAt: now,
      resolvedBy: confirmedBy,
      committedMemoryId: memory.id,
    });
    return { ok: true, memory, pending: this.store.getPendingConfirmation(tenantId, pendingId)! };
  }

  rejectPendingMemory(
    tenantId: string,
    pendingId: string,
    rejectedBy: string,
  ): { ok: true; pending: PendingMemoryConfirmation } | { ok: false; error: string } {
    const pending = this.store.getPendingConfirmation(tenantId, pendingId);
    if (!pending) return { ok: false, error: "pending_confirmation_not_found" };
    if (pending.status !== "pending") return { ok: false, error: `already_${pending.status}` };
    this.store.resolvePendingConfirmation(tenantId, pendingId, {
      status: "rejected",
      resolvedAt: this.now(),
      resolvedBy: rejectedBy,
      committedMemoryId: null,
    });
    return { ok: true, pending: this.store.getPendingConfirmation(tenantId, pendingId)! };
  }

  listPollutionEvents(tenantId: string, limit = 50): MemoryPollutionEvent[] {
    return this.store.listPollutionEvents(tenantId, limit);
  }

  getDreamSpendSummary(tenantId: string): DreamSpendSummary {
    const now = this.now();
    return this.store.getDreamSpendSummary(tenantId, utcDayKey(now), utcMonthKey(now));
  }

  runNightlyDream(input: { tenantId: string; dayKey?: string; messages: readonly DreamSessionMessage[] }): NightlyDreamResult {
    const now = this.now();
    const runId = `dream_${randomUUID()}`;
    const dayKey = input.dayKey ?? utcDayKey(now);
    const monthKey = utcMonthKey(now);

    const mediumSummariesWritten: MediumTermMemoryRecord[] = [];
    const longMemoriesWritten: LongTermMemoryRecord[] = [];
    const pendingConfirmationsCreated: PendingMemoryConfirmation[] = [];
    const pollutionEvents: MemoryPollutionEvent[] = [];
    const skillsCrystallized: ManagedSkill[] = [];
    const highlights: string[] = [];

    for (const msg of input.messages) {
      const text = msg.text.trim();
      if (!text) continue;
      const isExternal =
        msg.role === "external" ||
        msg.sourceKind === "supplier_email" ||
        msg.sourceKind === "webhook" ||
        msg.sourceKind === "web_page";

      if (isExternal) {
        const pollution = detectPollution(text);
        if (pollution) {
          const event: MemoryPollutionEvent = {
            id: `pol_${randomUUID()}`,
            tenantId: input.tenantId,
            runId,
            sourceKind: msg.sourceKind ?? "external",
            excerpt: text.slice(0, 240),
            matchedRule: pollution.rule,
            disposition: pollution.disposition,
            recordedAt: now,
          };
          this.store.insertPollutionEvent(event);
          pollutionEvents.push(event);
          if (pollution.disposition === "queued_for_confirmation") {
            pendingConfirmationsCreated.push(
              this.enqueuePendingConfirmation({
                tenantId: input.tenantId,
                botId: msg.botId,
                scope: "user_shared",
                category: "supplier_policy",
                key: `external_candidate_${randomUUID().slice(0, 8)}`,
                content: text,
                sourceTrust: "external_content",
                sourceExcerpt: text.slice(0, 240),
                reason: `外部内容（${msg.sourceKind ?? "external"}）包含潜在指令注入，复盘禁止直接写入长期记忆`,
              }),
            );
          }
          continue;
        }
        highlights.push(`[外部摘要:${msg.sourceKind ?? "external"}] ${text.slice(0, 80)}`);
        continue;
      }

      if (msg.role === "owner") {
        highlights.push(text.slice(0, 100));
        const highImpact = detectHighImpactCategory("rule", text);
        if (highImpact) {
          pendingConfirmationsCreated.push(
            this.enqueuePendingConfirmation({
              tenantId: input.tenantId,
              botId: msg.botId,
              scope: "user_shared",
              category: highImpact.category,
              key: `${highImpact.category}_${normalizePhrase(text).slice(0, 20) || randomUUID().slice(0, 6)}`,
              content: text,
              sourceTrust: "owner_chat",
              sourceExcerpt: text.slice(0, 240),
              reason: highImpact.reason,
            }),
          );
        } else {
          for (const pattern of GENERAL_PREFERENCE_PATTERNS) {
            if (pattern.regex.test(text)) {
              const existing = this.store
                .listLongTerm(input.tenantId, msg.botId, { scope: "user_shared" })
                .find((item) => item.key === pattern.key);
              if (!existing) {
                const res = this.writeLongTerm({
                  tenantId: input.tenantId,
                  botId: msg.botId,
                  scope: "user_shared",
                  category: pattern.category,
                  key: pattern.key,
                  content: text,
                  sourceTrust: "owner_chat",
                });
                if (res.status === "written") longMemoriesWritten.push(res.memory);
              }
            }
          }
        }
      }

      if (msg.workflowKey) {
        const obs = this.skills.recordWorkflowOccurrence({
          tenantId: input.tenantId,
          workflowKey: msg.workflowKey,
          workflowName: msg.workflowName ?? msg.workflowKey,
          triggerPhrases: msg.triggerPhrases,
          spec: msg.workflowSpec,
          actor: "nightly-dream",
        });
        if (obs.crystallized && obs.skill) skillsCrystallized.push(obs.skill);
      }
    }

    if (input.messages.length > 0) {
      mediumSummariesWritten.push(
        this.writeMediumTerm({
          tenantId: input.tenantId,
          botId: input.messages[0]!.botId,
          scope: "user_shared",
          category: "daily_summary",
          periodKey: dayKey,
          summary: `每晚复盘（${dayKey}）：处理 ${input.messages.length} 条会话记录，新增长期记忆 ${longMemoriesWritten.length} 条，待人工确认 ${pendingConfirmationsCreated.length} 条，拦截污染 ${pollutionEvents.length} 条。`,
          highlights: highlights.slice(0, 10),
        }),
      );
    }

    const charCount = input.messages.reduce((sum, m) => sum + m.text.length, 0);
    const inputTokens = Math.max(120, Math.ceil(charCount * 0.6));
    const outputTokens = Math.max(60, 40 + longMemoriesWritten.length * 30 + pendingConfirmationsCreated.length * 35);
    const costUsd = Number(((inputTokens * 0.00000015) + (outputTokens * 0.0000006)).toFixed(6));
    const tokenUsage = { inputTokens, outputTokens, costUsd };
    this.store.recordDreamTokenUsage(input.tenantId, runId, dayKey, monthKey, tokenUsage, now);

    return {
      runId,
      tenantId: input.tenantId,
      dayKey,
      ranAt: now,
      dreamMarker: DREAM_MARKER,
      mediumSummariesWritten,
      longMemoriesWritten,
      pendingConfirmationsCreated,
      pollutionEvents,
      skillsCrystallized,
      sideEffects: { ticketsCreated: 0, moneySpent: 0, messagesSent: 0, toolsExecuted: 0 },
      tokenUsage,
    };
  }

  private enqueuePendingConfirmation(input: {
    tenantId: string;
    botId: string;
    scope: MemoryScope;
    category: LongMemoryCategory;
    key: string;
    content: string;
    sourceTrust: MemorySourceTrust;
    sourceExcerpt: string;
    reason: string;
  }): PendingMemoryConfirmation {
    const id = `pmc_${randomUUID()}`;
    const feishuCard: MemoryConfirmationCard = {
      cardId: `feishu_mem_card_${id.slice(4, 16)}`,
      title: `待确认高影响记忆（${input.category}）`,
      category: input.category,
      proposedContent: input.content,
      sourceExcerpt: input.sourceExcerpt,
      reason: input.reason,
      actions: ["confirm", "reject"],
    };
    const record: PendingMemoryConfirmation = {
      id,
      ...input,
      status: "pending",
      feishuCard,
      createdAt: this.now(),
      resolvedAt: null,
      resolvedBy: null,
      committedMemoryId: null,
    };
    this.store.insertPendingConfirmation(record);
    return record;
  }

  // --- 3. Delegated Procedural Skill Methods ---

  recordWorkflowOccurrence(input: Parameters<SkillManager["recordWorkflowOccurrence"]>[0]): WorkflowOccurrenceResult {
    return this.skills.recordWorkflowOccurrence(input);
  }

  createSkill(input: Parameters<SkillManager["createSkill"]>[0]): ReturnType<SkillManager["createSkill"]> {
    return this.skills.createSkill(input);
  }

  updateSkill(input: Parameters<SkillManager["updateSkill"]>[0]): ReturnType<SkillManager["updateSkill"]> {
    return this.skills.updateSkill(input);
  }

  loadSkillForRuntime(input: Parameters<SkillManager["loadSkillForRuntime"]>[0]): ReturnType<SkillManager["loadSkillForRuntime"]> {
    return this.skills.loadSkillForRuntime(input);
  }

  rollbackSkill(input: Parameters<SkillManager["rollbackSkill"]>[0]): ReturnType<SkillManager["rollbackSkill"]> {
    return this.skills.rollbackSkill(input);
  }

  matchSkillByPhrase(
    tenantId: string,
    phrase: string,
    options?: { includeStale?: boolean; recordUse?: boolean },
  ): ManagedSkill | null {
    return this.skills.matchSkillByPhrase(tenantId, phrase, options);
  }

  listSkills(tenantId: string, options?: { lifecycles?: readonly SkillLifecycleState[] }): ManagedSkill[] {
    return this.skills.listSkills(tenantId, options);
  }

  listSkillVersions(tenantId: string, skillId: string): SkillVersionSnapshot[] {
    return this.skills.listSkillVersions(tenantId, skillId);
  }

  listSkillChangeLogs(tenantId: string, skillId?: string): SkillChangeLogEntry[] {
    return this.skills.listSkillChangeLogs(tenantId, skillId);
  }

  listSkillLockDenials(tenantId: string, limit?: number): SkillLockDenialRecord[] {
    return this.skills.listSkillLockDenials(tenantId, limit);
  }

  runCurator(tenantId: string): CuratorRunResult {
    return this.skills.runCurator(tenantId);
  }
}

export type { CoreSkillCategory };
