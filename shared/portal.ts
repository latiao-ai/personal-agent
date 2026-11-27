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
  userId?: string;
  username?: string;
  createdAt: number;
  expiresAt: number;
}

export type UnifiedAccountRole = "customer" | "ops_admin";

export interface PortalUserAccount {
  id: string;
  username: string;
  displayName: string;
  role: UnifiedAccountRole;
  tenantId: string | null;
  tenantRole: PortalRole;
  legacyLocalAccount: boolean;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
}

export type UnifiedLoginResult =
  | {
      kind: "customer";
      redirectTo: "/portal";
      token: string;
      session: CustomerSession;
    }
  | {
      kind: "admin";
      redirectTo: "/admin";
      token: string;
      session: AdminSession;
    };

export type ChannelPlatform = "feishu" | "weixin";
export type ChannelChatType = "p2p" | "group";
export type ChannelBindingStatus = "active" | "disabled";

export interface ChannelBinding {
  id: string;
  botId: string;
  tenantId: string;
  platform: ChannelPlatform;
  platformAppId: string;
  chatId: string;
  chatType: ChannelChatType;
  status: ChannelBindingStatus;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserIdentity {
  id: string;
  userId: string;
  tenantId: string;
  feishuOpenId: string;
  createdAt: number;
}

export interface WeixinIdentity {
  id: string;
  userId: string;
  tenantId: string;
  weixinOpenId: string;
  ilinkAccountId: string;
  createdAt: number;
}

export interface TenantChannelAllowlist {
  tenantId: string;
  platform: ChannelPlatform;
  allowedSenderIds: string[];
  updatedAt: number;
  updatedBy: string;
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
