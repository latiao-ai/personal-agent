import type { ControlPlaneVault } from "../approvals/vault.ts";
import type { RouteHandler } from "../routes/table.ts";
import { ControlPlaneLlmProxy } from "./engine.ts";
import { createLlmProxyRoutes } from "./routes.ts";

export interface LlmProxyHost {
  engine: ControlPlaneLlmProxy;
  routes: RouteHandler;
}

/** Composes the control-plane OpenAI-compatible DeepSeek relay proxy outside server/index.ts. */
export function createLlmProxyHost(deps: { vault: ControlPlaneVault; engine?: ControlPlaneLlmProxy }): LlmProxyHost {
  const engine = deps.engine ?? new ControlPlaneLlmProxy({ vault: deps.vault });
  return {
    engine,
    routes: createLlmProxyRoutes(engine),
  };
}
