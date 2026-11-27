/**
 * Isolated live relay verification script for add-relay-bot-driver Step 7.
 * Never touches real user data: runs entirely in a temporary directory.
 *
 * Usage:
 *   OMB_LLM_RELAY_API_KEY="sk-..." \
 *   OMB_LLM_RELAY_BASE_URL="https://www.hi-x.cn/v1" \
 *   OMB_LLM_RELAY_MODEL="deepseek-v4-1-flash" \
 *   node --experimental-strip-types scripts/verify-relay-live.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApprovalHost } from "../server/approvals/host.ts";
import { RelayDriver } from "../server/drivers/relay.ts";
import { FeishuAdapter } from "../server/gateway/adapters.ts";
import { ChannelGatewayEngine } from "../server/gateway/engine.ts";
import { createIsolationHost } from "../server/isolation/host.ts";
import { ControlPlaneLlmProxy } from "../server/llm-proxy/engine.ts";
import { createMemorySkillHost } from "../server/memory-skill/host.ts";
import { createPatrolHost } from "../server/patrol/host.ts";
import { PortalEngine } from "../server/portal/engine.ts";
import { createRoutingHost } from "../server/routing/host.ts";
import { createTicketHost } from "../server/tickets/host.ts";

const apiKey = process.env.OMB_LLM_RELAY_API_KEY?.trim();
const baseUrl = (process.env.OMB_LLM_RELAY_BASE_URL?.trim() || "https://www.hi-x.cn/v1").replace(/\/+$/, "");
const model = process.env.OMB_LLM_RELAY_MODEL?.trim() || "deepseek-v4-1-flash";

if (!apiKey) {
  console.error("Missing OMB_LLM_RELAY_API_KEY environment variable.");
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), "omb-relay-live-"));
const tickets = createTicketHost(tmpDir);
const approvals = createApprovalHost(tmpDir);
const patrol = createPatrolHost(tmpDir, { tickets: tickets.engine, approvals: approvals.engine });
const memorySkill = createMemorySkillHost(tmpDir);
const isolation = createIsolationHost(tmpDir, { memorySkill: memorySkill.engine, vault: approvals.engine.vault });
const llmProxy = new ControlPlaneLlmProxy({ vault: approvals.engine.vault });
const portal = new PortalEngine({
  dbPath: join(tmpDir, "portal.sqlite"),
  tickets: tickets.engine,
  approvals: approvals.engine,
  patrol: patrol.engine,
  memorySkill: memorySkill.engine,
  isolation: isolation.engine,
  llmProxy,
  autoBootstrapLlmEnv: false,
  bootstrapAdmin: { username: "admin", password: "AdminPassword#1" },
});

llmProxy.registerProvider({
  id: "deepseek-live",
  name: "DeepSeek Live Relay",
  baseUrl,
  apiKey,
  defaultModel: model,
  fastModel: model,
  priority: 1,
  enabled: true,
});

try {
  console.log(`Live relay verification: baseUrl=${baseUrl}, model=${model}`);

  // 1. Main UI Bot Q&A
  const t1 = Date.now();
  const driver = new RelayDriver({ proxy: llmProxy, tenantId: "tenant_live", botId: "bot_live" });
  const qa = await driver.runTurn({ text: "你好，请用一句话回答你现在是什么模型回复的。" });
  const qaMs = Date.now() - t1;
  console.log(`[1/4 Main UI Bot] ${qaMs} ms | model=${qa.model} | reply=${qa.text.slice(0, 120)}`);

  // 2. Feishu DM via ChannelGatewayEngine (default RelayDriver path)
  const admin = portal.loginAdmin("admin", "AdminPassword#1").session;
  const customer = portal.createPortalUserAsAdmin(admin, {
    username: "live_user",
    password: "UserPass#123",
    role: "customer",
    tenantId: "tenant_live",
    autoSwitchSession: true,
  }).customerSession!.session;
  portal.bindFeishuIdentity(customer, "ou_live_tester");
  portal.createChannelBinding(customer, {
    botId: "bot_live",
    platform: "feishu",
    platformAppId: "cli_live_app",
    platformSecret: "secret_live",
    chatId: "oc_live_dm",
    chatType: "p2p",
  });
  const feishuReplies: string[] = [];
  const gateway = new ChannelGatewayEngine({
    dataDir: tmpDir,
    portal,
    feishuAdapter: new FeishuAdapter({
      replySender: async (rec) => {
        feishuReplies.push(rec.text);
      },
    }),
  });
  await gateway.start();
  const t2 = Date.now();
  const dmOut = await gateway.handleInbound({
    platform: "feishu",
    eventId: "evt_live_dm_1",
    messageId: "om_live_1",
    appId: "cli_live_app",
    chatId: "oc_live_dm",
    chatType: "p2p",
    senderId: "ou_live_tester",
    text: "回复我四个字：联调成功",
    mentionedBot: false,
    rawTimestampMs: Date.now(),
  });
  const dmMs = Date.now() - t2;
  console.log(`[2/4 Feishu DM] ${dmMs} ms | status=${dmOut.status} | reply=${(feishuReplies[0] ?? "").slice(0, 120)}`);
  await gateway.stop();
  gateway.close();

  // 3. Jev small model routing
  const routing = createRoutingHost(tickets.engine, {
    smallModel: llmProxy.createJevSmallModel("tenant_live"),
    jevTimeoutMs: 3_000,
  });
  const t3 = Date.now();
  const jevOut = await routing.engine.routeGroupMessage({
    eventId: "evt_live_jev_1",
    chatId: "oc_live_group",
    senderId: "ou_live_tester",
    mentionedBot: true,
    text: "@助理 之前说的那个事情帮我推进一下",
  });
  const jevMs = Date.now() - t3;
  console.log(`[3/4 Jev Routing] ${jevMs} ms | outcome=${jevOut.outcome} | jev=${JSON.stringify(jevOut.jev)}`);

  // 4. tool_calls passthrough probe
  const t4 = Date.now();
  let toolInvoked = false;
  const toolDriver = new RelayDriver({
    proxy: llmProxy,
    tenantId: "tenant_live",
    botId: "bot_live",
    executeTool: async (call) => {
      toolInvoked = true;
      return { ok: true, text: JSON.stringify({ sku: call.arguments.sku ?? "SKU-102", qty: 42 }) };
    },
  });
  const toolRes = await toolDriver.runTurn({
    text: "请务必调用 check_inventory 工具查询 SKU-102 的库存数量，然后告诉我结果。",
    tools: [
      {
        type: "function",
        function: {
          name: "check_inventory",
          description: "Query current inventory quantity for a SKU",
          parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
        },
      },
    ],
  });
  const toolMs = Date.now() - t4;
  console.log(
    `[4/4 tool_calls probe] ${toolMs} ms | passthrough=${toolInvoked} | rounds=${toolRes.rounds} | toolCallsExecuted=${toolRes.toolCallsExecuted} | reply=${toolRes.text.slice(0, 120)}`,
  );
} finally {
  portal.close();
  isolation.close();
  memorySkill.close();
  patrol.close();
  approvals.close();
  tickets.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
