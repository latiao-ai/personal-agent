import type { DualBudgetPolicy } from "./approvals.ts";

/** Resource quota assigned to one user's microVM (default: 2 vCPU / 4 GB RAM / 20 GB persistent disk). */
export interface VmQuota {
  vcpu: number;
  memoryGb: number;
  diskGb: number;
}

export type VmLifecycleState = "warm" | "running" | "hibernated" | "migrating" | "deleted";

export type VmDriverKind = "firecracker" | "isolated-local";

export interface TenantVmRecord {
  tenantId: string;
  vmId: string;
  hostNodeId: string;
  driver: VmDriverKind;
  openIds: string[];
  state: VmLifecycleState;
  quota: VmQuota;
  ipAddress: string;
  subnetCidr: string;
  diskPath: string;
  browserProfilePath: string;
  latestSnapshotId: string | null;
  bootLoadedFullMemory: false;
  restartCount: number;
  wakeLatencyMs: number | null;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  hibernatedAt: number | null;
}

export interface WarmPoolVmRecord {
  vmId: string;
  hostNodeId: string;
  driver: VmDriverKind;
  quota: VmQuota;
  ipAddress: string;
  subnetCidr: string;
  createdAt: number;
  claimedByTenantId: string | null;
}

export type SharedVmBotRole = "purchasing" | "patrol" | "followup" | "custom";

/** Per-bot permission profile inside a user's shared microVM. */
export interface VmBotProfile {
  tenantId: string;
  botId: string;
  role: SharedVmBotRole;
  toolAllowlist: string[];
  workDir: string;
  allowedConnectors: string[];
  mandateHash: string;
  budgetPolicy: DualBudgetPolicy;
  createdAt: number;
}

export interface PreinstalledAccount {
  id: string;
  tenantId: string;
  kind: "preinstalled_app" | "user_email";
  provider: string;
  accountLabel: string;
  email: string | null;
  vaultSecretName: string;
  createdAt: number;
}

export interface QueuedFeishuMessage {
  id: string;
  tenantId: string;
  openId: string;
  botId: string;
  messageId: string;
  text: string;
  status: "queued" | "delivered" | "failed";
  replyText: string | null;
  queuedAt: number;
  deliveredAt: number | null;
}

/** Stable cognitive / reference knowledge categories allowed in control-plane Knowledge Base. */
export type StableKnowledgeCategory =
  | "product_knowledge"
  | "sop"
  | "platform_rule"
  | "historical_case"
  | "agent_note";

/** Real-time operational data kinds that MUST NOT be stored in Knowledge Base. */
export type RealtimeDataKind = "inventory" | "order_status" | "realtime_price";

export interface KnowledgeEntry {
  id: string;
  tenantId: string;
  category: StableKnowledgeCategory;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
}

export interface OntologySlice {
  domain: string;
  tenantId: string;
  botId: string;
  sharedEntities: Array<{ name: string; fields: string[] }>;
  tenantExtensions: Record<string, unknown>;
}

export interface TicketTopKBundle {
  ticketId: string;
  tenantId: string;
  botId: string;
  topK: number;
  loadedFullCopy: false;
  memories: Array<{ id: string; layer: string; content: string; score: number }>;
  skills: Array<{ id: string; name: string; triggerPhrases: string[]; score: number }>;
  knowledge: Array<{ id: string; category: StableKnowledgeCategory; title: string; content: string; score: number }>;
  ontologySlice: OntologySlice;
  retrievedAt: number;
  ephemeralContextToken: string;
}

export interface RealtimeDataQueryResult {
  tenantId: string;
  kind: RealtimeDataKind;
  source: "database" | "erp" | "platform_api";
  key: string;
  payload: Record<string, unknown>;
  fromKnowledgeBase: false;
  queriedAt: number;
}

export interface NetworkAccessDecision {
  allowed: boolean;
  sourceTenantId: string;
  sourceVmId: string;
  targetAddress: string;
  targetPort: number;
  targetPath?: string;
  reason: string;
}

export interface VmSnapshotRecord {
  snapshotId: string;
  tenantId: string;
  vmId: string;
  hostNodeId: string;
  archivePath: string;
  sha256: string;
  sizeBytes: number;
  backupMs: number;
  createdAt: number;
}

export interface MonitoringAlert {
  id: string;
  tenantId: string | null;
  vmId: string | null;
  hostNodeId: string;
  kind: "vm_down" | "disk_full" | "cpu_overload" | "network_scan_blocked" | "cross_tenant_denied";
  severity: "warning" | "critical";
  message: string;
  createdAt: number;
}

export interface IsolationAuditEntry {
  id: string;
  tenantId: string;
  vmId: string | null;
  botId: string | null;
  action: string;
  outcome: "allowed" | "denied" | "recorded";
  reason: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface TenantExportBundle {
  exportId: string;
  tenantId: string;
  exportedAt: number;
  sha256: string;
  vm: TenantVmRecord | null;
  bots: VmBotProfile[];
  accounts: PreinstalledAccount[];
  knowledge: KnowledgeEntry[];
  orders: Array<{ id: string; sku: string; quantity: number; amount: number; status: string; createdAt: number }>;
  workspaceFiles: Record<string, string>;
  auditLogCount: number;
}

export interface TenantDeletionReceipt {
  receiptId: string;
  tenantId: string;
  exportId: string;
  exportSha256: string;
  deletedVmId: string;
  deletedDiskPath: string;
  deletedVaultSecrets: number;
  deletedKnowledgeRows: number;
  deletedOrderRows: number;
  deletedAt: number;
}

export interface TenantMeteringSummary {
  tenantId: string;
  tokenSpend: number;
  businessSpend: number;
  vmUptimeMs: number;
  storageBytes: number;
  perBotSpend: Record<string, { tokenSpend: number; businessSpend: number }>;
}

export interface HostDensityReport {
  hostNodeId: string;
  totalVms: number;
  runningVms: number;
  hibernatedVms: number;
  warmPoolVms: number;
  allocatedVcpu: number;
  allocatedMemoryGb: number;
  averageWakeLatencyMs: number | null;
}

export type PrivateDeploymentMode = "cloud_control_plane_worker" | "compiled_image";

export interface PrivateDeploymentSpec {
  mode: PrivateDeploymentMode;
  controlPlaneCallbackUrl: string;
  workerImageRef?: string;
  includesSourceCode: boolean;
  includesEnterpriseDir: boolean;
  enterpriseCommercialLicenseVerified: boolean;
  preservedNotices: string[];
}

export interface PrivateDeploymentValidationResult {
  ok: boolean;
  violations: string[];
  mode: PrivateDeploymentMode;
}
