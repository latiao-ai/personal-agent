import { z } from "zod";

import type { PatrolEngine } from "../patrol/engine.ts";
import { getPatrolFixtures } from "../patrol/fixtures.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const rawRecordSchema = z.record(z.string(), z.unknown());

const runPatrolSchema = z.object({
  tenantId: z.string().min(1).optional(),
  trigger: z.enum(["scheduled", "manual", "order_event"]).optional(),
  fixtureName: z.string().min(1).optional(),
  rawInventory: z.array(rawRecordSchema).optional(),
  rawOrders: z.array(rawRecordSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
  approver: z.string().min(1).optional(),
  incremental: z.boolean().optional(),
  simulatedModelToolCalls: z
    .array(
      z.object({
        toolName: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

const orderEventSchema = z.object({
  tenantId: z.string().min(1).optional(),
  approver: z.string().min(1).optional(),
  order: rawRecordSchema,
});

const dispatchDigestSchema = z.object({
  tenantId: z.string().min(1).optional(),
  dayKey: z.string().min(1).optional(),
});

export interface PatrolRouteDeps {
  patrol: PatrolEngine;
}

/** Control-plane HTTP routes for MVP4 read-only patrol runs, daily digests, spend ledger, and denial audits. */
export function createPatrolRoutes({ patrol }: PatrolRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (path === "/api/patrol/run" && method === "POST") {
      const parsed = runPatrolSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_patrol_request", issues: parsed.error.issues });
      }
      const record = await patrol.runPatrol(parsed.data);
      const status =
        record.status === "skipped_overlap"
          ? 409
          : record.status === "timed_out"
            ? 504
            : 200;
      return json(res, status, record);
    }

    if (path === "/api/patrol/order-event" && method === "POST") {
      const parsed = orderEventSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_order_event", issues: parsed.error.issues });
      }
      const record = await patrol.triggerOrderEvent(parsed.data.order, {
        tenantId: parsed.data.tenantId,
        approver: parsed.data.approver,
      });
      return json(res, 200, record);
    }

    if (path === "/api/patrol/runs" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const tenantId = url.searchParams.get("tenantId") || undefined;
      return json(res, 200, { runs: patrol.listRuns(Number.isFinite(limit) ? limit : 50, tenantId) });
    }

    if (path === "/api/patrol/digest" && method === "GET") {
      const dayKey = url.searchParams.get("dayKey") || undefined;
      const tenantId = url.searchParams.get("tenantId") || undefined;
      return json(res, 200, { digest: patrol.getDailyDigest(dayKey, tenantId) });
    }

    if (path === "/api/patrol/digest/dispatch" && method === "POST") {
      const parsed = dispatchDigestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_digest_dispatch", issues: parsed.error.issues });
      }
      const result = patrol.dispatchDailyDigest(parsed.data.dayKey, parsed.data.tenantId);
      return json(res, 200, result);
    }

    if (path === "/api/patrol/spend" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") || undefined;
      return json(res, 200, { spend: patrol.getSpendSummary(tenantId) });
    }

    if (path === "/api/patrol/denials" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { denials: patrol.listToolDenials(Number.isFinite(limit) ? limit : 100) });
    }

    if (path === "/api/patrol/fixtures" && method === "GET") {
      return json(res, 200, { fixtures: getPatrolFixtures() });
    }

    return PASS;
  };
}
