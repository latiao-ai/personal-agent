import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  PATROL_READ_ONLY_TOOL_ALLOWLIST,
  type CanonicalInventoryItem,
  type CanonicalOrderItem,
  type PatrolDailyDigest,
  type PatrolFinding,
  type PatrolRunRecord,
  type PatrolSeverity,
  type PatrolSpendSummary,
  type PatrolTokenUsage,
  type PatrolToolDenialRecord,
  type PatrolTriggerKind,
} from "../../shared/patrol.ts";
import type { Ticket } from "../../shared/tickets.ts";
import { utcDayKey, utcMonthKey } from "../approvals/budget.ts";
import type { ApprovalEngine } from "../approvals/engine.ts";
import { DATA_DIR } from "../config.ts";
import { createRunGate } from "../routine-run-gate.ts";
import type { TicketEngine } from "../tickets/engine.ts";
import {
  createDefaultStubAdapters,
  InventoryPatrolAdapter,
  OrdersPatrolAdapter,
  type PatrolAdapterRegistry,
  type RawPlatformRecord,
} from "./adapters.ts";
import { getPatrolFixtures } from "./fixtures.ts";
import { PatrolPermissionGuard } from "./permission-guard.ts";
import { PatrolStore } from "./store.ts";

const DEFAULT_TENANT_ID = "default";
const DEFAULT_SAFETY_STOCK = 50;
const NEAR_SAFETY_MULTIPLIER = 1.5;
const OVERDUE_UNSHIPPED_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 30_000;
const SMALL_MODEL_USD_PER_1K_TOKENS = 0.0002;
const LARGE_MODEL_USD_PER_1K_TOKENS = 0.003;

const PROMPT_INJECTION_SEND_PATTERN = /(发消息|发给客户|通知客户|通知供应商|send\s+message|notify)/i;
const PROMPT_INJECTION_PAY_PATTERN = /(下单|付款|支付|转账|place\s+order|pay)/i;

export interface PatrolModelAttemptedToolCall {
  toolName: string;
  args?: Record<string, unknown>;
}

export interface PatrolModelScannerResult {
  summary: string;
  tokensUsed: number;
  attemptedToolCalls?: PatrolModelAttemptedToolCall[];
}

export type PatrolModelScanner = (input: {
  tier: "small" | "large";
  inventory: CanonicalInventoryItem[];
  orders: CanonicalOrderItem[];
  preliminaryFindings: Array<{ severity: "minor" | "major"; summary: string }>;
  signal: AbortSignal;
}) => Promise<PatrolModelScannerResult> | PatrolModelScannerResult;

export interface PatrolEngineOptions {
  dbPath?: string;
  tickets: TicketEngine;
  approvals: ApprovalEngine;
  adapters?: Partial<PatrolAdapterRegistry>;
  now?: () => number;
  timeoutMs?: number;
  defaultSafetyStock?: number;
  defaultApprover?: string;
  smallModelScanner?: PatrolModelScanner;
  largeModelReviewer?: PatrolModelScanner;
}

export interface PatrolRunInput {
  tenantId?: string;
  trigger?: PatrolTriggerKind;
  /** Optional inline raw records for isolated fixture runs (still normalized via control-plane adapters). */
  rawInventory?: RawPlatformRecord[];
  rawOrders?: RawPlatformRecord[];
  /** Optional named built-in fixture ("normal" | "low_stock" | "prompt_injection"). */
  fixtureName?: string;
  /** Optional override for single-run timeout in ms. */
  timeoutMs?: number;
  /** Optional approver open_id attached to escalated execution tickets. */
  approver?: string;
  /** When false, ignores incremental watermark/cache and scans the full provided dataset. */
  incremental?: boolean;
  /** Optional explicit tool calls to simulate model behavior (e.g. prompt-injection test). */
  simulatedModelToolCalls?: PatrolModelAttemptedToolCall[];
}

class PatrolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`巡检超过单次运行时限 (${timeoutMs}ms)`);
    this.name = "PatrolTimeoutError";
  }
}

function defaultSmallModelScanner(input: {
  inventory: CanonicalInventoryItem[];
  orders: CanonicalOrderItem[];
}): PatrolModelScannerResult {
  const attemptedToolCalls: PatrolModelAttemptedToolCall[] = [];
  for (const item of input.inventory) {
    if (item.raw_note && PROMPT_INJECTION_SEND_PATTERN.test(item.raw_note)) {
      attemptedToolCalls.push({
        toolName: "send_message",
        args: { source: "inventory_note", sku: item.sku, text: item.raw_note },
      });
    }
    if (item.raw_note && PROMPT_INJECTION_PAY_PATTERN.test(item.raw_note)) {
      attemptedToolCalls.push({
        toolName: "make_payment",
        args: { source: "inventory_note", sku: item.sku, note: item.raw_note },
      });
    }
  }
  for (const order of input.orders) {
    if (order.raw_note && PROMPT_INJECTION_SEND_PATTERN.test(order.raw_note)) {
      attemptedToolCalls.push({
        toolName: "send_message",
        args: { source: "order_note", order_id: order.order_id, text: order.raw_note },
      });
    }
  }
  const tokensUsed = 120 + input.inventory.length * 18 + input.orders.length * 22;
  return {
    summary: `小模型巡检完成：库存 ${input.inventory.length} 条、订单 ${input.orders.length} 条`,
    tokensUsed,
    attemptedToolCalls,
  };
}

function defaultLargeModelReviewer(input: {
  preliminaryFindings: Array<{ severity: "minor" | "major"; summary: string }>;
}): PatrolModelScannerResult {
  const tokensUsed = 350 + input.preliminaryFindings.length * 60;
  return {
    summary: `大模型复核确认 ${input.preliminaryFindings.length} 条异常`,
    tokensUsed,
  };
}

function computeSnapshotHash(inventory: CanonicalInventoryItem[], orders: CanonicalOrderItem[]): string {
  // Hash business state only (exclude volatile polling checked_at) so unchanged re-polls hit cache.
  const stableInventory = inventory.map(({ checked_at: _checkedAt, ...rest }) => rest);
  const stableOrders = orders.map(({ checked_at: _checkedAt, ...rest }) => rest);
  return createHash("sha256")
    .update(JSON.stringify({ inventory: stableInventory, orders: stableOrders }))
    .digest("hex");
}

function withAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new PatrolTimeoutError(timeoutMs));
      reject(new PatrolTimeoutError(timeoutMs));
    }, timeoutMs);
    work(controller.signal)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Control-plane read-only patrol engine (MVP4).
 * Reuses routine-run-gate semantics for overlap prevention, TicketEngine for read-only patrol
 * tickets & major escalations, and ApprovalEngine for 4-tier approval on escalated tickets.
 */
export class PatrolEngine {
  readonly store: PatrolStore;
  private readonly tickets: TicketEngine;
  private readonly approvals: ApprovalEngine;
  private readonly adapters: PatrolAdapterRegistry;
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultSafetyStock: number;
  private readonly defaultApprover: string;
  private readonly smallModelScanner: PatrolModelScanner;
  private readonly largeModelReviewer: PatrolModelScanner;
  private readonly runGate = createRunGate<{ id: string }>(undefined, () => {});
  private readonly activeRunByTenant = new Map<string, string>();

  constructor(options: PatrolEngineOptions) {
    this.now = options.now ?? Date.now;
    this.store = new PatrolStore(options.dbPath ?? join(DATA_DIR, "patrol.sqlite"));
    this.tickets = options.tickets;
    this.approvals = options.approvals;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultSafetyStock = options.defaultSafetyStock ?? DEFAULT_SAFETY_STOCK;
    this.defaultApprover = options.defaultApprover ?? "ou_owner_default";
    this.smallModelScanner = options.smallModelScanner ?? defaultSmallModelScanner;
    this.largeModelReviewer = options.largeModelReviewer ?? defaultLargeModelReviewer;

    const defaults = getPatrolFixtures(this.now()).normal;
    const stubs = createDefaultStubAdapters();
    this.adapters = {
      inventory: options.adapters?.inventory ?? new InventoryPatrolAdapter(() => defaults.inventory, this.now),
      orders: options.adapters?.orders ?? new OrdersPatrolAdapter(() => defaults.orders, this.now),
      price: options.adapters?.price ?? stubs.price,
      logistics: options.adapters?.logistics ?? stubs.logistics,
      supplier_reply: options.adapters?.supplier_reply ?? stubs.supplier_reply,
      hot_product: options.adapters?.hot_product ?? stubs.hot_product,
    };
  }

  /** Runs one read-only patrol cycle (manual, scheduled, or event-triggered). */
  async runPatrol(input: PatrolRunInput = {}): Promise<PatrolRunRecord> {
    const tenantId = input.tenantId?.trim() || DEFAULT_TENANT_ID;
    const trigger: PatrolTriggerKind = input.trigger ?? "manual";
    const startedAt = this.now();
    const runId = `patrol_${randomUUID()}`;
    const timeoutMs = Math.max(10, input.timeoutMs ?? this.defaultTimeoutMs);
    const emptyUsage: PatrolTokenUsage = {
      smallModelCalls: 0,
      largeModelCalls: 0,
      smallModelTokens: 0,
      largeModelTokens: 0,
      patrolTokenCostUsd: 0,
      cacheHit: false,
      incrementalSkipped: 0,
    };

    // Overlap guard: if a previous patrol for this tenant is still running, skip immediately and record it.
    if (this.activeRunByTenant.has(tenantId)) {
      const existingRunId = this.activeRunByTenant.get(tenantId)!;
      const skipped: PatrolRunRecord = {
        id: runId,
        tenantId,
        trigger,
        status: "skipped_overlap",
        severity: "ok",
        startedAt,
        finishedAt: this.now(),
        durationMs: Math.max(0, this.now() - startedAt),
        patrolTicketId: null,
        patrolMandateAllowlist: [],
        summary: `上一次巡检 (${existingRunId}) 尚未完成，已跳过本次触发`,
        findings: [],
        escalatedTickets: [],
        deniedToolCalls: [],
        digestUpdated: false,
        digestDayKey: null,
        tokenUsage: emptyUsage,
        reason: `overlap_with:${existingRunId}`,
      };
      this.store.saveRun(skipped);
      return skipped;
    }

    this.activeRunByTenant.set(tenantId, runId);
    this.runGate.hold({ id: runId });

    let patrolTicketId: string | null = null;
    let patrolAllowlist: string[] = [];

    try {
      const result = await withAbortTimeout(async (signal) => {
        // Step 1: Issue read-only patrol Ticket via MVP2a TicketEngine with strict read-only Mandate allowlist.
        const patrolIntake = this.tickets.intake({
          source: "patrol",
          initiator: `patrol:${trigger}`,
          text: `只读巡检 (${trigger})：仅读取规范字段并分档汇报，禁止写数据、发消息、付款、控浏览器`,
          eventId: runId,
          scope: "patrol:readonly",
          toolAllowlist: [...PATROL_READ_ONLY_TOOL_ALLOWLIST],
          budget: { tokenLimit: 1, businessLimit: 0, currency: "CNY" },
        });
        if (patrolIntake.outcome !== "created" && patrolIntake.outcome !== "duplicate") {
          throw new Error(`无法创建只读巡检 Ticket: ${patrolIntake.outcome}`);
        }
        const patrolTicket = patrolIntake.ticket;
        patrolTicketId = patrolTicket.id;
        patrolAllowlist = [...patrolTicket.mandate.toolAllowlist];

        if (!PatrolPermissionGuard.isStrictlyReadOnlyAllowlist(patrolAllowlist)) {
          throw new Error("巡检 Mandate 白名单校验失败：包含非只读工具");
        }

        const guard = new PatrolPermissionGuard({
          runId,
          patrolTicketId: patrolTicket.id,
          mandate: patrolTicket.mandate,
          now: this.now,
          onDenial: (denial) => this.store.saveToolDenial(denial),
        });

        // Step 2: Resolve adapters (inline fixture override or registered adapters).
        const { inventoryAdapter, ordersAdapter } = this.resolveAdapters(input);
        const incremental = input.incremental !== false;
        const watermark = incremental ? this.store.getWatermark(tenantId) : null;
        const sinceCheckedAt = watermark?.lastCheckedAt ?? null;

        // Every read goes through tool-layer permission guard.
        const invAuth = guard.authorize("patrol_read_inventory", { sinceCheckedAt });
        const ordAuth = guard.authorize("patrol_read_orders", { sinceCheckedAt });
        guard.authorize("patrol_read_price", {});
        guard.authorize("patrol_read_logistics", {});
        guard.authorize("patrol_read_supplier_reply", {});
        guard.authorize("patrol_read_hot_product", {});

        if (!invAuth.allowed || !ordAuth.allowed) {
          throw new Error("只读巡检读接口授权失败");
        }

        const [inventory, orders] = await Promise.all([
          inventoryAdapter.read(sinceCheckedAt),
          ordersAdapter.read(sinceCheckedAt),
          this.adapters.price.read(sinceCheckedAt),
          this.adapters.logistics.read(sinceCheckedAt),
          this.adapters.supplier_reply.read(sinceCheckedAt),
          this.adapters.hot_product.read(sinceCheckedAt),
        ]);

        if (signal.aborted) {
          throw new PatrolTimeoutError(timeoutMs);
        }

        // Step 3: Check incremental no-change or snapshot cache & summary reuse.
        const snapshotHash = computeSnapshotHash(inventory, orders);
        const hasSimulatedCalls = Boolean(input.simulatedModelToolCalls?.length);
        const noIncrementalDelta =
          incremental &&
          sinceCheckedAt !== null &&
          inventory.length === 0 &&
          orders.length === 0 &&
          watermark?.lastSummary !== null;
        const cacheHit =
          incremental &&
          !hasSimulatedCalls &&
          watermark?.lastSummary !== null &&
          (noIncrementalDelta || watermark?.lastSnapshotHash === snapshotHash);

        if (cacheHit) {
          const finishedAt = this.now();
          const dayKey = utcDayKey(finishedAt);
          const monthKey = utcMonthKey(finishedAt);
          const usage: PatrolTokenUsage = {
            ...emptyUsage,
            cacheHit: true,
            incrementalSkipped: inventory.length + orders.length,
          };
          this.store.recordTokenUsage(tenantId, runId, dayKey, monthKey, usage, finishedAt);
          const cachedRun: PatrolRunRecord = {
            id: runId,
            tenantId,
            trigger,
            status: "completed",
            severity: "ok",
            startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedAt - startedAt),
            patrolTicketId: patrolTicket.id,
            patrolMandateAllowlist: patrolAllowlist,
            summary: `命中摘要缓存（无新增变化）：${watermark!.lastSummary}`,
            findings: [],
            escalatedTickets: [],
            deniedToolCalls: guard.listDenials(),
            digestUpdated: false,
            digestDayKey: null,
            tokenUsage: usage,
          };
          this.store.saveRun(cachedRun);
          return cachedRun;
        }

        // Step 4: Deterministic rule triage on canonical fields.
        const nowMs = this.now();
        const rawFindings = this.evaluateCanonicalData(runId, inventory, orders, nowMs);

        // Step 5: Small-model patrol pass (always) + intercept any attempted tool calls at tool layer.
        const smallRes = await this.smallModelScanner({
          tier: "small",
          inventory,
          orders,
          preliminaryFindings: rawFindings.map((f) => ({ severity: f.severity, summary: f.summary })),
          signal,
        });
        if (signal.aborted) throw new PatrolTimeoutError(timeoutMs);

        const allAttemptedCalls = [
          ...(smallRes.attemptedToolCalls ?? []),
          ...(input.simulatedModelToolCalls ?? []),
        ];
        for (const call of allAttemptedCalls) {
          guard.authorize(call.toolName, call.args ?? {});
        }

        let largeCalls = 0;
        let largeTokens = 0;
        let reviewSummary = smallRes.summary;

        // Step 6: Escalate to large-model reviewer ONLY when anomalies are found.
        if (rawFindings.length > 0) {
          const largeRes = await this.largeModelReviewer({
            tier: "large",
            inventory,
            orders,
            preliminaryFindings: rawFindings.map((f) => ({ severity: f.severity, summary: f.summary })),
            signal,
          });
          if (signal.aborted) throw new PatrolTimeoutError(timeoutMs);
          largeCalls = 1;
          largeTokens = largeRes.tokensUsed;
          reviewSummary = `${smallRes.summary}；${largeRes.summary}`;
          for (const call of largeRes.attemptedToolCalls ?? []) {
            guard.authorize(call.toolName, call.args ?? {});
          }
        }

        // Step 7: Apply 3-tier outcome handling (ok -> log only; minor -> daily digest; major -> execution Ticket + MVP2b approval).
        const finishedAt = this.now();
        const dayKey = utcDayKey(finishedAt);
        const monthKey = utcMonthKey(finishedAt);
        const approver = input.approver?.trim() || this.defaultApprover;

        let digestUpdated = false;
        const escalatedTickets: Ticket[] = [];
        const finalFindings: PatrolFinding[] = [];

        for (const finding of rawFindings) {
          if (finding.severity === "minor") {
            this.store.appendDailyDigestEntry(tenantId, dayKey, {
              findingId: finding.id,
              runId,
              category: finding.category,
              summary: finding.summary,
              evidence: finding.evidence,
              recordedAt: finishedAt,
            });
            digestUpdated = true;
            finalFindings.push(finding);
            continue;
          }

          // Major issue -> create execution Ticket via MVP2a TicketEngine (with evidence) + evaluate via MVP2b ApprovalEngine.
          const isInventory = finding.evidence.kind === "inventory_low";
          const toolName = isInventory ? "procurement_create_restock_order" : "order_follow_up_fulfillment";
          const ticketSource = isInventory ? "inventory_change" : "new_order";
          const businessCost = isInventory
            ? Math.max(100, finding.evidence.shortage * 20)
            : 0;
          const actionCategory = isInventory ? "high_risk_spend" : "outward_message";

          const execIntake = this.tickets.intake({
            source: ticketSource,
            initiator: `patrol:${runId}`,
            text: `${finding.summary} | 证据: ${JSON.stringify(finding.evidence)}`,
            eventId: `${runId}:${finding.id}`,
            scope: isInventory ? "patrol:escalate:inventory_low" : "patrol:escalate:order_overdue",
            toolAllowlist: [toolName],
            budget: { tokenLimit: 2, businessLimit: businessCost, currency: "CNY" },
          });

          let executionTicketId: string | null = null;
          let approvalDecision: PatrolFinding["approvalDecision"] = null;
          let approvalCardId: string | null = null;

          if (execIntake.outcome === "created" || execIntake.outcome === "duplicate") {
            executionTicketId = execIntake.ticket.id;
            escalatedTickets.push(execIntake.ticket);

            const approval = await this.approvals.evaluate({
              tenantId,
              ticketId: execIntake.ticket.id,
              initiator: `patrol:${runId}`,
              approver,
              actionSummary: finding.summary,
              toolName,
              toolAllowlist: execIntake.ticket.toolAllowlist,
              actionCategory,
              tokenCost: 0.05,
              businessCost,
              currency: "CNY",
            });
            approvalDecision = approval.decision;
            approvalCardId = approval.card?.id ?? null;
          }

          finalFindings.push({
            ...finding,
            executionTicketId,
            approvalDecision,
            approvalCardId,
          });
        }

        const severity: PatrolSeverity = finalFindings.some((f) => f.severity === "major")
          ? "major"
          : finalFindings.some((f) => f.severity === "minor")
            ? "minor"
            : "ok";

        const patrolTokenCostUsd = Number(
          (
            (smallRes.tokensUsed / 1000) * SMALL_MODEL_USD_PER_1K_TOKENS +
            (largeTokens / 1000) * LARGE_MODEL_USD_PER_1K_TOKENS
          ).toFixed(6),
        );
        const tokenUsage: PatrolTokenUsage = {
          smallModelCalls: 1,
          largeModelCalls: largeCalls,
          smallModelTokens: smallRes.tokensUsed,
          largeModelTokens: largeTokens,
          patrolTokenCostUsd,
          cacheHit: false,
          incrementalSkipped: 0,
        };

        this.store.recordTokenUsage(tenantId, runId, dayKey, monthKey, tokenUsage, finishedAt);

        const latestCheckedAt = this.findLatestCheckedAt(inventory, orders, finishedAt);
        this.store.saveWatermark({
          tenantId,
          lastCheckedAt: latestCheckedAt,
          lastSnapshotHash: snapshotHash,
          lastSummary: reviewSummary,
          updatedAt: finishedAt,
        });

        const record: PatrolRunRecord = {
          id: runId,
          tenantId,
          trigger,
          status: "completed",
          severity,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          patrolTicketId: patrolTicket.id,
          patrolMandateAllowlist: patrolAllowlist,
          summary: reviewSummary,
          findings: finalFindings,
          escalatedTickets,
          deniedToolCalls: guard.listDenials(),
          digestUpdated,
          digestDayKey: digestUpdated ? dayKey : null,
          tokenUsage,
        };
        this.store.saveRun(record);
        return record;
      }, timeoutMs);

      return result;
    } catch (error) {
      const finishedAt = this.now();
      const isTimeout = error instanceof PatrolTimeoutError;
      const failedRecord: PatrolRunRecord = {
        id: runId,
        tenantId,
        trigger,
        status: isTimeout ? "timed_out" : "failed",
        severity: "ok",
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        patrolTicketId,
        patrolMandateAllowlist: patrolAllowlist,
        summary: isTimeout
          ? `巡检超时中止（上限 ${timeoutMs}ms）`
          : `巡检执行失败：${error instanceof Error ? error.message : String(error)}`,
        findings: [],
        escalatedTickets: [],
        deniedToolCalls: [],
        digestUpdated: false,
        digestDayKey: null,
        tokenUsage: emptyUsage,
        reason: isTimeout ? `timeout_ms:${timeoutMs}` : "execution_error",
      };
      this.store.saveRun(failedRecord);
      return failedRecord;
    } finally {
      this.activeRunByTenant.delete(tenantId);
      this.runGate.sweep(() => false);
    }
  }

  /** Event-triggered incremental patrol for a newly arrived order (no need to wait for daily schedule). */
  async triggerOrderEvent(
    rawOrder: RawPlatformRecord,
    options: { tenantId?: string; approver?: string } = {},
  ): Promise<PatrolRunRecord> {
    return this.runPatrol({
      tenantId: options.tenantId,
      trigger: "order_event",
      rawInventory: [],
      rawOrders: [rawOrder],
      approver: options.approver,
      incremental: false,
    });
  }

  getDailyDigest(dayKey?: string, tenantId = DEFAULT_TENANT_ID): PatrolDailyDigest | null {
    return this.store.getDailyDigest(tenantId, dayKey ?? utcDayKey(this.now()));
  }

  /** Dispatches the daily digest at most once per day ("一天只发一次"). */
  dispatchDailyDigest(
    dayKey?: string,
    tenantId = DEFAULT_TENANT_ID,
  ): { dispatched: boolean; digest: PatrolDailyDigest | null } {
    const nowMs = this.now();
    return this.store.markDailyDigestDispatched(tenantId, dayKey ?? utcDayKey(nowMs), nowMs);
  }

  getSpendSummary(tenantId = DEFAULT_TENANT_ID): PatrolSpendSummary {
    const nowMs = this.now();
    return this.store.getSpendSummary(tenantId, utcDayKey(nowMs), utcMonthKey(nowMs));
  }

  listRuns(limit = 50, tenantId?: string): PatrolRunRecord[] {
    return this.store.listRuns(limit, tenantId);
  }

  listToolDenials(limit = 100): PatrolToolDenialRecord[] {
    return this.store.listToolDenials(limit);
  }

  close(): void {
    this.store.close();
  }

  private resolveAdapters(input: PatrolRunInput): {
    inventoryAdapter: PatrolAdapterRegistry["inventory"];
    ordersAdapter: PatrolAdapterRegistry["orders"];
  } {
    if (input.fixtureName) {
      const fixtures = getPatrolFixtures(this.now());
      const dataset = fixtures[input.fixtureName];
      if (!dataset) {
        throw new Error(`未知的巡检假数据集合: ${input.fixtureName}`);
      }
      return {
        inventoryAdapter: new InventoryPatrolAdapter(() => dataset.inventory, this.now),
        ordersAdapter: new OrdersPatrolAdapter(() => dataset.orders, this.now),
      };
    }
    return {
      inventoryAdapter:
        input.rawInventory !== undefined
          ? new InventoryPatrolAdapter(() => input.rawInventory!, this.now)
          : this.adapters.inventory,
      ordersAdapter:
        input.rawOrders !== undefined
          ? new OrdersPatrolAdapter(() => input.rawOrders!, this.now)
          : this.adapters.orders,
    };
  }

  private evaluateCanonicalData(
    runId: string,
    inventory: CanonicalInventoryItem[],
    orders: CanonicalOrderItem[],
    nowMs: number,
  ): PatrolFinding[] {
    const findings: PatrolFinding[] = [];

    for (const item of inventory) {
      const safetyStock = item.safety_stock ?? this.defaultSafetyStock;
      if (item.available_quantity < safetyStock) {
        const shortage = safetyStock - item.available_quantity;
        findings.push({
          id: `pfind_${randomUUID()}`,
          runId,
          category: "inventory",
          severity: "major",
          summary: `库存不足：SKU ${item.sku}（仓库 ${item.warehouse}）当前库存 ${item.available_quantity} 件，低于安全库存 ${safetyStock} 件，缺口 ${shortage} 件`,
          evidence: {
            kind: "inventory_low",
            sku: item.sku,
            available_quantity: item.available_quantity,
            safety_stock: safetyStock,
            shortage,
            warehouse: item.warehouse,
            checked_at: item.checked_at,
          },
          executionTicketId: null,
          approvalDecision: null,
          approvalCardId: null,
          createdAt: nowMs,
        });
      } else if (item.available_quantity <= Math.floor(safetyStock * NEAR_SAFETY_MULTIPLIER)) {
        findings.push({
          id: `pfind_${randomUUID()}`,
          runId,
          category: "inventory",
          severity: "minor",
          summary: `库存接近安全库存：SKU ${item.sku}（仓库 ${item.warehouse}）当前 ${item.available_quantity} 件（安全库存 ${safetyStock} 件）`,
          evidence: {
            kind: "inventory_near_threshold",
            sku: item.sku,
            available_quantity: item.available_quantity,
            safety_stock: safetyStock,
            shortage: 0,
            warehouse: item.warehouse,
            checked_at: item.checked_at,
          },
          executionTicketId: null,
          approvalDecision: null,
          approvalCardId: null,
          createdAt: nowMs,
        });
      }
    }

    for (const order of orders) {
      if (order.status !== "paid_unshipped") continue;
      const paidMs = Date.parse(order.paid_at);
      const elapsedHours = Number.isFinite(paidMs) ? (nowMs - paidMs) / 3_600_000 : 0;
      if (elapsedHours > OVERDUE_UNSHIPPED_HOURS) {
        const roundedHours = Number(elapsedHours.toFixed(1));
        findings.push({
          id: `pfind_${randomUUID()}`,
          runId,
          category: "orders",
          severity: "major",
          summary: `订单异常：订单 ${order.order_id} 已付款 ${roundedHours} 小时（超 24 小时）仍未发货`,
          evidence: {
            kind: "order_paid_unshipped_overdue",
            order_id: order.order_id,
            status: order.status,
            paid_at: order.paid_at,
            amount: order.amount,
            sku_list: order.sku_list,
            overdue_hours: roundedHours,
          },
          executionTicketId: null,
          approvalDecision: null,
          approvalCardId: null,
          createdAt: nowMs,
        });
      } else {
        findings.push({
          id: `pfind_${randomUUID()}`,
          runId,
          category: "orders",
          severity: "minor",
          summary: `新订单入账：订单 ${order.order_id}，金额 ${order.amount} ${order.currency ?? "CNY"}，当前状态 ${order.status}`,
          evidence: {
            kind: "new_order",
            order_id: order.order_id,
            status: order.status,
            paid_at: order.paid_at,
            amount: order.amount,
            sku_list: order.sku_list,
          },
          executionTicketId: null,
          approvalDecision: null,
          approvalCardId: null,
          createdAt: nowMs,
        });
      }
    }

    return findings;
  }

  private findLatestCheckedAt(
    inventory: CanonicalInventoryItem[],
    orders: CanonicalOrderItem[],
    fallbackMs: number,
  ): string {
    let maxMs = 0;
    for (const item of inventory) {
      const ms = Date.parse(item.checked_at);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }
    for (const order of orders) {
      const ms = Date.parse(order.checked_at ?? order.paid_at);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }
    return new Date(maxMs > 0 ? maxMs : fallbackMs).toISOString();
  }
}
