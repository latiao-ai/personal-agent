import type {
  CanonicalHotProductSignal,
  CanonicalInventoryItem,
  CanonicalLogisticsSignal,
  CanonicalOrderItem,
  CanonicalOrderSkuLine,
  CanonicalOrderStatus,
  CanonicalPriceSignal,
  CanonicalSupplierReplySignal,
  PatrolDataCategory,
} from "../../shared/patrol.ts";

/**
 * Control-plane field mapping tables (minimal Ontology starter for MVP4).
 * Lives strictly in control plane, never inside a user VM.
 */
export const INVENTORY_QTY_FIELD_MAP: Readonly<Record<string, string>> = {
  taobao: "stock",
  shopify: "inventory_quantity",
  jd: "stockNum",
  erp: "on_hand_qty",
  canonical: "available_quantity",
};

export const ORDER_STATUS_MAP: Readonly<Record<string, CanonicalOrderStatus>> = {
  // Canonical
  pending_payment: "pending_payment",
  paid_unshipped: "paid_unshipped",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
  refunded: "refunded",
  // Taobao / Tmall
  WAIT_BUYER_PAY: "pending_payment",
  WAIT_SELLER_SEND_GOODS: "paid_unshipped",
  WAIT_BUYER_CONFIRM_GOODS: "shipped",
  TRADE_FINISHED: "delivered",
  TRADE_CLOSED: "cancelled",
  TRADE_CLOSED_BY_TAOBAO: "cancelled",
  // Shopify
  unfulfilled: "paid_unshipped",
  fulfilled: "shipped",
  // JD / ERP
  PAID_WAIT_SHIP: "paid_unshipped",
  SHIPPED: "shipped",
  COMPLETED: "delivered",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
};

export interface RawPlatformRecord {
  platform?: string;
  [key: string]: unknown;
}

export interface PatrolAdapter<T> {
  readonly category: PatrolDataCategory;
  readonly implemented: boolean;
  read(sinceCheckedAt?: string | null): Promise<T[]>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalizes platform-specific inventory payload into canonical Ontology fields. */
export function normalizeInventoryRecord(
  raw: RawPlatformRecord,
  fallbackCheckedAt: string,
): CanonicalInventoryItem {
  const platform = asString(raw.platform, "canonical").toLowerCase();
  const mappedQtyKey = INVENTORY_QTY_FIELD_MAP[platform] ?? "available_quantity";
  const rawQty =
    raw[mappedQtyKey] ??
    raw.available_quantity ??
    raw.stock ??
    raw.inventory_quantity ??
    raw.stockNum ??
    raw.on_hand_qty ??
    0;

  const safetyStockRaw = raw.safety_stock ?? raw.safetyStock ?? raw.min_stock;
  const safetyStock =
    safetyStockRaw !== undefined && safetyStockRaw !== null
      ? asNumber(safetyStockRaw, 0)
      : undefined;

  const rawNote = asString(raw.raw_note ?? raw.note ?? raw.remark);

  return {
    sku: asString(raw.sku ?? raw.sku_id ?? raw.item_sku, "UNKNOWN_SKU"),
    available_quantity: Math.max(0, Math.floor(asNumber(rawQty, 0))),
    warehouse: asString(raw.warehouse ?? raw.warehouse_id ?? raw.location, "default"),
    checked_at: asString(raw.checked_at ?? raw.updated_at, fallbackCheckedAt),
    ...(safetyStock !== undefined ? { safety_stock: Math.max(0, Math.floor(safetyStock)) } : {}),
    source_platform: platform,
    ...(rawNote ? { raw_note: rawNote } : {}),
  };
}

/** Maps platform order status string to canonical Ontology order status without LLM guessing. */
export function normalizeOrderStatus(rawStatus: unknown): CanonicalOrderStatus {
  const key = asString(rawStatus, "paid_unshipped");
  return ORDER_STATUS_MAP[key] ?? ORDER_STATUS_MAP[key.toUpperCase()] ?? "paid_unshipped";
}

function normalizeSkuList(rawList: unknown): CanonicalOrderSkuLine[] {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((entry) => {
      if (typeof entry === "string") {
        return { sku: entry.trim(), quantity: 1 };
      }
      if (typeof entry === "object" && entry !== null) {
        const rec = entry as Record<string, unknown>;
        const sku = asString(rec.sku ?? rec.sku_id, "");
        if (!sku) return null;
        return { sku, quantity: Math.max(1, Math.floor(asNumber(rec.quantity ?? rec.qty, 1))) };
      }
      return null;
    })
    .filter((item): item is CanonicalOrderSkuLine => item !== null && item.sku.length > 0);
}

/** Normalizes platform-specific order payload into canonical Ontology fields. */
export function normalizeOrderRecord(
  raw: RawPlatformRecord,
  fallbackCheckedAt: string,
): CanonicalOrderItem {
  const platform = asString(raw.platform, "canonical").toLowerCase();
  const rawNote = asString(raw.raw_note ?? raw.buyer_note ?? raw.remark);
  return {
    order_id: asString(raw.order_id ?? raw.orderId ?? raw.tid, "UNKNOWN_ORDER"),
    status: normalizeOrderStatus(raw.status ?? raw.order_status ?? raw.fulfillment_status),
    paid_at: asString(raw.paid_at ?? raw.paidAt ?? raw.pay_time, fallbackCheckedAt),
    amount: Math.max(0, asNumber(raw.amount ?? raw.total_amount ?? raw.payment, 0)),
    currency: asString(raw.currency, "CNY"),
    sku_list: normalizeSkuList(raw.sku_list ?? raw.items ?? raw.line_items),
    checked_at: asString(raw.checked_at ?? raw.updated_at, fallbackCheckedAt),
    source_platform: platform,
    ...(rawNote ? { raw_note: rawNote } : {}),
  };
}

/** Working adapter for inventory (MVP4 v1). */
export class InventoryPatrolAdapter implements PatrolAdapter<CanonicalInventoryItem> {
  readonly category = "inventory" as const;
  readonly implemented = true;
  private readonly loadRaw: () => Promise<RawPlatformRecord[]> | RawPlatformRecord[];
  private readonly now: () => number;

  constructor(
    loadRaw: () => Promise<RawPlatformRecord[]> | RawPlatformRecord[],
    now: () => number = Date.now,
  ) {
    this.loadRaw = loadRaw;
    this.now = now;
  }

  async read(sinceCheckedAt?: string | null): Promise<CanonicalInventoryItem[]> {
    const fallbackAt = new Date(this.now()).toISOString();
    const rawItems = await this.loadRaw();
    const canonical = rawItems.map((item) => normalizeInventoryRecord(item, fallbackAt));
    if (!sinceCheckedAt) return canonical;
    const watermarkMs = Date.parse(sinceCheckedAt);
    if (!Number.isFinite(watermarkMs)) return canonical;
    return canonical.filter((item) => {
      const itemMs = Date.parse(item.checked_at);
      return !Number.isFinite(itemMs) || itemMs > watermarkMs;
    });
  }
}

/** Working adapter for new orders (MVP4 v1). */
export class OrdersPatrolAdapter implements PatrolAdapter<CanonicalOrderItem> {
  readonly category = "orders" as const;
  readonly implemented = true;
  private readonly loadRaw: () => Promise<RawPlatformRecord[]> | RawPlatformRecord[];
  private readonly now: () => number;

  constructor(
    loadRaw: () => Promise<RawPlatformRecord[]> | RawPlatformRecord[],
    now: () => number = Date.now,
  ) {
    this.loadRaw = loadRaw;
    this.now = now;
  }

  async read(sinceCheckedAt?: string | null): Promise<CanonicalOrderItem[]> {
    const fallbackAt = new Date(this.now()).toISOString();
    const rawItems = await this.loadRaw();
    const canonical = rawItems.map((item) => normalizeOrderRecord(item, fallbackAt));
    if (!sinceCheckedAt) return canonical;
    const watermarkMs = Date.parse(sinceCheckedAt);
    if (!Number.isFinite(watermarkMs)) return canonical;
    return canonical.filter((item) => {
      // Always keep unpaid/unshipped orders in scope so >24h overdue SLA violations are never missed.
      if (item.status === "paid_unshipped") return true;
      const itemMs = Date.parse(item.checked_at ?? item.paid_at);
      return !Number.isFinite(itemMs) || itemMs > watermarkMs;
    });
  }
}

/** Stub adapters for the 4 deferred categories: interface definitions + empty implementations only. */
export class StubPricePatrolAdapter implements PatrolAdapter<CanonicalPriceSignal> {
  readonly category = "price" as const;
  readonly implemented = false;
  async read(): Promise<CanonicalPriceSignal[]> {
    return [];
  }
}

export class StubLogisticsPatrolAdapter implements PatrolAdapter<CanonicalLogisticsSignal> {
  readonly category = "logistics" as const;
  readonly implemented = false;
  async read(): Promise<CanonicalLogisticsSignal[]> {
    return [];
  }
}

export class StubSupplierReplyPatrolAdapter implements PatrolAdapter<CanonicalSupplierReplySignal> {
  readonly category = "supplier_reply" as const;
  readonly implemented = false;
  async read(): Promise<CanonicalSupplierReplySignal[]> {
    return [];
  }
}

export class StubHotProductPatrolAdapter implements PatrolAdapter<CanonicalHotProductSignal> {
  readonly category = "hot_product" as const;
  readonly implemented = false;
  async read(): Promise<CanonicalHotProductSignal[]> {
    return [];
  }
}

export interface PatrolAdapterRegistry {
  inventory: PatrolAdapter<CanonicalInventoryItem>;
  orders: PatrolAdapter<CanonicalOrderItem>;
  price: PatrolAdapter<CanonicalPriceSignal>;
  logistics: PatrolAdapter<CanonicalLogisticsSignal>;
  supplier_reply: PatrolAdapter<CanonicalSupplierReplySignal>;
  hot_product: PatrolAdapter<CanonicalHotProductSignal>;
}

export function createDefaultStubAdapters(): Pick<
  PatrolAdapterRegistry,
  "price" | "logistics" | "supplier_reply" | "hot_product"
> {
  return {
    price: new StubPricePatrolAdapter(),
    logistics: new StubLogisticsPatrolAdapter(),
    supplier_reply: new StubSupplierReplyPatrolAdapter(),
    hot_product: new StubHotProductPatrolAdapter(),
  };
}
