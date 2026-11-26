import { join } from "node:path";

import { createApprovalRoutes } from "../routes/approvals.ts";
import type { RouteHandler } from "../routes/table.ts";
import { ApprovalEngine } from "./engine.ts";

export interface ApprovalHost {
  engine: ApprovalEngine;
  routes: RouteHandler;
  close: () => void;
}

export function createApprovalHost(dataDir: string): ApprovalHost {
  const engine = new ApprovalEngine({ dbPath: join(dataDir, "approvals.sqlite") });
  return {
    engine,
    routes: createApprovalRoutes({ approvals: engine }),
    close: () => engine.close(),
  };
}
