import type { CanonicalInventoryItem, CanonicalOrderItem } from "./patrol.ts";

/** Retention-based memory tiers (distinct from procedural skills as the 4th tier). */
export type MemoryTier = "short" | "medium" | "long";

/** Visibility within the same single-user VM across multiple bots. */
export type MemoryScope = "user_shared" | "bot_private";

export type ShortMemoryCategory = "session_context" | "active_ticket" | "working_note";
export type MediumMemoryCategory = "daily_summary" | "weekly_summary";
export type GeneralLongMemoryCategory = "preference" | "rule";
export type HighImpactMemoryCategory =
  | "whitelist"
  | "payment_rule"
  | "supplier_policy"
  | "price_floor";
export type LongMemoryCategory = GeneralLongMemoryCategory | HighImpactMemoryCategory;
export type MemoryCategory = ShortMemoryCategory | MediumMemoryCategory | LongMemoryCategory;

export type MemorySourceTrust = "owner_chat" | "external_content" | "bot_inference";

/** Short-term working memory: lives only within one active session, never promoted directly to long-term. */
export interface ShortTermMemoryRecord {
  id: string;
  tenantId: string;
  botId: string;
  sessionId: string;
  scope: "bot_private";
  category: ShortMemoryCategory;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** Medium-term memory: daily or weekly summaries with searchable text. */
export interface MediumTermMemoryRecord {
  id: string;
  tenantId: string;
  botId: string;
  scope: MemoryScope;
  category: MediumMemoryCategory;
  periodKey: string;
  summary: string;
  highlights: string[];
  createdAt: number;
}

/** Long-term memory: durable customer preferences, rules, and human-confirmed high-impact policies. */
export interface LongTermMemoryRecord {
  id: string;
  tenantId: string;
  botId: string | null;
  scope: MemoryScope;
  category: LongMemoryCategory;
  key: string;
  content: string;
  structured?: Record<string, unknown>;
  highImpact: boolean;
  sourceTrust: MemorySourceTrust;
  confirmedBy: string | null;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type PendingConfirmationStatus = "pending" | "confirmed" | "rejected";

/** Feishu-compatible card payload for confirming high-impact memories one by one. */
export interface MemoryConfirmationCard {
  cardId: string;
  title: string;
  category: LongMemoryCategory;
  proposedContent: string;
  sourceExcerpt: string;
  reason: string;
  actions: readonly ["confirm", "reject"];
}

/** Control-plane queue entry for high-impact or untrusted memory proposals awaiting human confirmation. */
export interface PendingMemoryConfirmation {
  id: string;
  tenantId: string;
  botId: string;
  scope: MemoryScope;
  category: LongMemoryCategory;
  key: string;
  content: string;
  sourceTrust: MemorySourceTrust;
  sourceExcerpt: string;
  reason: string;
  status: PendingConfirmationStatus;
  feishuCard: MemoryConfirmationCard;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  committedMemoryId: string | null;
}

/** Audit entry when nightly dream drops or quarantines external prompt-injection content. */
export interface MemoryPollutionEvent {
  id: string;
  tenantId: string;
  runId: string;
  sourceKind: string;
  excerpt: string;
  matchedRule: string;
  disposition: "dropped" | "queued_for_confirmation";
  recordedAt: number;
}

/** Minimal Ontology extension beyond MVP4 inventory & order canonical fields (no full 10-entity graph). */
export type MinimalOntologyCategory = "inventory" | "order" | "preference" | "rule";

export interface CanonicalPreferenceSlice {
  id: string;
  key: string;
  content: string;
  confirmedBy: string | null;
  updatedAt: number;
}

export interface CanonicalRuleSlice {
  id: string;
  key: string;
  content: string;
  highImpact: boolean;
  confirmedBy: string | null;
  updatedAt: number;
}

export interface TenantOntologySlice {
  tenantId: string;
  botId: string;
  requestedCategories: MinimalOntologyCategory[];
  preferences: CanonicalPreferenceSlice[];
  rules: CanonicalRuleSlice[];
  inventory?: CanonicalInventoryItem[];
  orders?: CanonicalOrderItem[];
}

/** Message input fed into nightly dream review (read-only analysis, no tools). */
export interface DreamSessionMessage {
  sessionId: string;
  botId: string;
  role: "owner" | "bot" | "external";
  sourceKind?: "chat" | "supplier_email" | "webhook" | "web_page";
  text: string;
  timestamp?: string;
  workflowKey?: string;
  workflowName?: string;
  workflowSpec?: Partial<SkillSpec>;
  triggerPhrases?: string[];
}

export interface DreamTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DreamSpendSummary {
  tenantId: string;
  dayKey: string;
  monthKey: string;
  dayTokens: number;
  monthTokens: number;
  dayCostUsd: number;
  monthCostUsd: number;
  runCount: number;
}

export interface NightlyDreamResult {
  runId: string;
  tenantId: string;
  dayKey: string;
  ranAt: number;
  dreamMarker: string;
  mediumSummariesWritten: MediumTermMemoryRecord[];
  longMemoriesWritten: LongTermMemoryRecord[];
  pendingConfirmationsCreated: PendingMemoryConfirmation[];
  pollutionEvents: MemoryPollutionEvent[];
  skillsCrystallized: ManagedSkill[];
  /** Dream is strictly memory-write only: zero tickets, zero spend, zero messages, zero tools. */
  sideEffects: {
    ticketsCreated: 0;
    moneySpent: 0;
    messagesSent: 0;
    toolsExecuted: 0;
  };
  tokenUsage: DreamTokenUsage;
}

export interface RuleCheckResult {
  tenantId: string;
  botId: string;
  allowed: boolean;
  blocked: boolean;
  reminders: string[];
  matchedMemoryIds: string[];
}

/** Mandatory five elements required before a repeated workflow can be crystallized into a skill. */
export interface SkillSpec {
  inputs: string;
  outputs: string;
  tools: string[];
  boundaries: string;
  failureHandling: string;
}

/** Only these 3 core skill categories are locked in MVP5; all other skills are freely editable by agents. */
export type CoreSkillCategory = "procurement" | "payment" | "data_deletion";

export type SkillLifecycleState = "active" | "stale" | "archived";

export interface ManagedSkill {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  triggerPhrases: string[];
  spec: SkillSpec;
  isCore: boolean;
  coreCategory: CoreSkillCategory | null;
  lifecycle: SkillLifecycleState;
  version: number;
  contentHash: string;
  usageCount: number;
  lastUsedAt: number;
  mergedIntoSkillId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersionSnapshot {
  id: string;
  tenantId: string;
  skillId: string;
  version: number;
  name: string;
  description: string;
  triggerPhrases: string[];
  spec: SkillSpec;
  contentHash: string;
  actor: string;
  actorType: "agent" | "human" | "curator";
  reason: string;
  createdAt: number;
}

export interface SkillChangeLogEntry {
  id: string;
  tenantId: string;
  skillId: string;
  action: "created" | "updated" | "rolled_back" | "merged" | "lifecycle_changed";
  fromVersion: number | null;
  toVersion: number;
  actor: string;
  actorType: "agent" | "human" | "curator";
  summary: string;
  createdAt: number;
}

export interface SkillLockDenialRecord {
  id: string;
  tenantId: string;
  skillId: string;
  skillName: string;
  coreCategory: CoreSkillCategory;
  actor: string;
  reason: string;
  expectedHash: string;
  actualHash: string | null;
  recordedAt: number;
}

export interface WorkflowOccurrenceResult {
  tenantId: string;
  workflowKey: string;
  occurrences: number;
  crystallized: boolean;
  skill: ManagedSkill | null;
  missingSpecFields: string[];
}

export interface CuratorRunResult {
  tenantId: string;
  ranAt: number;
  markedStale: string[];
  archived: string[];
  merged: Array<{ duplicateSkillId: string; canonicalSkillId: string }>;
  skippedCoreSkills: string[];
}
