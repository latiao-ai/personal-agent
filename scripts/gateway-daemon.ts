/** Standalone resident gateway daemon supervised by launchd (macOS) or systemd (Linux). */

import { DATA_DIR } from "../server/config.ts";
import { createApprovalHost } from "../server/approvals/host.ts";
import { createGatewayHost } from "../server/gateway/host.ts";
import { createIsolationHost } from "../server/isolation/host.ts";
import { createMemorySkillHost } from "../server/memory-skill/host.ts";
import { createPatrolHost } from "../server/patrol/host.ts";
import { createPortalHost } from "../server/portal/host.ts";
import { createTicketHost } from "../server/tickets/host.ts";

const dataDir = process.env.OMB_DATA_DIR || DATA_DIR;
const tickets = createTicketHost(dataDir);
const approvals = createApprovalHost(dataDir);
const patrol = createPatrolHost(dataDir, { tickets: tickets.engine, approvals: approvals.engine });
const memorySkill = createMemorySkillHost(dataDir);
const isolation = createIsolationHost(dataDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
const portal = createPortalHost(dataDir, {
  tickets: tickets.engine,
  approvals: approvals.engine,
  patrol: patrol.engine,
  memorySkill: memorySkill.engine,
  isolation: isolation.engine,
});
const gateway = createGatewayHost(dataDir, { portal: portal.engine });

async function shutdown(signal: string): Promise<void> {
  console.log(`[gateway-daemon] received ${signal}, stopping...`);
  await gateway.stop();
  gateway.close();
  portal.close();
  isolation.close();
  memorySkill.close();
  patrol.close();
  approvals.close();
  tickets.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await gateway.start();
console.log(`[gateway-daemon] resident gateway online (PID=${process.pid}, dataDir=${dataDir})`);
