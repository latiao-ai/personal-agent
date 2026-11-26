import { randomUUID } from "node:crypto";

import type {
  CoreSkillCategory,
  CuratorRunResult,
  ManagedSkill,
  SkillChangeLogEntry,
  SkillLifecycleState,
  SkillLockDenialRecord,
  SkillSpec,
  SkillVersionSnapshot,
  WorkflowOccurrenceResult,
} from "../../shared/memory-skill.ts";
import {
  CORE_SKILL_CATEGORIES,
  CRYSTALLIZATION_THRESHOLD,
  CURATOR_ARCHIVE_DAYS,
  CURATOR_STALE_DAYS,
  DAY_MS,
  areSkillsDuplicate,
  computeSkillContentHash,
  normalizePhrase,
  validateSkillSpec,
} from "./rules.ts";
import type { MemorySkillStore } from "./store.ts";

/** Manages 4th-tier procedural skills: 3x crystallization, tenant isolation, Curator lifecycle, and core skill locks. */
export class SkillManager {
  private readonly store: MemorySkillStore;
  private readonly now: () => number;

  constructor(store: MemorySkillStore, now: () => number) {
    this.store = store;
    this.now = now;
  }

  recordWorkflowOccurrence(input: {
    tenantId: string;
    workflowKey: string;
    workflowName: string;
    description?: string;
    triggerPhrases?: string[];
    spec?: Partial<SkillSpec>;
    actor?: string;
  }): WorkflowOccurrenceResult {
    const now = this.now();
    const tracked = this.store.incrementWorkflowOccurrence(input.tenantId, input.workflowKey, input.workflowName, now);
    if (tracked.crystallizedSkillId) {
      const existing = this.store.getSkill(input.tenantId, tracked.crystallizedSkillId);
      return {
        tenantId: input.tenantId,
        workflowKey: input.workflowKey,
        occurrences: tracked.occurrences,
        crystallized: Boolean(existing),
        skill: existing,
        missingSpecFields: [],
      };
    }

    if (tracked.occurrences < CRYSTALLIZATION_THRESHOLD) {
      return {
        tenantId: input.tenantId,
        workflowKey: input.workflowKey,
        occurrences: tracked.occurrences,
        crystallized: false,
        skill: null,
        missingSpecFields: [],
      };
    }

    const validated = validateSkillSpec(input.spec);
    if (!validated.ok) {
      return {
        tenantId: input.tenantId,
        workflowKey: input.workflowKey,
        occurrences: tracked.occurrences,
        crystallized: false,
        skill: null,
        missingSpecFields: validated.missing,
      };
    }

    const created = this.createSkill({
      tenantId: input.tenantId,
      name: input.workflowName,
      description: input.description ?? `重复 ${tracked.occurrences} 次后自动沉淀的技能：${input.workflowName}`,
      triggerPhrases: input.triggerPhrases?.length ? input.triggerPhrases : [input.workflowName],
      spec: validated.spec,
      actor: input.actor ?? "agent",
      actorType: "agent",
    });
    if (!created.ok) {
      return {
        tenantId: input.tenantId,
        workflowKey: input.workflowKey,
        occurrences: tracked.occurrences,
        crystallized: false,
        skill: null,
        missingSpecFields: created.missingSpecFields ?? [],
      };
    }
    this.store.markWorkflowCrystallized(input.tenantId, input.workflowKey, created.skill.id);
    return {
      tenantId: input.tenantId,
      workflowKey: input.workflowKey,
      occurrences: tracked.occurrences,
      crystallized: true,
      skill: created.skill,
      missingSpecFields: [],
    };
  }

  createSkill(input: {
    tenantId: string;
    name: string;
    description: string;
    triggerPhrases: string[];
    spec: Partial<SkillSpec>;
    coreCategory?: CoreSkillCategory | null;
    actor: string;
    actorType: "agent" | "human";
  }): { ok: true; skill: ManagedSkill } | { ok: false; error: string; missingSpecFields?: string[] } {
    const validated = validateSkillSpec(input.spec);
    if (!validated.ok) {
      return { ok: false, error: "incomplete_skill_spec", missingSpecFields: validated.missing };
    }
    const coreCategory = input.coreCategory ?? null;
    const isCore = coreCategory !== null && CORE_SKILL_CATEGORIES.has(coreCategory);
    if (isCore && input.actorType !== "human") {
      return { ok: false, error: "core_skill_requires_human" };
    }
    const now = this.now();
    const triggerPhrases = [...new Set(input.triggerPhrases.map((p) => p.trim()).filter(Boolean))];
    if (triggerPhrases.length === 0) triggerPhrases.push(input.name.trim());
    const contentHash = computeSkillContentHash({
      name: input.name,
      description: input.description,
      triggerPhrases,
      spec: validated.spec,
      coreCategory,
    });
    const skill: ManagedSkill = {
      id: `sk_${randomUUID()}`,
      tenantId: input.tenantId,
      name: input.name.trim(),
      description: input.description.trim(),
      triggerPhrases,
      spec: validated.spec,
      isCore,
      coreCategory,
      lifecycle: "active",
      version: 1,
      contentHash,
      usageCount: 0,
      lastUsedAt: now,
      mergedIntoSkillId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveSkill(skill);
    if (isCore && coreCategory) {
      this.store.upsertCoreSkillLock(skill.id, input.tenantId, coreCategory, contentHash, input.actor, now);
    }
    this.store.insertSkillVersion({
      id: `sv_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: skill.id,
      version: 1,
      name: skill.name,
      description: skill.description,
      triggerPhrases: skill.triggerPhrases,
      spec: skill.spec,
      contentHash,
      actor: input.actor,
      actorType: input.actorType,
      reason: "initial_creation",
      createdAt: now,
    });
    this.store.insertSkillChangeLog({
      id: `scl_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: skill.id,
      action: "created",
      fromVersion: null,
      toVersion: 1,
      actor: input.actor,
      actorType: input.actorType,
      summary: `创建技能 ${skill.name}${isCore ? `（核心锁：${coreCategory}）` : ""}`,
      createdAt: now,
    });
    return { ok: true, skill };
  }

  updateSkill(input: {
    tenantId: string;
    skillId: string;
    name?: string;
    description?: string;
    triggerPhrases?: string[];
    spec?: Partial<SkillSpec>;
    actor: string;
    actorType: "agent" | "human";
    reason?: string;
  }): { ok: true; skill: ManagedSkill } | { ok: false; error: string; missingSpecFields?: string[]; denial?: SkillLockDenialRecord } {
    const existing = this.store.getSkill(input.tenantId, input.skillId);
    if (!existing) return { ok: false, error: "skill_not_found" };

    if (existing.isCore && existing.coreCategory && input.actorType !== "human") {
      const lock = this.store.getCoreSkillLock(input.tenantId, existing.id);
      const denial: SkillLockDenialRecord = {
        id: `sld_${randomUUID()}`,
        tenantId: input.tenantId,
        skillId: existing.id,
        skillName: existing.name,
        coreCategory: existing.coreCategory,
        actor: input.actor,
        reason: `核心技能 ${existing.name}（${existing.coreCategory}）已锁定，Agent 禁止修改`,
        expectedHash: lock?.expectedHash ?? existing.contentHash,
        actualHash: null,
        recordedAt: this.now(),
      };
      this.store.insertSkillLockDenial(denial);
      return { ok: false, error: "core_skill_locked", denial };
    }

    const mergedSpec: Partial<SkillSpec> = {
      inputs: input.spec?.inputs ?? existing.spec.inputs,
      outputs: input.spec?.outputs ?? existing.spec.outputs,
      tools: input.spec?.tools ?? existing.spec.tools,
      boundaries: input.spec?.boundaries ?? existing.spec.boundaries,
      failureHandling: input.spec?.failureHandling ?? existing.spec.failureHandling,
    };
    const validated = validateSkillSpec(mergedSpec);
    if (!validated.ok) {
      return { ok: false, error: "incomplete_skill_spec", missingSpecFields: validated.missing };
    }

    const now = this.now();
    const nextVersion = existing.version + 1;
    const nextName = input.name?.trim() || existing.name;
    const nextDescription = input.description?.trim() || existing.description;
    const nextPhrases = input.triggerPhrases?.length
      ? [...new Set(input.triggerPhrases.map((p) => p.trim()).filter(Boolean))]
      : existing.triggerPhrases;
    const contentHash = computeSkillContentHash({
      name: nextName,
      description: nextDescription,
      triggerPhrases: nextPhrases,
      spec: validated.spec,
      coreCategory: existing.coreCategory,
    });

    const updated: ManagedSkill = {
      ...existing,
      name: nextName,
      description: nextDescription,
      triggerPhrases: nextPhrases,
      spec: validated.spec,
      version: nextVersion,
      contentHash,
      updatedAt: now,
    };
    this.store.saveSkill(updated);
    if (updated.isCore && updated.coreCategory) {
      this.store.upsertCoreSkillLock(updated.id, input.tenantId, updated.coreCategory, contentHash, input.actor, now);
    }
    this.store.insertSkillVersion({
      id: `sv_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: updated.id,
      version: nextVersion,
      name: updated.name,
      description: updated.description,
      triggerPhrases: updated.triggerPhrases,
      spec: updated.spec,
      contentHash,
      actor: input.actor,
      actorType: input.actorType,
      reason: input.reason?.trim() || "skill_updated",
      createdAt: now,
    });
    this.store.insertSkillChangeLog({
      id: `scl_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: updated.id,
      action: "updated",
      fromVersion: existing.version,
      toVersion: nextVersion,
      actor: input.actor,
      actorType: input.actorType,
      summary: input.reason?.trim() || `由 ${input.actor}（${input.actorType}）更新至 v${nextVersion}`,
      createdAt: now,
    });
    return { ok: true, skill: updated };
  }

  loadSkillForRuntime(input: {
    tenantId: string;
    skillId: string;
    actor?: string;
    runtimePayload?: { name: string; description: string; triggerPhrases: string[]; spec: SkillSpec };
  }): { ok: true; skill: ManagedSkill; hashVerified: boolean } | { ok: false; error: string; denial?: SkillLockDenialRecord } {
    const skill = this.store.getSkill(input.tenantId, input.skillId);
    if (!skill) return { ok: false, error: "skill_not_found" };

    if (skill.isCore && skill.coreCategory) {
      const lock = this.store.getCoreSkillLock(input.tenantId, skill.id);
      const expectedHash = lock?.expectedHash ?? skill.contentHash;
      const actualHash = input.runtimePayload
        ? computeSkillContentHash({ ...input.runtimePayload, coreCategory: skill.coreCategory })
        : skill.contentHash;
      if (actualHash !== expectedHash) {
        const denial: SkillLockDenialRecord = {
          id: `sld_${randomUUID()}`,
          tenantId: input.tenantId,
          skillId: skill.id,
          skillName: skill.name,
          coreCategory: skill.coreCategory,
          actor: input.actor ?? "runtime",
          reason: `核心技能 ${skill.name} 运行时哈希校验不一致，拒绝加载`,
          expectedHash,
          actualHash,
          recordedAt: this.now(),
        };
        this.store.insertSkillLockDenial(denial);
        return { ok: false, error: "core_skill_hash_mismatch", denial };
      }
      return { ok: true, skill, hashVerified: true };
    }
    return { ok: true, skill, hashVerified: true };
  }

  rollbackSkill(input: {
    tenantId: string;
    skillId: string;
    targetVersion?: number;
    actor: string;
    actorType: "agent" | "human";
  }): { ok: true; skill: ManagedSkill; rolledBackFrom: number; restoredSnapshotVersion: number } | { ok: false; error: string } {
    const existing = this.store.getSkill(input.tenantId, input.skillId);
    if (!existing) return { ok: false, error: "skill_not_found" };
    if (existing.isCore && input.actorType !== "human") return { ok: false, error: "core_skill_locked" };
    const versions = this.store.listSkillVersions(input.tenantId, input.skillId);
    const targetVersion = input.targetVersion ?? existing.version - 1;
    const snapshot = versions.find((v) => v.version === targetVersion);
    if (!snapshot) return { ok: false, error: "target_version_not_found" };

    const now = this.now();
    const nextVersion = existing.version + 1;
    const restored: ManagedSkill = {
      ...existing,
      name: snapshot.name,
      description: snapshot.description,
      triggerPhrases: snapshot.triggerPhrases,
      spec: snapshot.spec,
      version: nextVersion,
      contentHash: snapshot.contentHash,
      updatedAt: now,
    };
    this.store.saveSkill(restored);
    if (restored.isCore && restored.coreCategory) {
      this.store.upsertCoreSkillLock(restored.id, input.tenantId, restored.coreCategory, restored.contentHash, input.actor, now);
    }
    this.store.insertSkillVersion({
      id: `sv_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: restored.id,
      version: nextVersion,
      name: restored.name,
      description: restored.description,
      triggerPhrases: restored.triggerPhrases,
      spec: restored.spec,
      contentHash: restored.contentHash,
      actor: input.actor,
      actorType: input.actorType,
      reason: `rollback_to_v${snapshot.version}`,
      createdAt: now,
    });
    this.store.insertSkillChangeLog({
      id: `scl_${randomUUID()}`,
      tenantId: input.tenantId,
      skillId: restored.id,
      action: "rolled_back",
      fromVersion: existing.version,
      toVersion: nextVersion,
      actor: input.actor,
      actorType: input.actorType,
      summary: `回滚到 v${snapshot.version}（新版本号 v${nextVersion}）`,
      createdAt: now,
    });
    return { ok: true, skill: restored, rolledBackFrom: existing.version, restoredSnapshotVersion: snapshot.version };
  }

  matchSkillByPhrase(
    tenantId: string,
    phrase: string,
    options: { includeStale?: boolean; recordUse?: boolean } = {},
  ): ManagedSkill | null {
    const norm = normalizePhrase(phrase);
    if (!norm) return null;
    const lifecycles: SkillLifecycleState[] = options.includeStale ? ["active", "stale"] : ["active"];
    const candidates = this.store.listSkills(tenantId, { lifecycles });
    const matched = candidates.find((skill) => {
      if (normalizePhrase(skill.name) === norm) return true;
      return skill.triggerPhrases.some((tp) => {
        const ntp = normalizePhrase(tp);
        return ntp.length > 0 && (norm.includes(ntp) || ntp.includes(norm));
      });
    });
    if (!matched) return null;
    if (options.recordUse !== false) {
      const now = this.now();
      const touched: ManagedSkill = { ...matched, usageCount: matched.usageCount + 1, lastUsedAt: now, updatedAt: now };
      this.store.saveSkill(touched);
      return touched;
    }
    return matched;
  }

  listSkills(tenantId: string, options: { lifecycles?: readonly SkillLifecycleState[] } = {}): ManagedSkill[] {
    return this.store.listSkills(tenantId, options);
  }

  listSkillVersions(tenantId: string, skillId: string): SkillVersionSnapshot[] {
    return this.store.listSkillVersions(tenantId, skillId);
  }

  listSkillChangeLogs(tenantId: string, skillId?: string): SkillChangeLogEntry[] {
    return this.store.listSkillChangeLogs(tenantId, skillId);
  }

  listSkillLockDenials(tenantId: string, limit = 50): SkillLockDenialRecord[] {
    return this.store.listSkillLockDenials(tenantId, limit);
  }

  runCurator(tenantId: string): CuratorRunResult {
    const now = this.now();
    const skills = this.store.listSkills(tenantId);
    const markedStale: string[] = [];
    const archived: string[] = [];
    const merged: Array<{ duplicateSkillId: string; canonicalSkillId: string }> = [];
    const skippedCoreSkills: string[] = [];

    for (const skill of skills) {
      if (skill.isCore) {
        skippedCoreSkills.push(skill.id);
        continue;
      }
      if (skill.lifecycle === "archived") continue;
      const idleDays = (now - skill.lastUsedAt) / DAY_MS;
      if (idleDays >= CURATOR_ARCHIVE_DAYS) {
        this.store.saveSkill({ ...skill, lifecycle: "archived", updatedAt: now });
        this.store.insertSkillChangeLog({
          id: `scl_${randomUUID()}`,
          tenantId,
          skillId: skill.id,
          action: "lifecycle_changed",
          fromVersion: skill.version,
          toVersion: skill.version,
          actor: "curator",
          actorType: "curator",
          summary: `超过 ${CURATOR_ARCHIVE_DAYS} 天未使用，归档技能 ${skill.name}`,
          createdAt: now,
        });
        archived.push(skill.id);
      } else if (idleDays >= CURATOR_STALE_DAYS && skill.lifecycle === "active") {
        this.store.saveSkill({ ...skill, lifecycle: "stale", updatedAt: now });
        this.store.insertSkillChangeLog({
          id: `scl_${randomUUID()}`,
          tenantId,
          skillId: skill.id,
          action: "lifecycle_changed",
          fromVersion: skill.version,
          toVersion: skill.version,
          actor: "curator",
          actorType: "curator",
          summary: `超过 ${CURATOR_STALE_DAYS} 天未使用，标记为过期技能 ${skill.name}`,
          createdAt: now,
        });
        markedStale.push(skill.id);
      }
    }

    const live = this.store
      .listSkills(tenantId, { lifecycles: ["active", "stale"] })
      .filter((s) => !s.isCore)
      .sort((a, b) => b.usageCount - a.usageCount || a.createdAt - b.createdAt);

    const absorbed = new Set<string>();
    for (let i = 0; i < live.length; i += 1) {
      const canonical = live[i]!;
      if (absorbed.has(canonical.id)) continue;
      for (let j = i + 1; j < live.length; j += 1) {
        const candidate = live[j]!;
        if (absorbed.has(candidate.id)) continue;
        if (areSkillsDuplicate(canonical, candidate)) {
          absorbed.add(candidate.id);
          const nextCanonical: ManagedSkill = {
            ...canonical,
            triggerPhrases: [...new Set([...canonical.triggerPhrases, ...candidate.triggerPhrases, candidate.name])],
            usageCount: canonical.usageCount + candidate.usageCount,
            lastUsedAt: Math.max(canonical.lastUsedAt, candidate.lastUsedAt),
            updatedAt: now,
          };
          this.store.saveSkill(nextCanonical);
          live[i] = nextCanonical;
          this.store.saveSkill({ ...candidate, lifecycle: "archived", mergedIntoSkillId: canonical.id, updatedAt: now });
          this.store.insertSkillChangeLog({
            id: `scl_${randomUUID()}`,
            tenantId,
            skillId: candidate.id,
            action: "merged",
            fromVersion: candidate.version,
            toVersion: candidate.version,
            actor: "curator",
            actorType: "curator",
            summary: `Curator 合并重复技能 ${candidate.name} → ${canonical.name}`,
            createdAt: now,
          });
          merged.push({ duplicateSkillId: candidate.id, canonicalSkillId: canonical.id });
        }
      }
    }

    return { tenantId, ranAt: now, markedStale, archived, merged, skippedCoreSkills };
  }
}
