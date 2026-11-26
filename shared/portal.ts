/** Public control-plane contracts for Customer Web Portal and Admin Console (add-customer-portal). */

import type { ApprovalCard, ApprovalChannel, DualBudgetPolicy } from "./approvals.ts";
import type { SharedVmBotRole, TenantDeletionReceipt, TenantExportBundle, TenantVmRecord } from "./isolation.ts";
import type { LongTermMemoryRecord, ManagedSkill } from "./memory-skill.ts";
import type { Ticket } from "./tickets.ts";

/** Role inside a customer tenant: admin can modify budgets/approvers; member can only view & approve assigned cards. */
export type PortalRole = "admin" | "member";

export interface TenantMember {
  tenantId: string;
  openId: string;
  displayName: string;
  role: PortalRole;
  createdAt: number;
}

export type QrChallengeStatus = "pending" | "confirmed" | "expired" | "consumed";

export interface QrLoginChallenge {
  qrToken: string;
  qrUrl: string;
  status: QrChallengeStatus;
  expiresAt: number;
  createdAt: number;
}

export interface CustomerSession {
  sessionId: string;
  tenantId: string;
  openId: string;
  displayName: string;
  role: PortalRole;
  createdAt: number;
  expiresAt: number;
}

export interface AdminAccount {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface AdminSession {
  sessionId: string;
  adminId: string;
  username: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
}

export interface PortalBotSummary {
  tenantId: string;
  botId: string;
  role: SharedVmBotRole;
  enabled: boolean;
  toolAllowlist: string[];
  allowedConnectors: string[];
  activeTicketCount: number;
  updatedAt: number;
}

export interface PortalApprovalView extends ApprovalCard {
  statusBanner: string | null;
  canAct: boolean;
}

export interface PortalSpendOverview {
  tenantId: string;
  currency: string;
  policy: DualBudgetPolicy;
  tokenSpend: {
    day: number;
    month: number;
    patrolTokens: number;
    patrolCostUsd: number;
  };
  businessSpend: {
    day: number;
    month: number;
  };
}

export interface TenantScheduleConfig {
  tenantId: string;
  patrolFrequencyPerDay: number;
  dailyDigestTime: string;
  patrolEnabled: boolean;
  digestEnabled: boolean;
  updatedAt: number;
  updatedBy: string;
  effectiveNote: string;
}

export interface MemoryChangeSuggestion {
  id: string;
  tenantId: string;
  memoryId: string;
  suggestedContent: string;
  reason: string;
  submittedBy: string;
  status: "pending" | "reviewed";
  createdAt: number;
}

export interface PortalSkillView extends ManagedSkill {
  editableByCustomer: boolean;
  coreLocked: boolean;
}

export interface PortalMemorySkillView {
  tenantId: string;
  memories: LongTermMemoryRecord[];
  skills: PortalSkillView[];
  suggestions: MemoryChangeSuggestion[];
}

export interface TenantPortalSettings {
  tenantId: string;
  approverOpenIds: string[];
  budgetPolicy: DualBudgetPolicy;
  members: TenantMember[];
  updatedAt: number;
}

export interface PortalAuditEntry {
  id: string;
  tenantId: string;
  actorId: string;
  actorRole: PortalRole | "ops_admin" | "system";
  channel: ApprovalChannel | "admin" | "system";
  action: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
  at: number;
}

export interface CustomerSelfExport {
  exportId: string;
  tenantId: string;
  exportedAt: number;
  exportedBy: string;
  bots: PortalBotSummary[];
  tickets: Ticket[];
  approvals: PortalApprovalView[];
  spend: PortalSpendOverview;
  schedule: TenantScheduleConfig;
  memories: LongTermMemoryRecord[];
  skills: PortalSkillView[];
  audit: PortalAuditEntry[];
}

export interface AdminTenantOverview {
  tenantId: string;
  vm: TenantVmRecord | null;
  botCount: number;
  memberCount: number;
  pendingApprovalCount: number;
  tokenSpendMonth: number;
  businessSpendMonth: number;
  currency: string;
  vaultConnections: Array<{ name: string; status: "connected" }>;
  auditCount: number;
}

export interface CoreSkillHashChangeRequest {
  id: string;
  tenantId: string;
  skillId: string;
  skillName: string;
  requestedBy: string;
  approvedBy: string | null;
  status: "pending" | "applied" | "rejected";
  patch: {
    name?: string;
    description?: string;
    triggerPhrases?: string[];
    spec?: Partial<ManagedSkill["spec"]>;
  };
  previousHash: string;
  newHash: string | null;
  reason: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface AdminOffboardResult {
  tenantId: string;
  exportBundle: TenantExportBundle;
  deletionReceipt: TenantDeletionReceipt;
}
