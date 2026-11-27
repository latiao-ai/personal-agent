import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import type { ApprovalEngine } from "../approvals/engine.ts";
import { createGatewayHost, type GatewayHost } from "../gateway/host.ts";
import type { IsolationEngine } from "../isolation/engine.ts";
import { createLlmProxyHost, type LlmProxyHost } from "../llm-proxy/host.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import type { PatrolEngine } from "../patrol/engine.ts";
import { createPortalRoutes, handlePortalPageGuard } from "../routes/portal.ts";
import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { PortalEngine } from "./engine.ts";

export interface PortalHost {
  engine: PortalEngine;
  gateway: GatewayHost;
  llmProxy: LlmProxyHost;
  routes: RouteHandler;
  /** Dispatches unified auth, portal, admin, and LLM proxy routes; returns true if handled. */
  dispatch(ctx: RouteContext): Promise<boolean>;
  /** Server-side HTML route guard for `/portal` and `/admin` before static SPA serving. */
  pageGuard(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  close(): void;
}

export interface PortalHostDeps {
  tickets: TicketEngine;
  approvals: ApprovalEngine;
  patrol: PatrolEngine;
  memorySkill: MemorySkillEngine;
  isolation: IsolationEngine;
  autoStartGateway?: boolean;
}

/** Composes PortalEngine, multi-platform resident GatewayHost, and ControlPlaneLlmProxy outside server/index.ts. */
export function createPortalHost(dataDir: string, deps: PortalHostDeps): PortalHost {
  const engine = new PortalEngine({
    dbPath: join(dataDir, "portal.sqlite"),
    tickets: deps.tickets,
    approvals: deps.approvals,
    patrol: deps.patrol,
    memorySkill: deps.memorySkill,
    isolation: deps.isolation,
  });
  const gateway = createGatewayHost(dataDir, { portal: engine });
  const llmProxy = createLlmProxyHost({ vault: deps.approvals.vault });
  const portalRoutes = createPortalRoutes({ portal: engine, gateway: gateway.engine });

  if (deps.autoStartGateway !== false) {
    void gateway.start().catch((err: unknown) => {
      console.warn("[gateway] resident gateway auto-start warning:", err instanceof Error ? err.message : String(err));
    });
  }

  const routes: RouteHandler = async (ctx) => {
    const p = await portalRoutes(ctx);
    if (p !== PASS) return p;
    return llmProxy.routes(ctx);
  };

  return {
    engine,
    gateway,
    llmProxy,
    routes,
    dispatch: async (ctx) => (await routes(ctx)) !== PASS,
    pageGuard: (req, res, path) => handlePortalPageGuard(req, res, path, engine),
    close: () => {
      void gateway.stop();
      gateway.close();
      engine.close();
    },
  };
}
