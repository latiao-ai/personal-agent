import { z } from "zod";

import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const shortWriteSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  category: z.enum(["session_context", "active_ticket", "working_note"]).optional(),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const mediumWriteSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  scope: z.enum(["user_shared", "bot_private"]).optional(),
  category: z.enum(["daily_summary", "weekly_summary"]),
  periodKey: z.string().min(1).optional(),
  summary: z.string().min(1),
  highlights: z.array(z.string()).optional(),
});

const longWriteSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1).nullable().optional(),
  scope: z.enum(["user_shared", "bot_private"]).optional(),
  category: z.enum(["preference", "rule", "whitelist", "payment_rule", "supplier_policy", "price_floor"]),
  key: z.string().min(1).optional(),
  content: z.string().min(1),
  structured: z.record(z.string(), z.unknown()).optional(),
  sourceTrust: z.enum(["owner_chat", "external_content", "bot_inference"]).optional(),
  confirmedBy: z.string().min(1).nullable().optional(),
  sourceExcerpt: z.string().optional(),
});

const checkActionSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  actionText: z.string().min(1),
  timestamp: z.union([z.string().min(1), z.number()]).optional(),
});

const skillSpecPartialSchema = z.object({
  inputs: z.string().optional(),
  outputs: z.string().optional(),
  tools: z.array(z.string()).optional(),
  boundaries: z.string().optional(),
  failureHandling: z.string().optional(),
});

const dreamRunSchema = z.object({
  tenantId: z.string().min(1),
  dayKey: z.string().min(1).optional(),
  messages: z.array(
    z.object({
      sessionId: z.string().min(1),
      botId: z.string().min(1),
      role: z.enum(["owner", "bot", "external"]),
      sourceKind: z.enum(["chat", "supplier_email", "webhook", "web_page"]).optional(),
      text: z.string(),
      timestamp: z.string().optional(),
      workflowKey: z.string().optional(),
      workflowName: z.string().optional(),
      workflowSpec: skillSpecPartialSchema.optional(),
      triggerPhrases: z.array(z.string()).optional(),
    }),
  ),
});

const confirmDecisionSchema = z.object({
  tenantId: z.string().min(1),
  actor: z.string().min(1),
});

const workflowObserveSchema = z.object({
  tenantId: z.string().min(1),
  workflowKey: z.string().min(1),
  workflowName: z.string().min(1),
  description: z.string().optional(),
  triggerPhrases: z.array(z.string()).optional(),
  spec: skillSpecPartialSchema.optional(),
  actor: z.string().optional(),
});

const createSkillSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  triggerPhrases: z.array(z.string()).default([]),
  spec: skillSpecPartialSchema,
  coreCategory: z.enum(["procurement", "payment", "data_deletion"]).nullable().optional(),
  actor: z.string().min(1),
  actorType: z.enum(["agent", "human"]),
});

const updateSkillSchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  triggerPhrases: z.array(z.string()).optional(),
  spec: skillSpecPartialSchema.optional(),
  actor: z.string().min(1),
  actorType: z.enum(["agent", "human"]),
  reason: z.string().optional(),
});

const rollbackSkillSchema = z.object({
  tenantId: z.string().min(1),
  targetVersion: z.number().int().positive().optional(),
  actor: z.string().min(1),
  actorType: z.enum(["agent", "human"]),
});

const loadSkillSchema = z.object({
  tenantId: z.string().min(1),
  actor: z.string().optional(),
  runtimePayload: z
    .object({
      name: z.string(),
      description: z.string(),
      triggerPhrases: z.array(z.string()),
      spec: z.object({
        inputs: z.string(),
        outputs: z.string(),
        tools: z.array(z.string()),
        boundaries: z.string(),
        failureHandling: z.string(),
      }),
    })
    .optional(),
});

export interface MemorySkillRouteDeps {
  memorySkill: MemorySkillEngine;
}

/** Control-plane HTTP routes for MVP5 three-tier memory, nightly dream, skill crystallization, Curator, and core locks. */
export function createMemorySkillRoutes({ memorySkill }: MemorySkillRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    // --- Three-tier Memory ---
    if (path === "/api/memory-skill/memory/short" && method === "POST") {
      const parsed = shortWriteSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_short_memory", issues: parsed.error.issues });
      return json(res, 200, { memory: memorySkill.writeShortTerm(parsed.data) });
    }

    if (path === "/api/memory-skill/memory/short" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const botId = url.searchParams.get("botId") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!tenantId || !botId || !sessionId) return json(res, 400, { error: "missing_query_params" });
      return json(res, 200, { memories: memorySkill.readShortTerm(tenantId, botId, sessionId) });
    }

    if (path === "/api/memory-skill/memory/short" && method === "DELETE") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const botId = url.searchParams.get("botId") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!tenantId || !botId || !sessionId) return json(res, 400, { error: "missing_query_params" });
      return json(res, 200, { cleared: memorySkill.clearShortTermSession(tenantId, botId, sessionId) });
    }

    if (path === "/api/memory-skill/memory/medium" && method === "POST") {
      const parsed = mediumWriteSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_medium_memory", issues: parsed.error.issues });
      return json(res, 200, { memory: memorySkill.writeMediumTerm(parsed.data) });
    }

    if (path === "/api/memory-skill/memory/medium" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const botId = url.searchParams.get("botId") ?? "";
      if (!tenantId || !botId) return json(res, 400, { error: "missing_query_params" });
      const category = url.searchParams.get("category") as "daily_summary" | "weekly_summary" | null;
      const periodKey = url.searchParams.get("periodKey") ?? undefined;
      const query = url.searchParams.get("query") ?? undefined;
      return json(res, 200, {
        memories: memorySkill.readMediumTerm(tenantId, botId, {
          ...(category ? { category } : {}),
          ...(periodKey ? { periodKey } : {}),
          ...(query ? { query } : {}),
        }),
      });
    }

    if (path === "/api/memory-skill/memory/long" && method === "POST") {
      const parsed = longWriteSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_long_memory", issues: parsed.error.issues });
      const result = memorySkill.writeLongTerm(parsed.data);
      return json(res, result.status === "written" ? 200 : 202, result);
    }

    if (path === "/api/memory-skill/memory/long" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const botId = url.searchParams.get("botId") ?? "";
      if (!tenantId || !botId) return json(res, 400, { error: "missing_query_params" });
      return json(res, 200, { memories: memorySkill.readLongTerm(tenantId, botId) });
    }

    if (path === "/api/memory-skill/memory/check-action" && method === "POST") {
      const parsed = checkActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_action_check", issues: parsed.error.issues });
      return json(res, 200, memorySkill.checkActionAgainstMemory(parsed.data));
    }

    // --- Nightly Dream & Pending Confirmations ---
    if (path === "/api/memory-skill/dream/run" && method === "POST") {
      const parsed = dreamRunSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_dream_request", issues: parsed.error.issues });
      return json(res, 200, memorySkill.runNightlyDream(parsed.data));
    }

    if (path === "/api/memory-skill/dream/spend" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      return json(res, 200, { spend: memorySkill.getDreamSpendSummary(tenantId) });
    }

    if (path === "/api/memory-skill/pending" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const status = url.searchParams.get("status") as "pending" | "confirmed" | "rejected" | null;
      return json(res, 200, { pending: memorySkill.listPendingConfirmations(tenantId, status ?? undefined) });
    }

    const confirmMatch = /^\/api\/memory-skill\/pending\/([^/]+)\/(confirm|reject)$/.exec(path);
    if (confirmMatch && method === "POST") {
      const pendingId = decodeURIComponent(confirmMatch[1]!);
      const decision = confirmMatch[2]!;
      const parsed = confirmDecisionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_confirmation", issues: parsed.error.issues });
      const result =
        decision === "confirm"
          ? memorySkill.confirmPendingMemory(parsed.data.tenantId, pendingId, parsed.data.actor)
          : memorySkill.rejectPendingMemory(parsed.data.tenantId, pendingId, parsed.data.actor);
      return json(res, result.ok ? 200 : 404, result);
    }

    // --- Skills, Workflow Crystallization, Curator & Core Skill Locks ---
    if (path === "/api/memory-skill/workflows/observe" && method === "POST") {
      const parsed = workflowObserveSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_workflow_observe", issues: parsed.error.issues });
      return json(res, 200, memorySkill.recordWorkflowOccurrence(parsed.data));
    }

    if (path === "/api/memory-skill/skills" && method === "POST") {
      const parsed = createSkillSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_skill", issues: parsed.error.issues });
      const result = memorySkill.createSkill(parsed.data);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (path === "/api/memory-skill/skills" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      return json(res, 200, { skills: memorySkill.listSkills(tenantId) });
    }

    if (path === "/api/memory-skill/skills/match" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const phrase = url.searchParams.get("phrase") ?? "";
      if (!tenantId || !phrase) return json(res, 400, { error: "missing_query_params" });
      const skill = memorySkill.matchSkillByPhrase(tenantId, phrase);
      return json(res, 200, { matched: Boolean(skill), skill });
    }

    if (path === "/api/memory-skill/curator/run" && method === "POST") {
      const body = (await readBody(req)) as { tenantId?: string };
      if (!body?.tenantId) return json(res, 400, { error: "missing_tenant_id" });
      return json(res, 200, memorySkill.runCurator(body.tenantId));
    }

    const skillPatchMatch = /^\/api\/memory-skill\/skills\/([^/]+)$/.exec(path);
    if (skillPatchMatch && method === "PATCH") {
      const skillId = decodeURIComponent(skillPatchMatch[1]!);
      const parsed = updateSkillSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_skill_update", issues: parsed.error.issues });
      const result = memorySkill.updateSkill({ ...parsed.data, skillId });
      const status = result.ok ? 200 : result.error === "core_skill_locked" ? 403 : 400;
      return json(res, status, result);
    }

    const skillRollbackMatch = /^\/api\/memory-skill\/skills\/([^/]+)\/rollback$/.exec(path);
    if (skillRollbackMatch && method === "POST") {
      const skillId = decodeURIComponent(skillRollbackMatch[1]!);
      const parsed = rollbackSkillSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_rollback", issues: parsed.error.issues });
      const result = memorySkill.rollbackSkill({ ...parsed.data, skillId });
      const status = result.ok ? 200 : result.error === "core_skill_locked" ? 403 : 400;
      return json(res, status, result);
    }

    const skillLoadMatch = /^\/api\/memory-skill\/skills\/([^/]+)\/load$/.exec(path);
    if (skillLoadMatch && method === "POST") {
      const skillId = decodeURIComponent(skillLoadMatch[1]!);
      const parsed = loadSkillSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_load_request", issues: parsed.error.issues });
      const result = memorySkill.loadSkillForRuntime({ ...parsed.data, skillId });
      const status = result.ok ? 200 : result.error === "core_skill_hash_mismatch" ? 403 : 404;
      return json(res, status, result);
    }

    if (path === "/api/memory-skill/denials" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      return json(res, 200, { denials: memorySkill.listSkillLockDenials(tenantId) });
    }

    return PASS;
  };
}
