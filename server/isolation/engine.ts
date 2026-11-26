import { createHash, randomBytes } from "node:crypto";

import type { DualBudgetPolicy, EphemeralSurrogateToken } from "../../shared/approvals.ts";
import type {
  HostDensityReport,
  IsolationAuditEntry,
  KnowledgeEntry,
  MonitoringAlert,
  NetworkAccessDecision,
  PreinstalledAccount,
  PrivateDeploymentSpec,
  PrivateDeploymentValidationResult,
  QueuedFeishuMessage,
  RealtimeDataKind,
  RealtimeDataQueryResult,
  SharedVmBotRole,
  StableKnowledgeCategory,
  TenantDeletionReceipt,
  TenantExportBundle,
  TenantMeteringSummary,
  TenantVmRecord,
  TicketTopKBundle,
  VmBotProfile,
  VmQuota,
  VmSnapshotRecord,
  WarmPoolVmRecord,
} from "../../shared/isolation.ts";
import { DEFAULT_DUAL_BUDGET_POLICY, evaluateDualBudget } from "../approvals/budget.ts";
import { ControlPlaneVault } from "../approvals/vault.ts";
import { DEFAULT_DESKTOP_RESOURCES } from "../container-limits.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import { validatePrivateDeploymentSpec } from "./deployment.ts";
import { buildFirecrackerConfig, IsolatedLocalDriver, type FirecrackerVmConfig, type MicroVmDriver } from "./driver.ts";
import { ControlPlaneKnowledgeLoader } from "./knowledge-loader.ts";
import { DEFAULT_NETWORK_POLICY_CONFIG, evaluateVmNetworkAccess, type NetworkPolicyConfig } from "./network-policy.ts";
import { IsolationStore, type TenantOrderRecord } from "./store.ts";

export const DEFAULT_VM_QUOTA: VmQuota = {
  vcpu: DEFAULT_DESKTOP_RESOURCES.cpus,
  memoryGb: DEFAULT_DESKTOP_RESOURCES.memoryGb,
  diskGb: 20,
};

const ROLE_DEFAULT_TOOLS: Record<SharedVmBotRole, string[]> = {
  purchasing: ["read_inventory", "read_order", "place_order", "approve_po", "browser_act"],
  patrol: ["read_inventory", "read_order", "read_price"],
  followup: ["read_order", "send_followup_notice", "read_shipment"],
  custom: ["read_inventory"],
};

const ROLE_DEFAULT_CONNECTORS: Record<SharedVmBotRole, string[]> = {
  purchasing: ["erp", "supplier_portal", "payment_proxy"],
  patrol: ["erp_readonly", "order_readonly"],
  followup: ["erp_readonly", "logistics_api"],
  custom: [],
};

export interface IsolationEngineOptions {
  dbPath: string;
  dataDir: string;
  hostNodeId?: string;
  driver?: MicroVmDriver;
  vault?: ControlPlaneVault;
  memorySkill?: MemorySkillEngine;
  networkPolicy?: NetworkPolicyConfig;
  now?: () => number;
}

/**
 * MVP6 Control-Plane Isolation & Deployment Engine.
 * Orchestrates per-tenant microVMs, persistent disks, network isolation, multi-bot shared-VM
 * permissions, warm pool, hibernation & Feishu wake queue, Vault pre-installed accounts,
 * on-demand Top-K loading, real-time data routing, metering, monitoring, and offboarding.
 */
export class IsolationEngine {
  readonly store: IsolationStore;
  readonly driver: MicroVmDriver;
  readonly vault: ControlPlaneVault;
  readonly knowledgeLoader: ControlPlaneKnowledgeLoader;
  private readonly hostNodeId: string;
  private readonly networkPolicy: NetworkPolicyConfig;
  private readonly now: () => number;
  private ipCounter = 10;

  constructor(options: IsolationEngineOptions) {
    this.store = new IsolationStore(options.dbPath);
    this.driver = options.driver ?? new IsolatedLocalDriver(options.dataDir);
    this.vault = options.vault ?? new ControlPlaneVault(options.now);
    this.knowledgeLoader = new ControlPlaneKnowledgeLoader(this.store, options.memorySkill);
    this.hostNodeId = options.hostNodeId ?? "host-node-1";
    this.networkPolicy = options.networkPolicy ?? DEFAULT_NETWORK_POLICY_CONFIG;
    this.now = options.now ?? Date.now;
  }

  close(): void {
    this.store.close();
  }

  private nextVmAddress(): { ipAddress: string; subnetCidr: string } {
    const existing = new Set([
      ...this.store.listTenantVms().map((v) => v.ipAddress),
      ...this.store.listAvailableWarmVms().map((v) => v.ipAddress),
    ]);
    while (true) {
      const third = Math.floor(this.ipCounter / 250) + 1;
      const fourth = (this.ipCounter % 250) + 2;
      this.ipCounter += 1;
      const ipAddress = `10.200.${third}.${fourth}`;
      if (!existing.has(ipAddress)) {
        return { ipAddress, subnetCidr: `${ipAddress}/32` };
      }
    }
  }

  private recordAudit(input: {
    tenantId: string;
    vmId?: string | null;
    botId?: string | null;
    action: string;
    outcome: IsolationAuditEntry["outcome"];
    reason: string;
    details?: Record<string, unknown>;
  }): IsolationAuditEntry {
    const entry: IsolationAuditEntry = {
      id: `aud_${randomBytes(8).toString("hex")}`,
      tenantId: input.tenantId,
      vmId: input.vmId ?? null,
      botId: input.botId ?? null,
      action: input.action,
      outcome: input.outcome,
      reason: input.reason,
      details: input.details ?? {},
      createdAt: this.now(),
    };
    this.store.appendAudit(entry);
    return entry;
  }

  private raiseAlert(input: {
    tenantId?: string | null;
    vmId?: string | null;
    hostNodeId?: string;
    kind: MonitoringAlert["kind"];
    severity: MonitoringAlert["severity"];
    message: string;
  }): MonitoringAlert {
    const alert: MonitoringAlert = {
      id: `alt_${randomBytes(8).toString("hex")}`,
      tenantId: input.tenantId ?? null,
      vmId: input.vmId ?? null,
      hostNodeId: input.hostNodeId ?? this.hostNodeId,
      kind: input.kind,
      severity: input.severity,
      message: input.message,
      createdAt: this.now(),
    };
    this.store.insertAlert(alert);
    return alert;
  }

  // --- Warm Pool & Provisioning ---

  prewarmPool(count: number, hostNodeId = this.hostNodeId, quota: VmQuota = DEFAULT_VM_QUOTA): WarmPoolVmRecord[] {
    const created: WarmPoolVmRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const addr = this.nextVmAddress();
      const vm: WarmPoolVmRecord = {
        vmId: `vm_warm_${randomBytes(6).toString("hex")}`,
        hostNodeId,
        driver: this.driver.kind,
        quota: { ...quota },
        ipAddress: addr.ipAddress,
        subnetCidr: addr.subnetCidr,
        createdAt: this.now(),
        claimedByTenantId: null,
      };
      this.store.insertWarmVm(vm);
      created.push(vm);
    }
    return created;
  }

  provisionTenant(input: {
    tenantId: string;
    openIds: string[];
    quota?: Partial<VmQuota>;
    hostNodeId?: string;
  }): { vm: TenantVmRecord; claimedFromWarmPool: boolean; firecrackerConfig: FirecrackerVmConfig } {
    const existing = this.store.getTenantVm(input.tenantId);
    if (existing && existing.state !== "deleted") {
      return {
        vm: existing,
        claimedFromWarmPool: false,
        firecrackerConfig: buildFirecrackerConfig(existing),
      };
    }

    const hostNodeId = input.hostNodeId ?? this.hostNodeId;
    const quota: VmQuota = {
      vcpu: input.quota?.vcpu ?? DEFAULT_VM_QUOTA.vcpu,
      memoryGb: input.quota?.memoryGb ?? DEFAULT_VM_QUOTA.memoryGb,
      diskGb: input.quota?.diskGb ?? DEFAULT_VM_QUOTA.diskGb,
    };

    const claimed = this.store.claimWarmVm(input.tenantId, hostNodeId);
    const vmId = claimed ? claimed.vmId : `vm_${randomBytes(6).toString("hex")}`;
    const addr = claimed
      ? { ipAddress: claimed.ipAddress, subnetCidr: claimed.subnetCidr }
      : this.nextVmAddress();
    const { diskPath, browserProfilePath } = this.driver.provisionDisk(input.tenantId, vmId, quota);
    const now = this.now();

    const vm: TenantVmRecord = {
      tenantId: input.tenantId,
      vmId,
      hostNodeId,
      driver: this.driver.kind,
      openIds: [...new Set(input.openIds)],
      state: "running",
      quota,
      ipAddress: addr.ipAddress,
      subnetCidr: addr.subnetCidr,
      diskPath,
      browserProfilePath,
      latestSnapshotId: null,
      bootLoadedFullMemory: false,
      restartCount: 0,
      wakeLatencyMs: null,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      hibernatedAt: null,
    };
    this.store.saveTenantVm(vm);

    this.recordAudit({
      tenantId: input.tenantId,
      vmId,
      action: "tenant_provision",
      outcome: "allowed",
      reason: claimed ? "provisioned_from_warm_pool" : "provisioned_fresh_vm",
      details: { hostNodeId, quota, ipAddress: vm.ipAddress, bootLoadedFullMemory: false },
    });

    return { vm, claimedFromWarmPool: Boolean(claimed), firecrackerConfig: buildFirecrackerConfig(vm) };
  }

  getTenantVm(tenantId: string): TenantVmRecord | null {
    return this.store.getTenantVm(tenantId);
  }

  // --- File & Order Isolation ---

  writeTenantFile(tenantId: string, relPath: string, content: string): { path: string; storageBytes: number } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const fullPath = this.driver.writeWorkspaceFile(vm, relPath, content);
    const storageBytes = this.driver.measureDiskBytes(vm.diskPath);
    this.store.recordMetering({ tenantId, storageBytes, recordedAt: this.now() });
    return { path: fullPath, storageBytes };
  }

  readTenantFile(input: {
    actorTenantId: string;
    actorBotId: string;
    targetTenantId: string;
    relPath: string;
  }): { allowed: true; content: string | null } | { allowed: false; reason: string } {
    if (input.actorTenantId !== input.targetTenantId) {
      const actorVm = this.store.getTenantVm(input.actorTenantId);
      this.recordAudit({
        tenantId: input.actorTenantId,
        vmId: actorVm?.vmId ?? null,
        botId: input.actorBotId,
        action: "file_read",
        outcome: "denied",
        reason: "cross_tenant_file_access_denied",
        details: { targetTenantId: input.targetTenantId, relPath: input.relPath },
      });
      this.raiseAlert({
        tenantId: input.actorTenantId,
        vmId: actorVm?.vmId ?? null,
        kind: "cross_tenant_denied",
        severity: "critical",
        message: `租户 ${input.actorTenantId} 的 Bot ${input.actorBotId} 尝试越权读取租户 ${input.targetTenantId} 文件 ${input.relPath}`,
      });
      return { allowed: false, reason: "cross_tenant_file_access_denied" };
    }
    const vm = this.store.getTenantVm(input.targetTenantId);
    if (!vm || vm.state === "deleted") return { allowed: false, reason: "tenant_vm_not_found" };
    return { allowed: true, content: this.driver.readWorkspaceFile(vm, input.relPath) };
  }

  listTenantOrders(input: {
    actorTenantId: string;
    actorBotId: string;
    targetTenantId: string;
  }): { allowed: true; orders: TenantOrderRecord[] } | { allowed: false; reason: string } {
    if (input.actorTenantId !== input.targetTenantId) {
      const actorVm = this.store.getTenantVm(input.actorTenantId);
      this.recordAudit({
        tenantId: input.actorTenantId,
        vmId: actorVm?.vmId ?? null,
        botId: input.actorBotId,
        action: "orders_read",
        outcome: "denied",
        reason: "cross_tenant_order_access_denied",
        details: { targetTenantId: input.targetTenantId },
      });
      return { allowed: false, reason: "cross_tenant_order_access_denied" };
    }
    const vm = this.store.getTenantVm(input.targetTenantId);
    if (!vm || vm.state === "deleted") return { allowed: false, reason: "tenant_vm_not_found" };
    return { allowed: true, orders: this.store.listOrders(input.targetTenantId) };
  }

  // --- Network Isolation & Active Scan Defense ---

  checkVmNetworkAccess(input: {
    sourceTenantId: string;
    targetAddress: string;
    targetPort: number;
    targetPath?: string;
  }): NetworkAccessDecision {
    const sourceVm = this.store.getTenantVm(input.sourceTenantId);
    if (!sourceVm || sourceVm.state === "deleted") {
      throw new Error(`tenant_vm_not_found:${input.sourceTenantId}`);
    }
    const decision = evaluateVmNetworkAccess({
      sourceVm,
      allVms: this.store.listTenantVms(),
      targetAddress: input.targetAddress,
      targetPort: input.targetPort,
      targetPath: input.targetPath,
      config: this.networkPolicy,
    });
    if (!decision.allowed) {
      this.recordAudit({
        tenantId: sourceVm.tenantId,
        vmId: sourceVm.vmId,
        action: "network_probe",
        outcome: "denied",
        reason: decision.reason,
        details: {
          targetAddress: decision.targetAddress,
          targetPort: decision.targetPort,
          targetPath: decision.targetPath ?? null,
        },
      });
      this.raiseAlert({
        tenantId: sourceVm.tenantId,
        vmId: sourceVm.vmId,
        hostNodeId: sourceVm.hostNodeId,
        kind: "network_scan_blocked",
        severity: "critical",
        message: `VM ${sourceVm.vmId} 尝试访问 ${decision.targetAddress}:${decision.targetPort}${decision.targetPath ?? ""} 被拦截（${decision.reason}）`,
      });
    }
    return decision;
  }

  // --- Same-User Multi-Bot Shared VM Permissions ---

  registerBot(input: {
    tenantId: string;
    botId: string;
    role: SharedVmBotRole;
    toolAllowlist?: string[];
    allowedConnectors?: string[];
    budgetPolicy?: Partial<DualBudgetPolicy>;
  }): VmBotProfile {
    const vm = this.store.getTenantVm(input.tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${input.tenantId}`);
    const toolAllowlist = input.toolAllowlist ?? ROLE_DEFAULT_TOOLS[input.role];
    const allowedConnectors = input.allowedConnectors ?? ROLE_DEFAULT_CONNECTORS[input.role];
    const budgetPolicy: DualBudgetPolicy = { ...DEFAULT_DUAL_BUDGET_POLICY, ...input.budgetPolicy };
    const workDir = `${vm.diskPath}/workspace/bots/${input.botId}`;
    const mandateHash = createHash("sha256")
      .update(JSON.stringify({ tenantId: input.tenantId, botId: input.botId, role: input.role, toolAllowlist, allowedConnectors }))
      .digest("hex");

    const profile: VmBotProfile = {
      tenantId: input.tenantId,
      botId: input.botId,
      role: input.role,
      toolAllowlist,
      workDir,
      allowedConnectors,
      mandateHash,
      budgetPolicy,
      createdAt: this.now(),
    };
    this.store.saveBotProfile(profile);
    return profile;
  }

  executeBotAction(input: {
    tenantId: string;
    botId: string;
    toolName: string;
    connector?: string;
    tokenCost?: number;
    businessCost?: number;
    orderPayload?: { sku: string; quantity: number; amount: number };
  }): { allowed: true; order?: TenantOrderRecord } | { allowed: false; reason: string } {
    const vm = this.store.getTenantVm(input.tenantId);
    if (!vm || vm.state === "deleted") return { allowed: false, reason: "tenant_vm_not_found" };
    const bot = this.store.getBotProfile(input.tenantId, input.botId);
    if (!bot) return { allowed: false, reason: "bot_not_registered" };

    if (!bot.toolAllowlist.includes(input.toolName)) {
      this.recordAudit({
        tenantId: input.tenantId,
        vmId: vm.vmId,
        botId: input.botId,
        action: `tool:${input.toolName}`,
        outcome: "denied",
        reason: `tool_not_in_bot_allowlist:${bot.role}`,
        details: { toolAllowlist: bot.toolAllowlist },
      });
      return { allowed: false, reason: `tool_not_in_bot_allowlist:${bot.role}` };
    }

    if (input.connector && !bot.allowedConnectors.includes(input.connector)) {
      this.recordAudit({
        tenantId: input.tenantId,
        vmId: vm.vmId,
        botId: input.botId,
        action: `connector:${input.connector}`,
        outcome: "denied",
        reason: "connector_not_allowed_for_bot",
        details: { allowedConnectors: bot.allowedConnectors },
      });
      return { allowed: false, reason: "connector_not_allowed_for_bot" };
    }

    const summary = this.store.getMeteringSummary(input.tenantId);
    const botTotals = summary.perBotSpend[input.botId] ?? { tokenSpend: 0, businessSpend: 0 };
    const budgetCheck = evaluateDualBudget(
      bot.budgetPolicy,
      {
        tokenDay: botTotals.tokenSpend,
        tokenMonth: botTotals.tokenSpend,
        businessDay: botTotals.businessSpend,
        businessMonth: botTotals.businessSpend,
      },
      { tokenCost: input.tokenCost ?? 0, businessCost: input.businessCost ?? input.orderPayload?.amount ?? 0 },
    );
    if (!budgetCheck.ok) {
      this.recordAudit({
        tenantId: input.tenantId,
        vmId: vm.vmId,
        botId: input.botId,
        action: `tool:${input.toolName}`,
        outcome: "denied",
        reason: budgetCheck.dimension,
        details: { limit: budgetCheck.limit, projected: budgetCheck.projected },
      });
      return { allowed: false, reason: budgetCheck.reason };
    }

    let order: TenantOrderRecord | undefined;
    if (input.toolName === "place_order" && input.orderPayload) {
      order = {
        id: `ord_${randomBytes(6).toString("hex")}`,
        tenantId: input.tenantId,
        botId: input.botId,
        sku: input.orderPayload.sku,
        quantity: input.orderPayload.quantity,
        amount: input.orderPayload.amount,
        status: "placed",
        createdAt: this.now(),
      };
      this.store.insertOrder(order);
    }

    this.store.recordMetering({
      tenantId: input.tenantId,
      botId: input.botId,
      tokenSpend: input.tokenCost ?? 0,
      businessSpend: input.businessCost ?? input.orderPayload?.amount ?? 0,
      recordedAt: this.now(),
    });

    this.recordAudit({
      tenantId: input.tenantId,
      vmId: vm.vmId,
      botId: input.botId,
      action: `tool:${input.toolName}`,
      outcome: "allowed",
      reason: "bot_mandate_and_budget_verified",
      details: order ? { orderId: order.id } : {},
    });

    return { allowed: true, ...(order ? { order } : {}) };
  }

  // --- Lifecycle: Restart, Hibernate, Wake, Snapshot, Migrate ---

  restartVm(tenantId: string): { vm: TenantVmRecord; stateIntact: boolean; auditCount: number } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const { restartedAt, stateIntact } = this.driver.restartVm(vm);
    const updated: TenantVmRecord = {
      ...vm,
      state: "running",
      restartCount: vm.restartCount + 1,
      updatedAt: restartedAt,
      lastActiveAt: restartedAt,
      hibernatedAt: null,
    };
    this.store.saveTenantVm(updated);
    this.recordAudit({
      tenantId,
      vmId: vm.vmId,
      action: "vm_restart",
      outcome: "recorded",
      reason: stateIntact ? "persistent_disk_intact" : "persistent_disk_missing",
      details: { restartCount: updated.restartCount },
    });
    return { vm: updated, stateIntact, auditCount: this.store.listAudit(tenantId).length };
  }

  hibernateVm(tenantId: string): { vm: TenantVmRecord; memoryReleasedMb: number } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const { hibernatedAt, memoryReleasedMb } = this.driver.hibernateVm(vm);
    const uptimeDelta = Math.max(0, hibernatedAt - vm.lastActiveAt);
    this.store.recordMetering({ tenantId, vmUptimeMs: uptimeDelta, recordedAt: hibernatedAt });
    const updated: TenantVmRecord = {
      ...vm,
      state: "hibernated",
      updatedAt: hibernatedAt,
      hibernatedAt,
    };
    this.store.saveTenantVm(updated);
    this.recordAudit({
      tenantId,
      vmId: vm.vmId,
      action: "vm_hibernate",
      outcome: "recorded",
      reason: "idle_memory_released",
      details: { memoryReleasedMb },
    });
    return { vm: updated, memoryReleasedMb };
  }

  wakeVm(tenantId: string): { vm: TenantVmRecord; wakeLatencyMs: number; deliveredMessages: QueuedFeishuMessage[] } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const { wokenAt, wakeLatencyMs } = this.driver.wakeVm(vm);
    const updated: TenantVmRecord = {
      ...vm,
      state: "running",
      wakeLatencyMs,
      updatedAt: wokenAt,
      lastActiveAt: wokenAt,
      hibernatedAt: null,
    };
    this.store.saveTenantVm(updated);

    // Flush queued Feishu messages in strict FIFO order without loss
    const queued = this.store.listQueuedFeishuMessages(tenantId, true);
    const deliveredMessages: QueuedFeishuMessage[] = [];
    for (const msg of queued) {
      const replyText = `[VM ${vm.vmId} / ${msg.botId}] 已唤醒并处理消息：${msg.text}`;
      const deliveredAt = this.now();
      this.store.markFeishuMessageDelivered(msg.id, replyText, deliveredAt);
      deliveredMessages.push({ ...msg, status: "delivered", replyText, deliveredAt });
    }

    this.recordAudit({
      tenantId,
      vmId: vm.vmId,
      action: "vm_wake",
      outcome: "recorded",
      reason: "vm_woken_and_queue_flushed",
      details: { wakeLatencyMs, deliveredCount: deliveredMessages.length },
    });
    return { vm: updated, wakeLatencyMs, deliveredMessages };
  }

  routeFeishuMessage(input: {
    openId: string;
    messageId: string;
    text: string;
    botId?: string;
    autoWake?: boolean;
  }): {
    tenantId: string;
    vmId: string;
    wasHibernated: boolean;
    message: QueuedFeishuMessage;
    wakeLatencyMs: number | null;
  } {
    const vm = this.store.findTenantVmByOpenId(input.openId);
    if (!vm) throw new Error(`feishu_open_id_unmapped:${input.openId}`);
    const bots = this.store.listBotProfiles(vm.tenantId);
    const targetBotId = input.botId ?? bots[0]?.botId ?? "default-bot";
    const now = this.now();
    const record: QueuedFeishuMessage = {
      id: `fmsg_${randomBytes(6).toString("hex")}`,
      tenantId: vm.tenantId,
      openId: input.openId,
      botId: targetBotId,
      messageId: input.messageId,
      text: input.text,
      status: "queued",
      replyText: null,
      queuedAt: now,
      deliveredAt: null,
    };
    this.store.enqueueFeishuMessage(record);

    if (vm.state === "hibernated") {
      if (input.autoWake === false) {
        return { tenantId: vm.tenantId, vmId: vm.vmId, wasHibernated: true, message: record, wakeLatencyMs: null };
      }
      const woken = this.wakeVm(vm.tenantId);
      const delivered = woken.deliveredMessages.find((m) => m.id === record.id) ?? record;
      return {
        tenantId: vm.tenantId,
        vmId: vm.vmId,
        wasHibernated: true,
        message: delivered,
        wakeLatencyMs: woken.wakeLatencyMs,
      };
    }

    const replyText = `[VM ${vm.vmId} / ${targetBotId}] 已处理消息：${input.text}`;
    const deliveredAt = this.now();
    this.store.markFeishuMessageDelivered(record.id, replyText, deliveredAt);
    return {
      tenantId: vm.tenantId,
      vmId: vm.vmId,
      wasHibernated: false,
      message: { ...record, status: "delivered", replyText, deliveredAt },
      wakeLatencyMs: null,
    };
  }

  createSnapshot(tenantId: string): VmSnapshotRecord {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const snapshotId = `snap_${randomBytes(6).toString("hex")}`;
    const res = this.driver.createSnapshot(vm, snapshotId);
    const record: VmSnapshotRecord = {
      snapshotId,
      tenantId,
      vmId: vm.vmId,
      hostNodeId: vm.hostNodeId,
      archivePath: res.archivePath,
      sha256: res.sha256,
      sizeBytes: res.sizeBytes,
      backupMs: res.backupMs,
      createdAt: this.now(),
    };
    this.store.insertSnapshot(record);
    this.store.saveTenantVm({ ...vm, latestSnapshotId: snapshotId, updatedAt: this.now() });
    return record;
  }

  migrateVm(tenantId: string, targetHostNodeId: string): { vm: TenantVmRecord; snapshotId: string; restoreMs: number } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);
    const snapshot = this.createSnapshot(tenantId);
    const { restoreMs } = this.driver.restoreSnapshot(snapshot.archivePath, snapshot.sha256, vm.diskPath);
    const migrated: TenantVmRecord = {
      ...vm,
      hostNodeId: targetHostNodeId,
      latestSnapshotId: snapshot.snapshotId,
      state: "running",
      updatedAt: this.now(),
    };
    this.store.saveTenantVm(migrated);
    this.recordAudit({
      tenantId,
      vmId: vm.vmId,
      action: "vm_migrate",
      outcome: "recorded",
      reason: "migrated_via_verified_snapshot",
      details: { fromHost: vm.hostNodeId, toHost: targetHostNodeId, snapshotId: snapshot.snapshotId, restoreMs },
    });
    return { vm: migrated, snapshotId: snapshot.snapshotId, restoreMs };
  }

  // --- Pre-installed Accounts (Vault-backed, never plaintext in VM) ---

  registerPreinstalledAccount(input: {
    tenantId: string;
    kind: "preinstalled_app" | "user_email";
    provider: string;
    accountLabel: string;
    email?: string;
    rawSecret: string;
  }): PreinstalledAccount {
    const vm = this.store.getTenantVm(input.tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${input.tenantId}`);
    const id = `acct_${randomBytes(6).toString("hex")}`;
    const vaultSecretName = `acct_${input.provider}_${id}`;
    this.vault.setSecret(input.tenantId, vaultSecretName, input.rawSecret);
    const account: PreinstalledAccount = {
      id,
      tenantId: input.tenantId,
      kind: input.kind,
      provider: input.provider,
      accountLabel: input.accountLabel,
      email: input.email ?? null,
      vaultSecretName,
      createdAt: this.now(),
    };
    this.store.savePreinstalledAccount(account);
    return account;
  }

  issueAccountSurrogateToken(input: {
    tenantId: string;
    ticketId: string;
    toolAllowlist: string[];
    maxTokenSpend?: number;
    maxBusinessSpend?: number;
  }): EphemeralSurrogateToken {
    return this.vault.issueSurrogateToken({
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      toolAllowlist: input.toolAllowlist,
      maxTokenSpend: input.maxTokenSpend ?? DEFAULT_DUAL_BUDGET_POLICY.tokenPerTx,
      maxBusinessSpend: input.maxBusinessSpend ?? DEFAULT_DUAL_BUDGET_POLICY.businessPerTx,
      currency: DEFAULT_DUAL_BUDGET_POLICY.currency,
    });
  }

  // --- On-Demand Top-K & Real-time Data Proxy ---

  addStableKnowledge(input: {
    tenantId: string;
    category: StableKnowledgeCategory;
    title: string;
    content: string;
    tags?: string[];
    dataKind?: string;
  }): { ok: true; entry: KnowledgeEntry } | { ok: false; code: "realtime_data_forbidden_in_kb"; reason: string } {
    return this.knowledgeLoader.addKnowledgeEntry(input);
  }

  retrieveTicketContext(input: {
    tenantId: string;
    botId: string;
    ticketId: string;
    query: string;
    topK?: number;
    domain?: string;
    neededEntities?: string[];
  }): TicketTopKBundle {
    return this.knowledgeLoader.retrieveForTicket(input);
  }

  clearTicketContext(ephemeralContextToken: string): boolean {
    return this.knowledgeLoader.clearTicketContext(ephemeralContextToken);
  }

  queryRealtimeData(input: {
    tenantId: string;
    kind: RealtimeDataKind;
    key: string;
  }): RealtimeDataQueryResult {
    return this.knowledgeLoader.queryRealtimeData(input);
  }

  // --- Tenant Offboarding (Export First, Then Permanently Delete) ---

  offboardTenant(tenantId: string): { exportBundle: TenantExportBundle; deletionReceipt: TenantDeletionReceipt } {
    const vm = this.store.getTenantVm(tenantId);
    if (!vm || vm.state === "deleted") throw new Error(`tenant_vm_not_found:${tenantId}`);

    const exportedAt = this.now();
    const exportId = `exp_${randomBytes(6).toString("hex")}`;
    const workspaceFiles = this.driver.listWorkspaceFiles(vm);
    const bots = this.store.listBotProfiles(tenantId);
    const accounts = this.store.listPreinstalledAccounts(tenantId);
    const knowledge = this.store.listKnowledge(tenantId);
    const orders = this.store.listOrders(tenantId).map((o) => ({
      id: o.id,
      sku: o.sku,
      quantity: o.quantity,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt,
    }));
    const auditLogCount = this.store.listAudit(tenantId).length;

    const payloadForHash = JSON.stringify({ tenantId, vm, bots, accounts, knowledge, orders, workspaceFiles });
    const sha256 = createHash("sha256").update(payloadForHash).digest("hex");

    const exportBundle: TenantExportBundle = {
      exportId,
      tenantId,
      exportedAt,
      sha256,
      vm,
      bots,
      accounts,
      knowledge,
      orders,
      workspaceFiles,
      auditLogCount,
    };

    // Permanently wipe disk, control-plane tenant data, and Vault secrets
    this.driver.destroyDisk(vm.diskPath);
    const vaultSecretsCount = this.vault.purgeTenantSecrets(tenantId);
    const { deletedKnowledgeRows, deletedOrderRows } = this.store.purgeTenantData(tenantId);

    const deletionReceipt: TenantDeletionReceipt = {
      receiptId: `del_${randomBytes(6).toString("hex")}`,
      tenantId,
      exportId,
      exportSha256: sha256,
      deletedVmId: vm.vmId,
      deletedDiskPath: vm.diskPath,
      deletedVaultSecrets: vaultSecretsCount,
      deletedKnowledgeRows,
      deletedOrderRows,
      deletedAt: this.now(),
    };
    this.store.insertDeletionReceipt(deletionReceipt);
    this.recordAudit({
      tenantId,
      vmId: vm.vmId,
      action: "tenant_offboard_delete",
      outcome: "recorded",
      reason: "exported_then_permanently_deleted",
      details: { receiptId: deletionReceipt.receiptId, exportId, exportSha256: sha256 },
    });

    return { exportBundle, deletionReceipt };
  }

  // --- Monitoring, Density & Metering ---

  reportVmHealthMetric(input: {
    tenantId: string;
    alive: boolean;
    diskUsagePercent: number;
    cpuUsagePercent: number;
  }): MonitoringAlert[] {
    const vm = this.store.getTenantVm(input.tenantId);
    if (!vm) throw new Error(`tenant_vm_not_found:${input.tenantId}`);
    const alerts: MonitoringAlert[] = [];
    if (!input.alive) {
      alerts.push(
        this.raiseAlert({
          tenantId: vm.tenantId,
          vmId: vm.vmId,
          hostNodeId: vm.hostNodeId,
          kind: "vm_down",
          severity: "critical",
          message: `VM ${vm.vmId}（租户 ${vm.tenantId}）无响应`,
        }),
      );
    }
    if (input.diskUsagePercent >= 85) {
      alerts.push(
        this.raiseAlert({
          tenantId: vm.tenantId,
          vmId: vm.vmId,
          hostNodeId: vm.hostNodeId,
          kind: "disk_full",
          severity: input.diskUsagePercent >= 95 ? "critical" : "warning",
          message: `VM ${vm.vmId} 磁盘使用率达到 ${input.diskUsagePercent}%`,
        }),
      );
    }
    if (input.cpuUsagePercent >= 90) {
      alerts.push(
        this.raiseAlert({
          tenantId: vm.tenantId,
          vmId: vm.vmId,
          hostNodeId: vm.hostNodeId,
          kind: "cpu_overload",
          severity: "warning",
          message: `VM ${vm.vmId} CPU 使用率达到 ${input.cpuUsagePercent}%，已触发配额限流`,
        }),
      );
    }
    return alerts;
  }

  getHostDensityReport(hostNodeId = this.hostNodeId): HostDensityReport {
    const vms = this.store.listTenantVms(hostNodeId);
    const warm = this.store.listAvailableWarmVms(hostNodeId);
    const runningVms = vms.filter((v) => v.state === "running").length;
    const hibernatedVms = vms.filter((v) => v.state === "hibernated").length;
    const allocatedVcpu = vms.reduce((acc, v) => acc + v.quota.vcpu, 0);
    const allocatedMemoryGb = vms
      .filter((v) => v.state === "running")
      .reduce((acc, v) => acc + v.quota.memoryGb, 0);
    const wakes = vms.map((v) => v.wakeLatencyMs).filter((n): n is number => n !== null);
    const averageWakeLatencyMs =
      wakes.length > 0 ? Math.round(wakes.reduce((a, b) => a + b, 0) / wakes.length) : null;
    return {
      hostNodeId,
      totalVms: vms.length,
      runningVms,
      hibernatedVms,
      warmPoolVms: warm.length,
      allocatedVcpu,
      allocatedMemoryGb,
      averageWakeLatencyMs,
    };
  }

  getMeteringSummary(tenantId: string): TenantMeteringSummary {
    return this.store.getMeteringSummary(tenantId);
  }

  validatePrivateDeployment(spec: PrivateDeploymentSpec): PrivateDeploymentValidationResult {
    return validatePrivateDeploymentSpec(spec);
  }
}
