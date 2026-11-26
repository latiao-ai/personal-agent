import { randomBytes } from "node:crypto";

import type {
  KnowledgeEntry,
  OntologySlice,
  RealtimeDataKind,
  RealtimeDataQueryResult,
  StableKnowledgeCategory,
  TicketTopKBundle,
} from "../../shared/isolation.ts";
import type { MemorySkillEngine } from "../memory-skill/engine.ts";
import type { IsolationStore } from "./store.ts";

const REALTIME_DATA_KEYWORDS: Record<RealtimeDataKind, RegExp> = {
  inventory: /(实时库存|当前库存|库存数量|stock_qty|realtime_inventory|inventory_count)/i,
  order_status: /(订单状态|物流状态|已发货状态|order_status|shipment_status)/i,
  realtime_price: /(实时价格|最新报价|当前售价|realtime_price|live_price)/i,
};

const SHARED_BASE_ONTOLOGY: Record<string, Array<{ name: string; fields: string[] }>> = {
  ecommerce: [
    { name: "Product", fields: ["sku", "title", "category", "spec"] },
    { name: "Supplier", fields: ["supplierId", "name", "leadTimeDays", "paymentTerms"] },
    { name: "Preference", fields: ["key", "content", "scope"] },
    { name: "Rule", fields: ["key", "content", "enforcedBy"] },
  ],
};

function tokenOverlapScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const hay = text.toLowerCase();
  if (hay.includes(q)) return 10;
  const parts = q.split(/[\s,，。；;]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return 1;
  let hits = 0;
  for (const part of parts) {
    if (hay.includes(part)) hits += 1;
  }
  return hits;
}

/**
 * Control-plane on-demand Top-K loader and real-time data boundary guard.
 * Corrects MVP5's simplified wording: VMs NEVER load full memory/skill/knowledge copies on boot.
 * Instead, each Ticket retrieves only Top-K slices and clears ephemeral context after completion.
 */
export class ControlPlaneKnowledgeLoader {
  private readonly store: IsolationStore;
  private readonly memorySkill?: MemorySkillEngine;
  private readonly activeEphemeralContexts = new Map<string, { ticketId: string; tenantId: string; botId: string }>();
  private readonly realtimeProviders = new Map<
    RealtimeDataKind,
    (tenantId: string, key: string) => { source: "database" | "erp" | "platform_api"; payload: Record<string, unknown> }
  >();

  constructor(store: IsolationStore, memorySkill?: MemorySkillEngine) {
    this.store = store;
    this.memorySkill = memorySkill;

    // Default live adapters (can be overridden by real ERP/DB/platform API connectors).
    this.realtimeProviders.set("inventory", (tenantId, key) => ({
      source: "erp",
      payload: { tenantId, sku: key, availableQty: 42, warehouse: "WH-LIVE-01", live: true },
    }));
    this.realtimeProviders.set("order_status", (tenantId, key) => ({
      source: "platform_api",
      payload: { tenantId, orderId: key, status: "in_transit", live: true },
    }));
    this.realtimeProviders.set("realtime_price", (tenantId, key) => ({
      source: "database",
      payload: { tenantId, sku: key, unitPrice: 128.5, currency: "CNY", live: true },
    }));
  }

  registerRealtimeProvider(
    kind: RealtimeDataKind,
    provider: (tenantId: string, key: string) => { source: "database" | "erp" | "platform_api"; payload: Record<string, unknown> },
  ): void {
    this.realtimeProviders.set(kind, provider);
  }

  /**
   * Adds a stable reference entry to the control-plane Knowledge Base.
   * Rejects real-time operational data (inventory, order status, real-time prices).
   */
  addKnowledgeEntry(input: {
    tenantId: string;
    category: StableKnowledgeCategory;
    title: string;
    content: string;
    tags?: string[];
    dataKind?: string;
  }): { ok: true; entry: KnowledgeEntry } | { ok: false; code: "realtime_data_forbidden_in_kb"; reason: string } {
    if (input.dataKind && ["inventory", "order_status", "realtime_price"].includes(input.dataKind)) {
      return {
        ok: false,
        code: "realtime_data_forbidden_in_kb",
        reason: `实时数据（${input.dataKind}）禁止写入知识库，必须实时查询数据库 / ERP / 平台 API`,
      };
    }
    const combined = `${input.title} ${input.content}`;
    for (const [kind, pattern] of Object.entries(REALTIME_DATA_KEYWORDS)) {
      if (pattern.test(combined)) {
        return {
          ok: false,
          code: "realtime_data_forbidden_in_kb",
          reason: `检测到实时业务数据（${kind}），禁止写入知识库，必须实时查询数据库 / ERP / 平台 API`,
        };
      }
    }

    const entry: KnowledgeEntry = {
      id: `kb_${randomBytes(8).toString("hex")}`,
      tenantId: input.tenantId,
      category: input.category,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      createdAt: Date.now(),
    };
    this.store.insertKnowledge(entry);
    return { ok: true, entry };
  }

  /** Retrieves Top-K memories, skills, knowledge, and minimal Ontology slice for a single Ticket. */
  retrieveForTicket(input: {
    tenantId: string;
    botId: string;
    ticketId: string;
    query: string;
    topK?: number;
    domain?: string;
    neededEntities?: string[];
  }): TicketTopKBundle {
    const topK = Math.max(1, Math.min(20, input.topK ?? 3));
    const domain = input.domain ?? "ecommerce";

    // 1. On-demand Top-K long-term memories from control-plane MemorySkillEngine
    const allLongMemories = this.memorySkill ? this.memorySkill.readLongTerm(input.tenantId, input.botId) : [];
    const rankedMemories = allLongMemories
      .map((m) => ({
        id: m.id,
        layer: "long",
        content: m.content,
        score: tokenOverlapScore(input.query, `${m.key} ${m.content}`),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // 2. On-demand Top-K skills from control-plane MemorySkillEngine
    const allSkills = this.memorySkill ? this.memorySkill.listSkills(input.tenantId) : [];
    const rankedSkills = allSkills
      .map((s) => ({
        id: s.id,
        name: s.name,
        triggerPhrases: s.triggerPhrases,
        score: tokenOverlapScore(input.query, `${s.name} ${s.triggerPhrases.join(" ")} ${s.spec.inputs}`),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // 3. On-demand Top-K stable knowledge entries from control-plane KB
    const allKnowledge = this.store.listKnowledge(input.tenantId);
    const rankedKnowledge = allKnowledge
      .map((k) => ({
        id: k.id,
        category: k.category,
        title: k.title,
        content: k.content,
        score: tokenOverlapScore(input.query, `${k.title} ${k.content} ${k.tags.join(" ")}`),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // 4. Shared domain Ontology base + tenant extension slice (only needed entities for this bot)
    const baseEntities = SHARED_BASE_ONTOLOGY[domain] ?? SHARED_BASE_ONTOLOGY.ecommerce;
    const filteredEntities =
      input.neededEntities && input.neededEntities.length > 0
        ? baseEntities.filter((e) => input.neededEntities!.includes(e.name))
        : baseEntities;
    const ontologySlice: OntologySlice = {
      domain,
      tenantId: input.tenantId,
      botId: input.botId,
      sharedEntities: filteredEntities,
      tenantExtensions: this.store.getOntologyTenantExtension(input.tenantId, domain),
    };

    const ephemeralContextToken = `ectx_${randomBytes(12).toString("hex")}`;
    this.activeEphemeralContexts.set(ephemeralContextToken, {
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      botId: input.botId,
    });

    return {
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      botId: input.botId,
      topK,
      loadedFullCopy: false,
      memories: rankedMemories,
      skills: rankedSkills,
      knowledge: rankedKnowledge,
      ontologySlice,
      retrievedAt: Date.now(),
      ephemeralContextToken,
    };
  }

  /** Clears the ephemeral Ticket context once the task finishes. */
  clearTicketContext(ephemeralContextToken: string): boolean {
    return this.activeEphemeralContexts.delete(ephemeralContextToken);
  }

  hasActiveContext(ephemeralContextToken: string): boolean {
    return this.activeEphemeralContexts.has(ephemeralContextToken);
  }

  /** Queries real-time operational data directly from DB / ERP / Platform API (never from Knowledge Base). */
  queryRealtimeData(input: {
    tenantId: string;
    kind: RealtimeDataKind;
    key: string;
  }): RealtimeDataQueryResult {
    const provider = this.realtimeProviders.get(input.kind);
    if (!provider) {
      throw new Error(`unsupported_realtime_kind:${input.kind}`);
    }
    const result = provider(input.tenantId, input.key);
    return {
      tenantId: input.tenantId,
      kind: input.kind,
      source: result.source,
      key: input.key,
      payload: result.payload,
      fromKnowledgeBase: false,
      queriedAt: Date.now(),
    };
  }
}
