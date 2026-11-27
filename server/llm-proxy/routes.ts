import { z } from "zod";

import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";
import { LlmProxyError, type ControlPlaneLlmProxy } from "./engine.ts";

const chatSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
});

function extractBearer(authHeader: string | undefined): string | null {
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim() || null;
  }
  return null;
}

/** HTTP OpenAI-compatible proxy routes under `/api/llm/*` for VMs and bots. */
export function createLlmProxyRoutes(proxy: ControlPlaneLlmProxy): RouteHandler {
  return async ({ req, res, path, method, json, readBody }: RouteContext) => {
    if (!path.startsWith("/api/llm/")) return PASS;

    try {
      if (path === "/api/llm/health" && method === "GET") {
        const readiness = proxy.checkReadiness();
        return json(res, readiness.reachable ? 200 : 503, readiness);
      }

      if (path === "/api/llm/v1/models" && method === "GET") {
        const providers = proxy.listProviders().filter((p) => p.enabled);
        const models = [...new Set(providers.flatMap((p) => [p.defaultModel, p.fastModel]))].map((id) => ({
          id,
          object: "model",
          owned_by: "openmausbot-relay",
        }));
        return json(res, 200, { object: "list", data: models });
      }

      if (path === "/api/llm/v1/chat/completions" && method === "POST") {
        const parsed = chatSchema.safeParse(await readBody(req));
        if (!parsed.success) {
          return json(res, 400, { error: "invalid_chat_request", issues: parsed.error.issues });
        }
        const token = extractBearer(req.headers.authorization);
        const completion = await proxy.chatCompletions(token, parsed.data);
        return json(res, 200, completion);
      }

      return json(res, 404, { error: "llm_proxy_route_not_found" });
    } catch (error) {
      if (error instanceof LlmProxyError) {
        return json(res, error.status, { error: error.code, message: error.message });
      }
      throw error;
    }
  };
}
