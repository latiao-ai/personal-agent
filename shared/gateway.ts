/** Public control-plane contracts for multi-platform resident messaging gateway (add-unified-login). */

import type { ChannelChatType, ChannelPlatform } from "./portal.ts";

export type GatewayPlatformName = ChannelPlatform | "wecom";

export interface NormalizedInboundMessage {
  platform: ChannelPlatform;
  eventId: string;
  messageId: string;
  appId: string;
  chatId: string;
  chatType: ChannelChatType;
  senderId: string;
  text: string;
  mentionedBot: boolean;
  rawTimestampMs?: number;
}

export type GatewayAdapterState = "online" | "reconnecting" | "offline" | "placeholder";

export interface GatewayAdapterStatus {
  platform: GatewayPlatformName;
  state: GatewayAdapterState;
  activeBindings: number;
  lastEventAt: number | null;
  lastError: string | null;
  note?: string;
}

export interface GatewayHealthSnapshot {
  running: boolean;
  pid: number;
  startedAt: number | null;
  uniqueConsumerLock: string | null;
  adapters: GatewayAdapterStatus[];
  routedCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

export interface GatewayLogEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  platform: GatewayPlatformName;
  eventType: string;
  tenantId?: string;
  botId?: string;
  chatId?: string;
  message: string;
}

export interface WeixinIlinkQrSession {
  sessionId: string;
  qrUrl: string;
  status: "pending" | "confirmed" | "expired";
  ilinkAccountId: string | null;
  createdAt: number;
  expiresAt: number;
  groupSupportNote: string;
}
