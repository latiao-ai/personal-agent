import { z } from "zod";

import type { IsolationEngine } from "../isolation/engine.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const prewarmSchema = z.object({
  count: z.number().int().min(1).max(32),
  hostNodeId: z.string().min(1).optional(),
});

const provisionSchema = z.object({
  tenantId: z.string().min(1),
  openIds: z.array(z.string().min(1)).min(1),
  hostNodeId: z.string().min(1).optional(),
  quota: z
    .object({
      vcpu: z.number().int().min(1).max(64).optional(),
      memoryGb: z.number().int().min(2).max(128).optional(),
      diskGb: z.number().int().min(10).max(1000).optional(),
    })
    .optional(),
});

const fileWriteSchema = z.object({
  tenantId: z.string().min(1),
  relPath: z.string().min(1),
  content: z.string(),
});

const fileReadSchema = z.object({
  actorTenantId: z.string().min(1),
  actorBotId: z.string().min(1),
  targetTenantId: z.string().min(1),
  relPath: z.string().min(1),
});

const ordersReadSchema = z.object({
  actorTenantId: z.string().min(1),
  actorBotId: z.string().min(1),
  targetTenantId: z.string().min(1),
});

const networkProbeSchema = z.object({
  sourceTenantId: z.string().min(1),
  targetAddress: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535),
  targetPath: z.string().optional(),
});

const registerBotSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  role: z.enum(["purchasing", "patrol", "followup", "custom"]),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  allowedConnectors: z.array(z.string().min(1)).optional(),
});

const botActionSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  toolName: z.string().min(1),
  connector: z.string().min(1).optional(),
  tokenCost: z.number().min(0).optional(),
  businessCost: z.number().min(0).optional(),
  orderPayload: z
    .object({
      sku: z.string().min(1),
      quantity: z.number().int().min(1),
      amount: z.number().min(0),
    })
    .optional(),
});

const tenantActionSchema = z.object({
  tenantId: z.string().min(1),
});

const migrateSchema = z.object({
  tenantId: z.string().min(1),
  targetHostNodeId: z.string().min(1),
});

const feishuRouteSchema = z.object({
  openId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
  botId: z.string().min(1).optional(),
  autoWake: z.boolean().optional(),
});

const accountSchema = z.object({
  tenantId: z.string().min(1),
  kind: z.enum(["preinstalled_app", "user_email"]),
  provider: z.string().min(1),
  accountLabel: z.string().min(1),
  email: z.string().email().optional(),
  rawSecret: z.string().min(1),
});

const knowledgeAddSchema = z.object({
  tenantId: z.string().min(1),
  category: z.enum(["product_knowledge", "sop", "platform_rule", "historical_case", "agent_note"]),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  dataKind: z.string().optional(),
});

const retrieveSchema = z.object({
  tenantId: z.string().min(1),
  botId: z.string().min(1),
  ticketId: z.string().min(1),
  query: z.string(),
  topK: z.number().int().min(1).max(20).optional(),
  domain: z.string().min(1).optional(),
  neededEntities: z.array(z.string()).optional(),
});

const realtimeQuerySchema = z.object({
  tenantId: z.string().min(1),
  kind: z.enum(["inventory", "order_status", "realtime_price"]),
  key: z.string().min(1),
});

const healthMetricSchema = z.object({
  tenantId: z.string().min(1),
  alive: z.boolean(),
  diskUsagePercent: z.number().min(0).max(100),
  cpuUsagePercent: z.number().min(0).max(100),
});

const privateDeployValidateSchema = z.object({
  mode: z.enum(["cloud_control_plane_worker", "compiled_image"]),
  controlPlaneCallbackUrl: z.string(),
  workerImageRef: z.string().optional(),
  includesSourceCode: z.boolean(),
  includesEnterpriseDir: z.boolean(),
  enterpriseCommercialLicenseVerified: z.boolean(),
  preservedNotices: z.array(z.string()),
});

export interface IsolationRouteDeps {
  isolation: IsolationEngine;
}

/** Control-plane HTTP routes for MVP6 microVM isolation, scheduling, Feishu wake queue, Top-K loading, and offboarding. */
export function createIsolationRoutes({ isolation }: IsolationRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, json, readBody }: RouteContext) => {
    if (path === "/api/isolation/warm-pool/prewarm" && method === "POST") {
      const parsed = prewarmSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_prewarm", issues: parsed.error.issues });
      return json(res, 200, { vms: isolation.prewarmPool(parsed.data.count, parsed.data.hostNodeId) });
    }

    if (path === "/api/isolation/tenants/provision" && method === "POST") {
      const parsed = provisionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_provision", issues: parsed.error.issues });
      return json(res, 200, isolation.provisionTenant(parsed.data));
    }

    if (path === "/api/isolation/tenants/offboard" && method === "POST") {
      const parsed = tenantActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_offboard", issues: parsed.error.issues });
      try {
        return json(res, 200, isolation.offboardTenant(parsed.data.tenantId));
      } catch (err) {
        return json(res, 404, { error: err instanceof Error ? err.message : "tenant_not_found" });
      }
    }

    if (path === "/api/isolation/tenants/vm" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      const vm = isolation.getTenantVm(tenantId);
      if (!vm) return json(res, 404, { error: "tenant_vm_not_found" });
      return json(res, 200, { vm });
    }

    if (path === "/api/isolation/files/write" && method === "POST") {
      const parsed = fileWriteSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_file_write", issues: parsed.error.issues });
      return json(res, 200, isolation.writeTenantFile(parsed.data.tenantId, parsed.data.relPath, parsed.data.content));
    }

    if (path === "/api/isolation/files/read" && method === "POST") {
      const parsed = fileReadSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_file_read", issues: parsed.error.issues });
      const result = isolation.readTenantFile(parsed.data);
      return json(res, result.allowed ? 200 : 403, result);
    }

    if (path === "/api/isolation/orders/read" && method === "POST") {
      const parsed = ordersReadSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_orders_read", issues: parsed.error.issues });
      const result = isolation.listTenantOrders(parsed.data);
      return json(res, result.allowed ? 200 : 403, result);
    }

    if (path === "/api/isolation/network/probe" && method === "POST") {
      const parsed = networkProbeSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_network_probe", issues: parsed.error.issues });
      const decision = isolation.checkVmNetworkAccess(parsed.data);
      return json(res, decision.allowed ? 200 : 403, decision);
    }

    if (path === "/api/isolation/bots/register" && method === "POST") {
      const parsed = registerBotSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_bot_register", issues: parsed.error.issues });
      return json(res, 200, { bot: isolation.registerBot(parsed.data) });
    }

    if (path === "/api/isolation/bots/action" && method === "POST") {
      const parsed = botActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_bot_action", issues: parsed.error.issues });
      const result = isolation.executeBotAction(parsed.data);
      return json(res, result.allowed ? 200 : 403, result);
    }

    if (path === "/api/isolation/vm/restart" && method === "POST") {
      const parsed = tenantActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_restart", issues: parsed.error.issues });
      return json(res, 200, isolation.restartVm(parsed.data.tenantId));
    }

    if (path === "/api/isolation/vm/hibernate" && method === "POST") {
      const parsed = tenantActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_hibernate", issues: parsed.error.issues });
      return json(res, 200, isolation.hibernateVm(parsed.data.tenantId));
    }

    if (path === "/api/isolation/vm/wake" && method === "POST") {
      const parsed = tenantActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_wake", issues: parsed.error.issues });
      return json(res, 200, isolation.wakeVm(parsed.data.tenantId));
    }

    if (path === "/api/isolation/vm/snapshot" && method === "POST") {
      const parsed = tenantActionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_snapshot", issues: parsed.error.issues });
      return json(res, 200, { snapshot: isolation.createSnapshot(parsed.data.tenantId) });
    }

    if (path === "/api/isolation/vm/migrate" && method === "POST") {
      const parsed = migrateSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_migrate", issues: parsed.error.issues });
      return json(res, 200, isolation.migrateVm(parsed.data.tenantId, parsed.data.targetHostNodeId));
    }

    if (path === "/api/isolation/feishu/route" && method === "POST") {
      const parsed = feishuRouteSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_feishu_route", issues: parsed.error.issues });
      return json(res, 200, isolation.routeFeishuMessage(parsed.data));
    }

    if (path === "/api/isolation/accounts/register" && method === "POST") {
      const parsed = accountSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_account", issues: parsed.error.issues });
      return json(res, 200, { account: isolation.registerPreinstalledAccount(parsed.data) });
    }

    if (path === "/api/isolation/knowledge" && method === "POST") {
      const parsed = knowledgeAddSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_knowledge", issues: parsed.error.issues });
      const result = isolation.addStableKnowledge(parsed.data);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (path === "/api/isolation/retrieve" && method === "POST") {
      const parsed = retrieveSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_retrieve", issues: parsed.error.issues });
      return json(res, 200, { bundle: isolation.retrieveTicketContext(parsed.data) });
    }

    if (path === "/api/isolation/realtime/query" && method === "POST") {
      const parsed = realtimeQuerySchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_realtime_query", issues: parsed.error.issues });
      return json(res, 200, { result: isolation.queryRealtimeData(parsed.data) });
    }

    if (path === "/api/isolation/health/report" && method === "POST") {
      const parsed = healthMetricSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_health_metric", issues: parsed.error.issues });
      return json(res, 200, { alerts: isolation.reportVmHealthMetric(parsed.data) });
    }

    if (path === "/api/isolation/density" && method === "GET") {
      const hostNodeId = url.searchParams.get("hostNodeId") ?? undefined;
      return json(res, 200, { density: isolation.getHostDensityReport(hostNodeId) });
    }

    if (path === "/api/isolation/metering" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!tenantId) return json(res, 400, { error: "missing_tenant_id" });
      return json(res, 200, { metering: isolation.getMeteringSummary(tenantId) });
    }

    if (path === "/api/isolation/audit" && method === "GET") {
      const tenantId = url.searchParams.get("tenantId") ?? undefined;
      return json(res, 200, { audit: isolation.store.listAudit(tenantId) });
    }

    if (path === "/api/isolation/deploy/validate" && method === "POST") {
      const parsed = privateDeployValidateSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_deploy_spec", issues: parsed.error.issues });
      const result = isolation.validatePrivateDeployment(parsed.data);
      return json(res, result.ok ? 200 : 400, result);
    }

    return PASS;
  };
}
