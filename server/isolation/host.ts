import { join } from "node:path";

import type { ControlPlaneVault } from "../approvals/vault.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import { createIsolationRoutes } from "../routes/isolation.ts";
import type { RouteHandler } from "../routes/table.ts";
import { IsolationEngine } from "./engine.ts";

export interface IsolationHost {
  engine: IsolationEngine;
  routes: RouteHandler;
  close: () => void;
}

export function createIsolationHost(
  dataDir: string,
  deps?: { memorySkill?: MemorySkillEngine; vault?: ControlPlaneVault },
): IsolationHost {
  const engine = new IsolationEngine({
    dbPath: join(dataDir, "isolation.sqlite"),
    dataDir,
    memorySkill: deps?.memorySkill,
    vault: deps?.vault,
  });
  return {
    engine,
    routes: createIsolationRoutes({ isolation: engine }),
    close: () => engine.close(),
  };
}
