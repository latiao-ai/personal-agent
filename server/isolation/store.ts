import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  IsolationAuditEntry,
  KnowledgeEntry,
  MonitoringAlert,
  PreinstalledAccount,
  QueuedFeishuMessage,
  StableKnowledgeCategory,
  TenantDeletionReceipt,
  TenantMeteringSummary,
  TenantVmRecord,
  VmBotProfile,
  VmLifecycleState,
  VmSnapshotRecord,
  WarmPoolVmRecord,
} from "../../shared/isolation.ts";

export interface TenantOrderRecord {
  id: string;
  tenantId: string;
  botId: string;
  sku: string;
  quantity: number;
  amount: number;
  status: string;
  createdAt: number;
}

/**
 * Control-plane SQLite store for MVP6 (`isolation.sqlite`).
 * Keeps tenant/VM state, warm pool, bot permission profiles, Feishu wake queue,
 * control-plane knowledge/ontology, snapshots, metering, alerts, and immutable audit logs
 * strictly outside any user microVM.
 */
export class IsolationStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.path = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Ignore on filesystems without POSIX chmod.
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS tenant_vms (
        tenant_id TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL UNIQUE,
        host_node_id TEXT NOT NULL,
        driver TEXT NOT NULL,
        open_ids_json TEXT NOT NULL,
        state TEXT NOT NULL,
        quota_json TEXT NOT NULL,
        ip_address TEXT NOT NULL UNIQUE,
        subnet_cidr TEXT NOT NULL,
        disk_path TEXT NOT NULL,
        browser_profile_path TEXT NOT NULL,
        latest_snapshot_id TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0,
        wake_latency_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        hibernated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS warm_pool_vms (
        vm_id TEXT PRIMARY KEY,
        host_node_id TEXT NOT NULL,
        driver TEXT NOT NULL,
        quota_json TEXT NOT NULL,
        ip_address TEXT NOT NULL UNIQUE,
        subnet_cidr TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        claimed_by_tenant_id TEXT
      );

      CREATE TABLE IF NOT EXISTS vm_bots (
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        role TEXT NOT NULL,
        tool_allowlist_json TEXT NOT NULL,
        work_dir TEXT NOT NULL,
        allowed_connectors_json TEXT NOT NULL,
        mandate_hash TEXT NOT NULL,
        budget_policy_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS preinstalled_accounts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_label TEXT NOT NULL,
        email TEXT,
        vault_secret_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_message_queue (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        reply_text TEXT,
        queued_at INTEGER NOT NULL,
        delivered_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS knowledge_base (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ontology_tenant_ext (
        tenant_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        extensions_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, domain)
      );

      CREATE TABLE IF NOT EXISTS tenant_orders (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vm_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        host_node_id TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        backup_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metering_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        bot_id TEXT,
        token_spend REAL NOT NULL DEFAULT 0,
        business_spend REAL NOT NULL DEFAULT 0,
        vm_uptime_ms INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitoring_alerts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        vm_id TEXT,
        host_node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS isolation_audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        vm_id TEXT,
        bot_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_deletion_receipts (
        receipt_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        export_id TEXT NOT NULL,
        export_sha256 TEXT NOT NULL,
        deleted_vm_id TEXT NOT NULL,
        deleted_disk_path TEXT NOT NULL,
        deleted_vault_secrets INTEGER NOT NULL,
        deleted_knowledge_rows INTEGER NOT NULL,
        deleted_order_rows INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private mapVm(row: Record<string, unknown>): TenantVmRecord {
    return {
      tenantId: String(row.tenant_id),
      vmId: String(row.vm_id),
      hostNodeId: String(row.host_node_id),
      driver: String(row.driver) as TenantVmRecord["driver"],
      openIds: JSON.parse(String(row.open_ids_json)) as string[],
      state: String(row.state) as VmLifecycleState,
      quota: JSON.parse(String(row.quota_json)) as TenantVmRecord["quota"],
      ipAddress: String(row.ip_address),
      subnetCidr: String(row.subnet_cidr),
      diskPath: String(row.disk_path),
      browserProfilePath: String(row.browser_profile_path),
      latestSnapshotId: row.latest_snapshot_id ? String(row.latest_snapshot_id) : null,
      bootLoadedFullMemory: false,
      restartCount: Number(row.restart_count),
      wakeLatencyMs: row.wake_latency_ms === null ? null : Number(row.wake_latency_ms),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastActiveAt: Number(row.last_active_at),
      hibernatedAt: row.hibernated_at === null ? null : Number(row.hibernated_at),
    };
  }

  saveTenantVm(vm: TenantVmRecord): void {
    this.db
      .prepare(
        `INSERT INTO tenant_vms (
          tenant_id, vm_id, host_node_id, driver, open_ids_json, state, quota_json,
          ip_address, subnet_cidr, disk_path, browser_profile_path, latest_snapshot_id,
          restart_count, wake_latency_ms, created_at, updated_at, last_active_at, hibernated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          host_node_id = excluded.host_node_id,
          open_ids_json = excluded.open_ids_json,
          state = excluded.state,
          quota_json = excluded.quota_json,
          disk_path = excluded.disk_path,
          browser_profile_path = excluded.browser_profile_path,
          latest_snapshot_id = excluded.latest_snapshot_id,
          restart_count = excluded.restart_count,
          wake_latency_ms = excluded.wake_latency_ms,
          updated_at = excluded.updated_at,
          last_active_at = excluded.last_active_at,
          hibernated_at = excluded.hibernated_at`,
      )
      .run(
        vm.tenantId,
        vm.vmId,
        vm.hostNodeId,
        vm.driver,
        JSON.stringify(vm.openIds),
        vm.state,
        JSON.stringify(vm.quota),
        vm.ipAddress,
        vm.subnetCidr,
        vm.diskPath,
        vm.browserProfilePath,
        vm.latestSnapshotId,
        vm.restartCount,
        vm.wakeLatencyMs,
        vm.createdAt,
        vm.updatedAt,
        vm.lastActiveAt,
        vm.hibernatedAt,
      );
  }

  getTenantVm(tenantId: string): TenantVmRecord | null {
    const row = this.db.prepare("SELECT * FROM tenant_vms WHERE tenant_id = ?").get(tenantId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapVm(row) : null;
  }

  findTenantVmByOpenId(openId: string): TenantVmRecord | null {
    const rows = this.db.prepare("SELECT * FROM tenant_vms WHERE state != 'deleted'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const vm = this.mapVm(row);
      if (vm.openIds.includes(openId)) return vm;
    }
    return null;
  }

  listTenantVms(hostNodeId?: string): TenantVmRecord[] {
    const rows = (
      hostNodeId
        ? this.db.prepare("SELECT * FROM tenant_vms WHERE host_node_id = ? ORDER BY created_at ASC").all(hostNodeId)
        : this.db.prepare("SELECT * FROM tenant_vms ORDER BY created_at ASC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapVm(r));
  }

  deleteTenantVmRow(tenantId: string): void {
    this.db.prepare("DELETE FROM tenant_vms WHERE tenant_id = ?").run(tenantId);
  }

  insertWarmVm(vm: WarmPoolVmRecord): void {
    this.db
      .prepare(
        `INSERT INTO warm_pool_vms (
          vm_id, host_node_id, driver, quota_json, ip_address, subnet_cidr, created_at, claimed_by_tenant_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        vm.vmId,
        vm.hostNodeId,
        vm.driver,
        JSON.stringify(vm.quota),
        vm.ipAddress,
        vm.subnetCidr,
        vm.createdAt,
        vm.claimedByTenantId,
      );
  }

  claimWarmVm(tenantId: string, hostNodeId?: string): WarmPoolVmRecord | null {
    const row = (
      hostNodeId
        ? this.db
            .prepare(
              "SELECT * FROM warm_pool_vms WHERE claimed_by_tenant_id IS NULL AND host_node_id = ? ORDER BY created_at ASC LIMIT 1",
            )
            .get(hostNodeId)
        : this.db
            .prepare("SELECT * FROM warm_pool_vms WHERE claimed_by_tenant_id IS NULL ORDER BY created_at ASC LIMIT 1")
            .get()
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE warm_pool_vms SET claimed_by_tenant_id = ? WHERE vm_id = ?")
      .run(tenantId, String(row.vm_id));
    return {
      vmId: String(row.vm_id),
      hostNodeId: String(row.host_node_id),
      driver: String(row.driver) as WarmPoolVmRecord["driver"],
      quota: JSON.parse(String(row.quota_json)) as WarmPoolVmRecord["quota"],
      ipAddress: String(row.ip_address),
      subnetCidr: String(row.subnet_cidr),
      createdAt: Number(row.created_at),
      claimedByTenantId: tenantId,
    };
  }

  listAvailableWarmVms(hostNodeId?: string): WarmPoolVmRecord[] {
    const rows = (
      hostNodeId
        ? this.db
            .prepare("SELECT * FROM warm_pool_vms WHERE claimed_by_tenant_id IS NULL AND host_node_id = ?")
            .all(hostNodeId)
        : this.db.prepare("SELECT * FROM warm_pool_vms WHERE claimed_by_tenant_id IS NULL").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      vmId: String(row.vm_id),
      hostNodeId: String(row.host_node_id),
      driver: String(row.driver) as WarmPoolVmRecord["driver"],
      quota: JSON.parse(String(row.quota_json)) as WarmPoolVmRecord["quota"],
      ipAddress: String(row.ip_address),
      subnetCidr: String(row.subnet_cidr),
      createdAt: Number(row.created_at),
      claimedByTenantId: null,
    }));
  }

  saveBotProfile(profile: VmBotProfile): void {
    this.db
      .prepare(
        `INSERT INTO vm_bots (
          tenant_id, bot_id, role, tool_allowlist_json, work_dir, allowed_connectors_json,
          mandate_hash, budget_policy_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, bot_id) DO UPDATE SET
          role = excluded.role,
          tool_allowlist_json = excluded.tool_allowlist_json,
          work_dir = excluded.work_dir,
          allowed_connectors_json = excluded.allowed_connectors_json,
          mandate_hash = excluded.mandate_hash,
          budget_policy_json = excluded.budget_policy_json`,
      )
      .run(
        profile.tenantId,
        profile.botId,
        profile.role,
        JSON.stringify(profile.toolAllowlist),
        profile.workDir,
        JSON.stringify(profile.allowedConnectors),
        profile.mandateHash,
        JSON.stringify(profile.budgetPolicy),
        profile.createdAt,
      );
  }

  getBotProfile(tenantId: string, botId: string): VmBotProfile | null {
    const row = this.db
      .prepare("SELECT * FROM vm_bots WHERE tenant_id = ? AND bot_id = ?")
      .get(tenantId, botId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      role: String(row.role) as VmBotProfile["role"],
      toolAllowlist: JSON.parse(String(row.tool_allowlist_json)) as string[],
      workDir: String(row.work_dir),
      allowedConnectors: JSON.parse(String(row.allowed_connectors_json)) as string[],
      mandateHash: String(row.mandate_hash),
      budgetPolicy: JSON.parse(String(row.budget_policy_json)) as VmBotProfile["budgetPolicy"],
      createdAt: Number(row.created_at),
    };
  }

  listBotProfiles(tenantId: string): VmBotProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM vm_bots WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      role: String(row.role) as VmBotProfile["role"],
      toolAllowlist: JSON.parse(String(row.tool_allowlist_json)) as string[],
      workDir: String(row.work_dir),
      allowedConnectors: JSON.parse(String(row.allowed_connectors_json)) as string[],
      mandateHash: String(row.mandate_hash),
      budgetPolicy: JSON.parse(String(row.budget_policy_json)) as VmBotProfile["budgetPolicy"],
      createdAt: Number(row.created_at),
    }));
  }

  savePreinstalledAccount(account: PreinstalledAccount): void {
    this.db
      .prepare(
        `INSERT INTO preinstalled_accounts (
          id, tenant_id, kind, provider, account_label, email, vault_secret_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.tenantId,
        account.kind,
        account.provider,
        account.accountLabel,
        account.email,
        account.vaultSecretName,
        account.createdAt,
      );
  }

  listPreinstalledAccounts(tenantId: string): PreinstalledAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM preinstalled_accounts WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      kind: String(row.kind) as PreinstalledAccount["kind"],
      provider: String(row.provider),
      accountLabel: String(row.account_label),
      email: row.email ? String(row.email) : null,
      vaultSecretName: String(row.vault_secret_name),
      createdAt: Number(row.created_at),
    }));
  }

  enqueueFeishuMessage(msg: QueuedFeishuMessage): void {
    this.db
      .prepare(
        `INSERT INTO feishu_message_queue (
          id, tenant_id, open_id, bot_id, message_id, text, status, reply_text, queued_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.tenantId,
        msg.openId,
        msg.botId,
        msg.messageId,
        msg.text,
        msg.status,
        msg.replyText,
        msg.queuedAt,
        msg.deliveredAt,
      );
  }

  listQueuedFeishuMessages(tenantId: string, onlyQueued = false): QueuedFeishuMessage[] {
    const rows = (
      onlyQueued
        ? this.db
            .prepare(
              "SELECT * FROM feishu_message_queue WHERE tenant_id = ? AND status = 'queued' ORDER BY queued_at ASC",
            )
            .all(tenantId)
        : this.db
            .prepare("SELECT * FROM feishu_message_queue WHERE tenant_id = ? ORDER BY queued_at ASC")
            .all(tenantId)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      openId: String(row.open_id),
      botId: String(row.bot_id),
      messageId: String(row.message_id),
      text: String(row.text),
      status: String(row.status) as QueuedFeishuMessage["status"],
      replyText: row.reply_text ? String(row.reply_text) : null,
      queuedAt: Number(row.queued_at),
      deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    }));
  }

  markFeishuMessageDelivered(id: string, replyText: string, deliveredAt: number): void {
    this.db
      .prepare("UPDATE feishu_message_queue SET status = 'delivered', reply_text = ?, delivered_at = ? WHERE id = ?")
      .run(replyText, deliveredAt, id);
  }

  insertKnowledge(entry: KnowledgeEntry): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_base (id, tenant_id, category, title, content, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.category,
        entry.title,
        entry.content,
        JSON.stringify(entry.tags),
        entry.createdAt,
      );
  }

  listKnowledge(tenantId: string): KnowledgeEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM knowledge_base WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      category: String(row.category) as StableKnowledgeCategory,
      title: String(row.title),
      content: String(row.content),
      tags: JSON.parse(String(row.tags_json)) as string[],
      createdAt: Number(row.created_at),
    }));
  }

  setOntologyTenantExtension(tenantId: string, domain: string, extensions: Record<string, unknown>, now: number): void {
    this.db
      .prepare(
        `INSERT INTO ontology_tenant_ext (tenant_id, domain, extensions_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, domain) DO UPDATE SET
           extensions_json = excluded.extensions_json,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, domain, JSON.stringify(extensions), now);
  }

  getOntologyTenantExtension(tenantId: string, domain: string): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT extensions_json FROM ontology_tenant_ext WHERE tenant_id = ? AND domain = ?")
      .get(tenantId, domain) as { extensions_json: string } | undefined;
    return row ? (JSON.parse(row.extensions_json) as Record<string, unknown>) : {};
  }

  insertOrder(order: TenantOrderRecord): void {
    this.db
      .prepare(
        `INSERT INTO tenant_orders (id, tenant_id, bot_id, sku, quantity, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(order.id, order.tenantId, order.botId, order.sku, order.quantity, order.amount, order.status, order.createdAt);
  }

  listOrders(tenantId: string): TenantOrderRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tenant_orders WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      sku: String(row.sku),
      quantity: Number(row.quantity),
      amount: Number(row.amount),
      status: String(row.status),
      createdAt: Number(row.created_at),
    }));
  }

  insertSnapshot(snapshot: VmSnapshotRecord): void {
    this.db
      .prepare(
        `INSERT INTO vm_snapshots (
          snapshot_id, tenant_id, vm_id, host_node_id, archive_path, sha256, size_bytes, backup_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.snapshotId,
        snapshot.tenantId,
        snapshot.vmId,
        snapshot.hostNodeId,
        snapshot.archivePath,
        snapshot.sha256,
        snapshot.sizeBytes,
        snapshot.backupMs,
        snapshot.createdAt,
      );
  }

  getSnapshot(snapshotId: string): VmSnapshotRecord | null {
    const row = this.db
      .prepare("SELECT * FROM vm_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      snapshotId: String(row.snapshot_id),
      tenantId: String(row.tenant_id),
      vmId: String(row.vm_id),
      hostNodeId: String(row.host_node_id),
      archivePath: String(row.archive_path),
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      backupMs: Number(row.backup_ms),
      createdAt: Number(row.created_at),
    };
  }

  recordMetering(entry: {
    tenantId: string;
    botId?: string | null;
    tokenSpend?: number;
    businessSpend?: number;
    vmUptimeMs?: number;
    storageBytes?: number;
    recordedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO metering_ledger (tenant_id, bot_id, token_spend, business_spend, vm_uptime_ms, storage_bytes, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tenantId,
        entry.botId ?? null,
        entry.tokenSpend ?? 0,
        entry.businessSpend ?? 0,
        entry.vmUptimeMs ?? 0,
        entry.storageBytes ?? 0,
        entry.recordedAt,
      );
  }

  getMeteringSummary(tenantId: string): TenantMeteringSummary {
    const rows = this.db
      .prepare("SELECT bot_id, token_spend, business_spend, vm_uptime_ms, storage_bytes FROM metering_ledger WHERE tenant_id = ?")
      .all(tenantId) as Array<Record<string, unknown>>;
    let tokenSpend = 0;
    let businessSpend = 0;
    let vmUptimeMs = 0;
    let storageBytes = 0;
    const perBotSpend: Record<string, { tokenSpend: number; businessSpend: number }> = {};
    for (const row of rows) {
      const t = Number(row.token_spend);
      const b = Number(row.business_spend);
      tokenSpend += t;
      businessSpend += b;
      vmUptimeMs += Number(row.vm_uptime_ms);
      storageBytes = Math.max(storageBytes, Number(row.storage_bytes));
      const botId = row.bot_id ? String(row.bot_id) : null;
      if (botId) {
        const cur = perBotSpend[botId] ?? { tokenSpend: 0, businessSpend: 0 };
        cur.tokenSpend += t;
        cur.businessSpend += b;
        perBotSpend[botId] = cur;
      }
    }
    return { tenantId, tokenSpend, businessSpend, vmUptimeMs, storageBytes, perBotSpend };
  }

  insertAlert(alert: MonitoringAlert): void {
    this.db
      .prepare(
        `INSERT INTO monitoring_alerts (id, tenant_id, vm_id, host_node_id, kind, severity, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id,
        alert.tenantId,
        alert.vmId,
        alert.hostNodeId,
        alert.kind,
        alert.severity,
        alert.message,
        alert.createdAt,
      );
  }

  listAlerts(tenantId?: string): MonitoringAlert[] {
    const rows = (
      tenantId
        ? this.db.prepare("SELECT * FROM monitoring_alerts WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId)
        : this.db.prepare("SELECT * FROM monitoring_alerts ORDER BY created_at DESC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: row.tenant_id ? String(row.tenant_id) : null,
      vmId: row.vm_id ? String(row.vm_id) : null,
      hostNodeId: String(row.host_node_id),
      kind: String(row.kind) as MonitoringAlert["kind"],
      severity: String(row.severity) as MonitoringAlert["severity"],
      message: String(row.message),
      createdAt: Number(row.created_at),
    }));
  }

  appendAudit(entry: IsolationAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO isolation_audit_log (id, tenant_id, vm_id, bot_id, action, outcome, reason, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.tenantId,
        entry.vmId,
        entry.botId,
        entry.action,
        entry.outcome,
        entry.reason,
        JSON.stringify(entry.details),
        entry.createdAt,
      );
  }

  listAudit(tenantId?: string): IsolationAuditEntry[] {
    const rows = (
      tenantId
        ? this.db
            .prepare("SELECT * FROM isolation_audit_log WHERE tenant_id = ? ORDER BY created_at ASC")
            .all(tenantId)
        : this.db.prepare("SELECT * FROM isolation_audit_log ORDER BY created_at ASC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      vmId: row.vm_id ? String(row.vm_id) : null,
      botId: row.bot_id ? String(row.bot_id) : null,
      action: String(row.action),
      outcome: String(row.outcome) as IsolationAuditEntry["outcome"],
      reason: String(row.reason),
      details: JSON.parse(String(row.details_json)) as Record<string, unknown>,
      createdAt: Number(row.created_at),
    }));
  }

  purgeTenantData(tenantId: string): { deletedKnowledgeRows: number; deletedOrderRows: number } {
    const kRes = this.db.prepare("DELETE FROM knowledge_base WHERE tenant_id = ?").run(tenantId);
    const oRes = this.db.prepare("DELETE FROM tenant_orders WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM ontology_tenant_ext WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM preinstalled_accounts WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM vm_bots WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM feishu_message_queue WHERE tenant_id = ?").run(tenantId);
    this.db.prepare("DELETE FROM tenant_vms WHERE tenant_id = ?").run(tenantId);
    return {
      deletedKnowledgeRows: Number(kRes.changes),
      deletedOrderRows: Number(oRes.changes),
    };
  }

  insertDeletionReceipt(receipt: TenantDeletionReceipt): void {
    this.db
      .prepare(
        `INSERT INTO tenant_deletion_receipts (
          receipt_id, tenant_id, export_id, export_sha256, deleted_vm_id, deleted_disk_path,
          deleted_vault_secrets, deleted_knowledge_rows, deleted_order_rows, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receiptId,
        receipt.tenantId,
        receipt.exportId,
        receipt.exportSha256,
        receipt.deletedVmId,
        receipt.deletedDiskPath,
        receipt.deletedVaultSecrets,
        receipt.deletedKnowledgeRows,
        receipt.deletedOrderRows,
        receipt.deletedAt,
      );
  }

  getDeletionReceipt(tenantId: string): TenantDeletionReceipt | null {
    const row = this.db
      .prepare("SELECT * FROM tenant_deletion_receipts WHERE tenant_id = ? ORDER BY deleted_at DESC LIMIT 1")
      .get(tenantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      receiptId: String(row.receipt_id),
      tenantId: String(row.tenant_id),
      exportId: String(row.export_id),
      exportSha256: String(row.export_sha256),
      deletedVmId: String(row.deleted_vm_id),
      deletedDiskPath: String(row.deleted_disk_path),
      deletedVaultSecrets: Number(row.deleted_vault_secrets),
      deletedKnowledgeRows: Number(row.deleted_knowledge_rows),
      deletedOrderRows: Number(row.deleted_order_rows),
      deletedAt: Number(row.deleted_at),
    };
  }
}
