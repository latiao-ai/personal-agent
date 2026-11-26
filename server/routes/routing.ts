import { z } from "zod";

import type { RoutingEngine } from "../routing/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const groupMessageSchema = z.object({
  eventId: z.string().min(1).optional(),
  chatId: z.string().min(1),
  senderId: z.string().min(1),
  senderIsBot: z.boolean().optional(),
  mentions: z.array(z.string()).optional(),
  mentionedBot: z.boolean().optional(),
  text: z.string(),
  hops: z.number().int().nonnegative().optional(),
  threadId: z.string().min(1).optional(),
});

const specialistReplySchema = z.object({
  chatId: z.string().min(1),
  ticketId: z.string().min(1).nullable().optional(),
  specialistBotId: z.string().min(1),
  managerBotId: z.string().min(1),
  text: z.string(),
  deliveryMode: z.enum(["direct_group", "via_manager"]).optional(),
  handoffToRole: z.enum(["procurement", "order", "followup"]).optional(),
  hops: z.number().int().nonnegative().default(1),
});

export interface RoutingRouteDeps {
  routing: RoutingEngine;
}

/** Control-plane HTTP routes for Gate Jev + Inner Router group message dispatch and specialist reply guards. */
export function createRoutingRoutes({ routing }: RoutingRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (path === "/api/routing/group-message" && method === "POST") {
      const parsed = groupMessageSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_group_message", issues: parsed.error.issues });
      }
      const result = await routing.routeGroupMessage(parsed.data);
      const status = result.outcome === "escalated_to_human" ? 409 : 200;
      return json(res, status, result);
    }

    if (path === "/api/routing/specialist-reply" && method === "POST") {
      const parsed = specialistReplySchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "invalid_specialist_reply", issues: parsed.error.issues });
      }
      const result = routing.handleSpecialistReply(parsed.data);
      const status = result.ok
        ? 200
        : result.outcome === "direct_group_forbidden"
          ? 403
          : 409;
      return json(res, status, result);
    }

    if (path === "/api/routing/audit" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { audit: routing.listAudit(Number.isFinite(limit) ? limit : 100) });
    }

    return PASS;
  };
}
