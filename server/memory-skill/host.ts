import { join } from "node:path";

import { createMemorySkillRoutes } from "../routes/memory-skill.ts";
import type { RouteHandler } from "../routes/table.ts";
import { MemorySkillEngine } from "./engine.ts";

export interface MemorySkillHost {
  engine: MemorySkillEngine;
  routes: RouteHandler;
  close: () => void;
}

export function createMemorySkillHost(dataDir: string): MemorySkillHost {
  const engine = new MemorySkillEngine({
    dbPath: join(dataDir, "memory-skill.sqlite"),
  });
  return {
    engine,
    routes: createMemorySkillRoutes({ memorySkill: engine }),
    close: () => engine.close(),
  };
}
