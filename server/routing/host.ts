import { createRoutingRoutes } from "../routes/routing.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { RoutingEngine } from "./engine.ts";

export interface RoutingHost {
  engine: RoutingEngine;
  routes: RouteHandler;
}

export function createRoutingHost(tickets: TicketEngine): RoutingHost {
  const engine = new RoutingEngine({ tickets });
  return {
    engine,
    routes: createRoutingRoutes({ routing: engine }),
  };
}
