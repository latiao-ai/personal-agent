import { join } from "node:path";

import type { ApprovalEngine } from "../approvals/engine.ts";
import type { IsolationEngine } from "../isolation/engine.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import type { PatrolEngine } from "../patrol/engine.ts";
import type { RouteHandler } from "../routes/table.ts";
import { createPortalRoutes } from "../routes/portal.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import { PortalEngine } from "./engine.ts";

export interface PortalHost {
  engine: PortalEngine;
  routes: RouteHandler;
  close(): void;
}

export interface PortalHostDeps {
  tickets: TicketEngine;
  approvals: ApprovalEngine;
  patrol: PatrolEngine;
  memorySkill: MemorySkillEngine;
  isolation: IsolationEngine;
}

/** Composes the Customer Web Portal & Admin Console engine and its HTTP route table outside server/index.ts. */
export function createPortalHost(dataDir: string, deps: PortalHostDeps): PortalHost {
  const engine = new PortalEngine({
    dbPath: join(dataDir, "portal.sqlite"),
    ...deps,
  });
  return {
    engine,
    routes: createPortalRoutes({ portal: engine }),
    close: () => engine.close(),
  };
}
