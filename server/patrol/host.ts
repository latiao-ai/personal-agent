import { join } from "node:path";

import type { ApprovalEngine } from "../approvals/engine.ts";
import { createPatrolRoutes } from "../routes/patrol.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { PatrolEngine } from "./engine.ts";

export interface PatrolHost {
  engine: PatrolEngine;
  routes: RouteHandler;
  close: () => void;
}

export function createPatrolHost(
  dataDir: string,
  deps: { tickets: TicketEngine; approvals: ApprovalEngine },
): PatrolHost {
  const engine = new PatrolEngine({
    dbPath: join(dataDir, "patrol.sqlite"),
    tickets: deps.tickets,
    approvals: deps.approvals,
  });
  return {
    engine,
    routes: createPatrolRoutes({ patrol: engine }),
    close: () => engine.close(),
  };
}
