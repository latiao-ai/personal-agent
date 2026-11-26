import { z } from "zod";

import { TicketEngineError, type TicketEngine } from "../tickets/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const ticketSourceSchema = z.enum([
  "feishu_dm",
  "feishu_group",
  "new_order",
  "inventory_change",
  "webhook",
  "patrol",
]);

const budgetPatchSchema = z
  .object({
    tokenLimit: z.number().nonnegative().optional(),
    businessLimit: z.number().nonnegative().optional(),
    currency: z.string().min(1).max(16).optional(),
  })
  .strict();

const intakeSchema = z.object({
  source: ticketSourceSchema,
  initiator: z.string().min(1),
  text: z.string(),
  eventId: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  budget: budgetPatchSchema.optional(),
  validForMs: z.number().positive().optional(),
  midConversationSideEffect: z.boolean().optional(),
  threadId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const reviseSchema = z.object({
  actor: z.string().min(1).default("control_plane"),
  goal: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  budgetLimit: budgetPatchSchema.optional(),
  validUntil: z.number().positive().optional(),
});

export interface TicketRouteDeps {
  tickets: TicketEngine;
}

/** Control-plane HTTP interface for ticket intake, inspection, signed mandate reads, and mutation refusal. */
export function createTicketRoutes({ tickets }: TicketRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (path === "/api/tickets/intake" && method === "POST") {
      const parsed = intakeSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_ticket_intake", issues: parsed.error.issues });
      }
      const decision = tickets.intake(parsed.data);
      const status =
        decision.outcome === "denied"
          ? 403
          : decision.outcome === "created"
            ? 201
            : 200;
      return json(res, status, decision);
    }

    if (path === "/api/tickets/audit" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { audit: tickets.listAudit(undefined, Number.isFinite(limit) ? limit : 100) });
    }

    if (path === "/api/tickets" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { tickets: tickets.listTickets(Number.isFinite(limit) ? limit : 100) });
    }

    const match = path.match(/^\/api\/tickets\/([\w-]+)(?:\/(mandate|revise|audit)(?:\/(mutate))?)?$/);
    if (!match) return PASS;
    const ticketId = match[1]!;
    const sub = match[2];
    const action = match[3];

    if (!sub && method === "GET") {
      const ticket = tickets.getTicket(ticketId);
      return ticket ? json(res, 200, { ticket }) : json(res, 404, { error: "ticket_not_found" });
    }

    if (sub === "audit" && !action && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { audit: tickets.listAudit(ticketId, Number.isFinite(limit) ? limit : 100) });
    }

    if (sub === "mandate" && !action && method === "GET") {
      try {
        const copy = tickets.readMandateForAgent(ticketId);
        return json(res, 200, { mandateCopy: copy });
      } catch (error) {
        if (error instanceof TicketEngineError) {
          return json(res, error.status, { error: error.code, message: error.message });
        }
        throw error;
      }
    }

    if (
      sub === "mandate" &&
      (method === "PATCH" || method === "PUT" || (method === "POST" && action === "mutate"))
    ) {
      const raw = (await readBody(req).catch(() => ({}))) as Record<string, unknown> | null;
      const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const actor = typeof body.actor === "string" && body.actor ? body.actor : "vm_agent";
      const toolName = typeof body.toolName === "string" && body.toolName ? body.toolName : "mandate_write";
      const patch =
        body.patch && typeof body.patch === "object" && !Array.isArray(body.patch)
          ? (body.patch as Record<string, unknown>)
          : body;
      const refusal = tickets.rejectAgentMandateMutation(ticketId, actor, toolName, patch);
      return json(res, 403, refusal);
    }

    if (sub === "revise" && !action && method === "POST") {
      const parsed = reviseSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_mandate_revision", issues: parsed.error.issues });
      }
      try {
        const { actor, ...patch } = parsed.data;
        const result = tickets.reviseMandate(ticketId, patch, actor);
        return json(res, 201, result);
      } catch (error) {
        if (error instanceof TicketEngineError) {
          return json(res, error.status, { error: error.code, message: error.message });
        }
        throw error;
      }
    }

    return PASS;
  };
}
