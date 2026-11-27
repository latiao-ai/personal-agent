import { createRoutingRoutes } from "../routes/routing.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { RoutingEngine } from "./engine.ts";
import type { JevSmallModel } from "./jev.ts";

export interface RoutingHost {
  engine: RoutingEngine;
  routes: RouteHandler;
}

export interface RoutingHostOptions {
  smallModel?: JevSmallModel;
  jevTimeoutMs?: number;
}

export function createRoutingHost(tickets: TicketEngine, options?: RoutingHostOptions): RoutingHost {
  const engine = new RoutingEngine({
    tickets,
    smallModel: options?.smallModel,
    jevTimeoutMs: options?.jevTimeoutMs,
  });
  return {
    engine,
    routes: createRoutingRoutes({ routing: engine }),
  };
}
