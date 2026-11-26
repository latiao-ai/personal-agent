import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemorySkillEngine } from "../memory-skill/engine.ts";
import { DEFAULT_VM_QUOTA, IsolationEngine } from "./engine.ts";

const tempDirs: string[] = [];

function createTestEnv(): { engine: IsolationEngine; memorySkill: MemorySkillEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "omb-isolation-test-"));
  tempDirs.push(dir);
  const memorySkill = new MemorySkillEngine({ dbPath: join(dir, "memory-skill.sqlite") });
  const engine = new IsolationEngine({
    dbPath: join(dir, "isolation.sqlite"),
    dataDir: dir,
    memorySkill,
  });
  return { engine, memorySkill, dir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MVP6 Isolation & Deployment Engine", () => {
  it("Spec 1: A 客户的 Bot 看不到 B 客户的文件和订单，且记录拒绝审计", () => {
    const { engine } = createTestEnv();
    const { vm: vmA } = engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });
    const { vm: vmB } = engine.provisionTenant({ tenantId: "tenant-b", openIds: ["ou_b"] });

    expect(vmA.diskPath).not.toBe(vmB.diskPath);
    expect(vmA.browserProfilePath).not.toBe(vmB.browserProfilePath);
    expect(vmA.ipAddress).not.toBe(vmB.ipAddress);

    engine.registerBot({ tenantId: "tenant-a", botId: "bot-a", role: "purchasing" });
    engine.registerBot({ tenantId: "tenant-b", botId: "bot-b", role: "purchasing" });

    engine.writeTenantFile("tenant-b", "contracts/secret-b.txt", "CONFIDENTIAL-B-PRICE");
    const placedB = engine.executeBotAction({
      tenantId: "tenant-b",
      botId: "bot-b",
      toolName: "place_order",
      orderPayload: { sku: "SKU-B-01", quantity: 10, amount: 500 },
    });
    expect(placedB.allowed).toBe(true);

    // Tenant A tries to read Tenant B's file and orders
    const crossFile = engine.readTenantFile({
      actorTenantId: "tenant-a",
      actorBotId: "bot-a",
      targetTenantId: "tenant-b",
      relPath: "contracts/secret-b.txt",
    });
    expect(crossFile.allowed).toBe(false);

    const crossOrders = engine.listTenantOrders({
      actorTenantId: "tenant-a",
      actorBotId: "bot-a",
      targetTenantId: "tenant-b",
    });
    expect(crossOrders.allowed).toBe(false);

    const auditA = engine.store.listAudit("tenant-a").filter((a) => a.outcome === "denied");
    expect(auditA.length).toBeGreaterThanOrEqual(2);
    expect(auditA.some((a) => a.reason === "cross_tenant_file_access_denied")).toBe(true);
    expect(auditA.some((a) => a.reason === "cross_tenant_order_access_denied")).toBe(true);

    // Tenant B can still read its own file and orders
    const ownFile = engine.readTenantFile({
      actorTenantId: "tenant-b",
      actorBotId: "bot-b",
      targetTenantId: "tenant-b",
      relPath: "contracts/secret-b.txt",
    });
    expect(ownFile).toEqual({ allowed: true, content: "CONFIDENTIAL-B-PRICE" });
    engine.close();
  });

  it("Spec 2: A 用户 VM 内主动扫描网络，访问不到 B 的 VM 和控制面内部接口，但可访问允许的控制面接口与出口代理", () => {
    const { engine } = createTestEnv();
    engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });
    const { vm: vmB } = engine.provisionTenant({ tenantId: "tenant-b", openIds: ["ou_b"] });

    // Scan B's VM IP
    const toVmB = engine.checkVmNetworkAccess({
      sourceTenantId: "tenant-a",
      targetAddress: vmB.ipAddress,
      targetPort: 8799,
    });
    expect(toVmB.allowed).toBe(false);
    expect(toVmB.reason).toContain("cross_vm_network_blocked");

    // Scan control-plane internal endpoint
    const toInternal = engine.checkVmNetworkAccess({
      sourceTenantId: "tenant-a",
      targetAddress: "10.200.0.1",
      targetPort: 8799,
      targetPath: "/internal/vault/raw",
    });
    expect(toInternal.allowed).toBe(false);
    expect(toInternal.reason).toBe("control_plane_internal_endpoint_blocked");

    // Scan cloud metadata service
    const toMetadata = engine.checkVmNetworkAccess({
      sourceTenantId: "tenant-a",
      targetAddress: "169.254.169.254",
      targetPort: 80,
    });
    expect(toMetadata.allowed).toBe(false);

    // Allowed: control-plane public API and egress proxy
    const toPublicApi = engine.checkVmNetworkAccess({
      sourceTenantId: "tenant-a",
      targetAddress: "10.200.0.1",
      targetPort: 8799,
      targetPath: "/api/tickets/create",
    });
    expect(toPublicApi.allowed).toBe(true);

    const toEgress = engine.checkVmNetworkAccess({
      sourceTenantId: "tenant-a",
      targetAddress: "10.200.0.2",
      targetPort: 3128,
    });
    expect(toEgress.allowed).toBe(true);

    // Denials recorded in audit & alerts
    const alerts = engine.store.listAlerts("tenant-a");
    expect(alerts.filter((a) => a.kind === "network_scan_blocked").length).toBe(3);
    engine.close();
  });

  it("Spec 3: VM 重启后持久磁盘状态和控制面审计记录均保持完整", () => {
    const { engine } = createTestEnv();
    engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });
    engine.writeTenantFile("tenant-a", "session/state.json", JSON.stringify({ step: 42 }));
    const auditBefore = engine.store.listAudit("tenant-a").length;

    const restarted = engine.restartVm("tenant-a");
    expect(restarted.stateIntact).toBe(true);
    expect(restarted.vm.restartCount).toBe(1);
    expect(restarted.auditCount).toBeGreaterThan(auditBefore);

    const readAfter = engine.readTenantFile({
      actorTenantId: "tenant-a",
      actorBotId: "bot-a",
      targetTenantId: "tenant-a",
      relPath: "session/state.json",
    });
    expect(readAfter).toEqual({ allowed: true, content: JSON.stringify({ step: 42 }) });
    engine.close();
  });

  it("Spec 4: VM 休眠时发飞书消息先排队，唤醒后按序回复不丢消息", () => {
    const { engine } = createTestEnv();
    engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_feishu_1"] });
    engine.registerBot({ tenantId: "tenant-a", botId: "buyer-bot", role: "purchasing" });

    const hib = engine.hibernateVm("tenant-a");
    expect(hib.vm.state).toBe("hibernated");
    expect(hib.memoryReleasedMb).toBe(DEFAULT_VM_QUOTA.memoryGb * 1024);

    // Send message while hibernated (queue only first to inspect queued state)
    const queued1 = engine.routeFeishuMessage({
      openId: "ou_feishu_1",
      messageId: "om_1",
      text: "查一下本周采购进度",
      autoWake: false,
    });
    expect(queued1.wasHibernated).toBe(true);
    expect(queued1.message.status).toBe("queued");

    // Second message triggers auto-wake and delivers both messages in FIFO order
    const woken2 = engine.routeFeishuMessage({
      openId: "ou_feishu_1",
      messageId: "om_2",
      text: "顺便确认发货时间",
      autoWake: true,
    });
    expect(woken2.wasHibernated).toBe(true);
    expect(woken2.message.status).toBe("delivered");
    expect(woken2.wakeLatencyMs).toBeGreaterThanOrEqual(1);

    const allMsgs = engine.store.listQueuedFeishuMessages("tenant-a");
    expect(allMsgs).toHaveLength(2);
    expect(allMsgs.every((m) => m.status === "delivered" && m.replyText !== null)).toBe(true);
    expect(engine.getTenantVm("tenant-a")?.state).toBe("running");
    engine.close();
  });

  it("Spec 5: 租户销户先导出数据再彻底删除，删除有回执，删除后读不到", () => {
    const { engine } = createTestEnv();
    const { vm } = engine.provisionTenant({ tenantId: "tenant-gone", openIds: ["ou_gone"] });
    engine.writeTenantFile("tenant-gone", "notes/plan.md", "export-me");
    engine.registerPreinstalledAccount({
      tenantId: "tenant-gone",
      kind: "user_email",
      provider: "mail",
      accountLabel: "Work Mail",
      email: "user@example.com",
      rawSecret: "super-secret-mail-pass",
    });
    engine.addStableKnowledge({
      tenantId: "tenant-gone",
      category: "sop",
      title: "退货 SOP",
      content: "7 天无理由退货流程",
    });

    const { exportBundle, deletionReceipt } = engine.offboardTenant("tenant-gone");
    expect(exportBundle.workspaceFiles["notes/plan.md"]).toBe("export-me");
    expect(exportBundle.knowledge).toHaveLength(1);
    expect(exportBundle.accounts).toHaveLength(1);
    expect(deletionReceipt.exportSha256).toBe(exportBundle.sha256);
    expect(deletionReceipt.deletedVaultSecrets).toBe(1);

    // Everything is permanently deleted and unreadable
    expect(existsSync(vm.diskPath)).toBe(false);
    expect(engine.getTenantVm("tenant-gone")).toBeNull();
    expect(engine.vault.listSecretNames("tenant-gone")).toEqual([]);
    expect(engine.store.listKnowledge("tenant-gone")).toEqual([]);
    expect(engine.store.getDeletionReceipt("tenant-gone")?.receiptId).toBe(deletionReceipt.receiptId);

    const readAfterDelete = engine.readTenantFile({
      actorTenantId: "tenant-gone",
      actorBotId: "bot-x",
      targetTenantId: "tenant-gone",
      relPath: "notes/plan.md",
    });
    expect(readAfterDelete.allowed).toBe(false);
    engine.close();
  });

  it("Spec 6: 同一用户多个 Bot 共享 VM 只做权限区分：采购 Bot 能下单，巡检 Bot 只能读", () => {
    const { engine } = createTestEnv();
    engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });
    const buyer = engine.registerBot({ tenantId: "tenant-a", botId: "buyer-bot", role: "purchasing" });
    const patrol = engine.registerBot({ tenantId: "tenant-a", botId: "patrol-bot", role: "patrol" });

    expect(buyer.workDir).not.toBe(patrol.workDir);
    expect(buyer.mandateHash).not.toBe(patrol.mandateHash);

    const buyOk = engine.executeBotAction({
      tenantId: "tenant-a",
      botId: "buyer-bot",
      toolName: "place_order",
      connector: "erp",
      tokenCost: 0.5,
      orderPayload: { sku: "SKU-100", quantity: 5, amount: 300 },
    });
    expect(buyOk.allowed).toBe(true);

    const patrolOrderDenied = engine.executeBotAction({
      tenantId: "tenant-a",
      botId: "patrol-bot",
      toolName: "place_order",
      orderPayload: { sku: "SKU-100", quantity: 1, amount: 60 },
    });
    expect(patrolOrderDenied.allowed).toBe(false);
    if (!patrolOrderDenied.allowed) {
      expect(patrolOrderDenied.reason).toBe("tool_not_in_bot_allowlist:patrol");
    }

    const patrolReadOk = engine.executeBotAction({
      tenantId: "tenant-a",
      botId: "patrol-bot",
      toolName: "read_inventory",
      connector: "erp_readonly",
      tokenCost: 0.1,
    });
    expect(patrolReadOk.allowed).toBe(true);

    // Budget accounting is per-bot
    const metering = engine.getMeteringSummary("tenant-a");
    expect(metering.perBotSpend["buyer-bot"]?.businessSpend).toBe(300);
    expect(metering.perBotSpend["patrol-bot"]?.businessSpend).toBe(0);
    engine.close();
  });

  it("Spec 7: VM 启动不加载全量记忆和技能副本，只按 Ticket 按需检索 Top-K 并在用后清理", () => {
    const { engine, memorySkill } = createTestEnv();
    const { vm } = engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });
    expect(vm.bootLoadedFullMemory).toBe(false);

    // Seed 6 long-term memories & 5 stable knowledge entries in control plane
    for (let i = 1; i <= 6; i += 1) {
      memorySkill.writeLongTerm({
        tenantId: "tenant-a",
        botId: "buyer-bot",
        scope: "user_shared",
        category: "preference",
        key: `pref_${i}`,
        content: i === 3 ? "周末不要下单，供应商周一发货" : `通用偏好条目 ${i}`,
        sourceTrust: "owner_chat",
        confirmedBy: "owner",
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      engine.addStableKnowledge({
        tenantId: "tenant-a",
        category: "sop",
        title: i === 2 ? "采购验货 SOP" : `常规文档 ${i}`,
        content: i === 2 ? "收货后先核对批次和质检报告" : `参考资料内容 ${i}`,
      });
    }

    const bundle = engine.retrieveTicketContext({
      tenantId: "tenant-a",
      botId: "buyer-bot",
      ticketId: "tkt_001",
      query: "周末下单 采购验货",
      topK: 2,
      neededEntities: ["Product", "Rule"],
    });
    expect(bundle.loadedFullCopy).toBe(false);
    expect(bundle.memories.length).toBe(2);
    expect(bundle.knowledge.length).toBe(2);
    expect(bundle.ontologySlice.sharedEntities.map((e) => e.name)).toEqual(["Product", "Rule"]);

    expect(engine.knowledgeLoader.hasActiveContext(bundle.ephemeralContextToken)).toBe(true);
    expect(engine.clearTicketContext(bundle.ephemeralContextToken)).toBe(true);
    expect(engine.knowledgeLoader.hasActiveContext(bundle.ephemeralContextToken)).toBe(false);
    engine.close();
  });

  it("Spec 8: 实时数据禁止写入知识库，查库存必须实时查 ERP/数据库/平台 API", () => {
    const { engine } = createTestEnv();
    engine.provisionTenant({ tenantId: "tenant-a", openIds: ["ou_a"] });

    // Attempt to write real-time inventory into KB must be rejected
    const badKb1 = engine.addStableKnowledge({
      tenantId: "tenant-a",
      category: "product_knowledge",
      title: "SKU-001 实时库存",
      content: "当前库存 99 件",
    });
    expect(badKb1.ok).toBe(false);

    const badKb2 = engine.addStableKnowledge({
      tenantId: "tenant-a",
      category: "product_knowledge",
      title: "报价记录",
      content: "普通描述",
      dataKind: "realtime_price",
    });
    expect(badKb2.ok).toBe(false);

    // Live inventory query hits ERP directly, never KB
    const liveInv = engine.queryRealtimeData({
      tenantId: "tenant-a",
      kind: "inventory",
      key: "SKU-001",
    });
    expect(liveInv.fromKnowledgeBase).toBe(false);
    expect(liveInv.source).toBe("erp");
    expect(liveInv.payload.live).toBe(true);
    engine.close();
  });

  it("资源调度、预热池、快照迁移、预装账号 Vault 替身、监控告警与私有部署合规校验", () => {
    const { engine } = createTestEnv();

    // 1. Warm pool prewarm & claim
    const warmed = engine.prewarmPool(2, "host-node-1");
    expect(warmed).toHaveLength(2);
    const provisioned = engine.provisionTenant({ tenantId: "tenant-warm", openIds: ["ou_warm"] });
    expect(provisioned.claimedFromWarmPool).toBe(true);
    expect(provisioned.firecrackerConfig["machine-config"].vcpu_count).toBe(2);
    expect(provisioned.firecrackerConfig["machine-config"].mem_size_mib).toBe(4096);

    // 2. Snapshot & cross-host migration
    engine.writeTenantFile("tenant-warm", "work/data.txt", "before-migrate");
    const migrated = engine.migrateVm("tenant-warm", "host-node-2");
    expect(migrated.vm.hostNodeId).toBe("host-node-2");
    expect(migrated.restoreMs).toBeGreaterThanOrEqual(1);

    // 3. Pre-installed account secret stays in Vault, never plaintext in VM
    const acct = engine.registerPreinstalledAccount({
      tenantId: "tenant-warm",
      kind: "preinstalled_app",
      provider: "supplier-portal",
      accountLabel: "1688 Buyer",
      rawSecret: "REAL-API-SECRET-999",
    });
    const vmFiles = engine.driver.listWorkspaceFiles(migrated.vm);
    expect(JSON.stringify(vmFiles)).not.toContain("REAL-API-SECRET-999");
    const token = engine.issueAccountSurrogateToken({
      tenantId: "tenant-warm",
      ticketId: "tkt_acct_1",
      toolAllowlist: ["browser_act"],
    });
    expect(token.token.startsWith("stkn_")).toBe(true);
    expect(acct.vaultSecretName).toContain("supplier-portal");

    // 4. Health alerts & host density
    const alerts = engine.reportVmHealthMetric({
      tenantId: "tenant-warm",
      alive: false,
      diskUsagePercent: 96,
      cpuUsagePercent: 95,
    });
    expect(alerts.map((a) => a.kind).sort()).toEqual(["cpu_overload", "disk_full", "vm_down"]);
    const density = engine.getHostDensityReport("host-node-2");
    expect(density.totalVms).toBe(1);

    // 5. Private deployment validation: forbid source code & unlicensed enterprise/
    const badDeploy = engine.validatePrivateDeployment({
      mode: "cloud_control_plane_worker",
      controlPlaneCallbackUrl: "https://cp.vendor.example/api",
      includesSourceCode: true,
      includesEnterpriseDir: true,
      enterpriseCommercialLicenseVerified: false,
      preservedNotices: ["LICENSE"],
    });
    expect(badDeploy.ok).toBe(false);
    expect(badDeploy.violations.length).toBeGreaterThanOrEqual(3);

    const goodDeploy = engine.validatePrivateDeployment({
      mode: "cloud_control_plane_worker",
      controlPlaneCallbackUrl: "https://cp.vendor.example/api",
      includesSourceCode: false,
      includesEnterpriseDir: false,
      enterpriseCommercialLicenseVerified: false,
      preservedNotices: ["LICENSE", "NOTICE", "third_party/cua-driver"],
    });
    expect(goodDeploy.ok).toBe(true);
    engine.close();
  });
});
