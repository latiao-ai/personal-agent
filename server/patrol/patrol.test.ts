import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PATROL_READ_ONLY_TOOL_ALLOWLIST } from "../../shared/patrol.ts";
import { ApprovalEngine } from "../approvals/engine.ts";
import { TicketEngine } from "../tickets/engine.ts";
import {
  createDefaultStubAdapters,
  InventoryPatrolAdapter,
  normalizeInventoryRecord,
  normalizeOrderRecord,
  OrdersPatrolAdapter,
} from "./adapters.ts";
import { PatrolEngine } from "./engine.ts";
import { getPatrolFixtures } from "./fixtures.ts";
import { PatrolPermissionGuard } from "./permission-guard.ts";

const tempDirs: string[] = [];

function createTestHarness(options?: {
  now?: () => number;
  timeoutMs?: number;
  slowInventoryDelayMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-patrol-test-"));
  tempDirs.push(dir);
  const now = options?.now ?? (() => Date.parse("2026-11-26T10:00:00.000Z"));
  const tickets = new TicketEngine({
    dbPath: join(dir, "tickets.sqlite"),
    allowlist: new Set(["ou_owner_1"]),
    now,
  });
  const approvals = new ApprovalEngine({
    dbPath: join(dir, "approvals.sqlite"),
    now,
  });
  const slowDelay = options?.slowInventoryDelayMs ?? 0;
  const defaults = getPatrolFixtures(now()).normal;
  const patrol = new PatrolEngine({
    dbPath: join(dir, "patrol.sqlite"),
    tickets,
    approvals,
    now,
    timeoutMs: options?.timeoutMs,
    defaultApprover: "ou_owner_1",
    adapters: slowDelay > 0
      ? {
          inventory: new InventoryPatrolAdapter(async () => {
            await new Promise((resolve) => setTimeout(resolve, slowDelay));
            return defaults.inventory;
          }, now),
          orders: new OrdersPatrolAdapter(() => defaults.orders, now),
        }
      : undefined,
  });
  return {
    tickets,
    approvals,
    patrol,
    close: () => {
      patrol.close();
      approvals.close();
      tickets.close();
    },
  };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MVP4 PatrolEngine (read-only patrol, adapters, triage, token saving)", () => {
  it("runs manual patrol read-only with strictly read-only Mandate allowlist and logs ok-only on normal fixture", async () => {
    const h = createTestHarness();
    try {
      const run = await h.patrol.runPatrol({
        trigger: "manual",
        fixtureName: "normal",
      });

      expect(run.status).toBe("completed");
      expect(run.severity).toBe("ok");
      expect(run.findings).toHaveLength(0);
      expect(run.escalatedTickets).toHaveLength(0);
      expect(run.digestUpdated).toBe(false);
      expect(h.patrol.getDailyDigest()).toBeNull();
      expect(run.deniedToolCalls).toHaveLength(0);

      // Verify patrol Ticket Mandate has strictly read-only allowlist & zero business budget.
      expect(run.patrolTicketId).toBeTruthy();
      const patrolTicket = h.tickets.getTicket(run.patrolTicketId!);
      expect(patrolTicket).not.toBeNull();
      expect(patrolTicket!.mandate.toolAllowlist).toEqual([...PATROL_READ_ONLY_TOOL_ALLOWLIST]);
      expect(PatrolPermissionGuard.isStrictlyReadOnlyAllowlist(patrolTicket!.mandate.toolAllowlist)).toBe(true);
      expect(patrolTicket!.mandate.budgetLimit.businessLimit).toBe(0);

      // Small model only on normal run; large model not invoked.
      expect(run.tokenUsage.smallModelCalls).toBe(1);
      expect(run.tokenUsage.largeModelCalls).toBe(0);
    } finally {
      h.close();
    }
  });

  it("escalates low inventory to execution Ticket with full evidence and MVP2b approval", async () => {
    const h = createTestHarness();
    try {
      const checkedAt = "2026-11-26T10:00:00.000Z";
      const run = await h.patrol.runPatrol({
        trigger: "manual",
        rawInventory: [
          {
            platform: "erp",
            sku: "SKU-MUG-001",
            on_hand_qty: 12,
            safety_stock: 50,
            warehouse: "hz-east-1",
            checked_at: checkedAt,
          },
        ],
        rawOrders: [],
      });

      expect(run.status).toBe("completed");
      expect(run.severity).toBe("major");
      expect(run.findings).toHaveLength(1);
      const finding = run.findings[0]!;
      expect(finding.severity).toBe("major");
      expect(finding.evidence).toEqual({
        kind: "inventory_low",
        sku: "SKU-MUG-001",
        available_quantity: 12,
        safety_stock: 50,
        shortage: 38,
        warehouse: "hz-east-1",
        checked_at: checkedAt,
      });
      expect(finding.executionTicketId).toBeTruthy();
      expect(finding.approvalDecision).toBe("ask_human");
      expect(finding.approvalCardId).toBeTruthy();

      expect(run.escalatedTickets).toHaveLength(1);
      expect(run.escalatedTickets[0]!.mandate.goal).toContain("SKU-MUG-001");
      expect(run.escalatedTickets[0]!.mandate.goal).toContain("38");

      // Anomaly triggers large model review.
      expect(run.tokenUsage.smallModelCalls).toBe(1);
      expect(run.tokenUsage.largeModelCalls).toBe(1);
    } finally {
      h.close();
    }
  });

  it("records normal new order into daily digest without creating execution Ticket", async () => {
    const h = createTestHarness();
    try {
      const run = await h.patrol.triggerOrderEvent({
        platform: "shopify",
        order_id: "ORD-NEW-2001",
        status: "unfulfilled",
        paid_at: "2026-11-26T08:30:00.000Z",
        amount: 299,
        currency: "CNY",
        sku_list: [{ sku: "SKU-CASE-003", quantity: 1 }],
        checked_at: "2026-11-26T10:00:00.000Z",
      });

      expect(run.status).toBe("completed");
      expect(run.trigger).toBe("order_event");
      expect(run.severity).toBe("minor");
      expect(run.escalatedTickets).toHaveLength(0);
      expect(run.digestUpdated).toBe(true);

      const digest = h.patrol.getDailyDigest("2026-11-26");
      expect(digest).not.toBeNull();
      expect(digest!.entries).toHaveLength(1);
      expect(digest!.entries[0]!.evidence.kind).toBe("new_order");
    } finally {
      h.close();
    }
  });

  it("escalates paid unshipped order older than 24 hours to execution Ticket with evidence", async () => {
    const h = createTestHarness();
    try {
      const run = await h.patrol.runPatrol({
        trigger: "manual",
        rawInventory: [],
        rawOrders: [
          {
            platform: "taobao",
            order_id: "ORD-OVERDUE-2002",
            status: "WAIT_SELLER_SEND_GOODS",
            paid_at: "2026-11-25T04:00:00.000Z",
            amount: 680,
            currency: "CNY",
            sku_list: [{ sku: "SKU-MUG-001", quantity: 5 }],
            checked_at: "2026-11-26T10:00:00.000Z",
          },
        ],
      });

      expect(run.status).toBe("completed");
      expect(run.severity).toBe("major");
      expect(run.escalatedTickets).toHaveLength(1);
      const finding = run.findings[0]!;
      expect(finding.evidence.kind).toBe("order_paid_unshipped_overdue");
      if (finding.evidence.kind !== "order_paid_unshipped_overdue") throw new Error("expected overdue order");
      expect(finding.evidence.order_id).toBe("ORD-OVERDUE-2002");
      expect(finding.evidence.status).toBe("paid_unshipped");
      expect(finding.evidence.paid_at).toBe("2026-11-25T04:00:00.000Z");
      expect(finding.evidence.overdue_hours).toBeGreaterThan(24);
      expect(finding.approvalDecision).toBe("ask_human");
    } finally {
      h.close();
    }
  });

  it("aggregates minor issues into one daily digest dispatched at most once per day", async () => {
    const h = createTestHarness();
    try {
      await h.patrol.runPatrol({
        trigger: "manual",
        incremental: false,
        rawInventory: [
          {
            platform: "jd",
            sku: "SKU-CASE-003",
            stockNum: 55,
            safety_stock: 40,
            warehouse: "bj-north-1",
            checked_at: "2026-11-26T09:00:00.000Z",
          },
        ],
        rawOrders: [],
      });
      await h.patrol.runPatrol({
        trigger: "manual",
        incremental: false,
        rawInventory: [
          {
            platform: "jd",
            sku: "SKU-CASE-004",
            stockNum: 45,
            safety_stock: 40,
            warehouse: "bj-north-1",
            checked_at: "2026-11-26T09:30:00.000Z",
          },
        ],
        rawOrders: [],
      });

      const firstDispatch = h.patrol.dispatchDailyDigest("2026-11-26");
      expect(firstDispatch.dispatched).toBe(true);
      expect(firstDispatch.digest?.entries).toHaveLength(2);
      expect(firstDispatch.digest?.dispatchCount).toBe(1);

      const secondDispatch = h.patrol.dispatchDailyDigest("2026-11-26");
      expect(secondDispatch.dispatched).toBe(false);
      expect(secondDispatch.digest?.dispatchCount).toBe(1);
    } finally {
      h.close();
    }
  });

  it("blocks prompt-injected send_message / write / payment / browser calls at the tool layer and logs denials", async () => {
    const h = createTestHarness();
    try {
      const run = await h.patrol.runPatrol({
        trigger: "manual",
        fixtureName: "prompt_injection",
        simulatedModelToolCalls: [
          { toolName: "write_inventory_db", args: { sku: "SKU-MUG-001", qty: 999 } },
          { toolName: "browser_navigate", args: { url: "https://example.com" } },
        ],
      });

      expect(run.status).toBe("completed");
      expect(run.deniedToolCalls.length).toBeGreaterThanOrEqual(4);
      const deniedNames = run.deniedToolCalls.map((d) => d.toolName);
      expect(deniedNames).toContain("send_message");
      expect(deniedNames).toContain("make_payment");
      expect(deniedNames).toContain("write_inventory_db");
      expect(deniedNames).toContain("browser_navigate");

      const persistedDenials = h.patrol.listToolDenials();
      expect(persistedDenials.length).toBeGreaterThanOrEqual(4);
      expect(persistedDenials.every((d) => d.patrolTicketId === run.patrolTicketId)).toBe(true);
    } finally {
      h.close();
    }
  });

  it("skips overlapping patrol triggers while a previous run is still active", async () => {
    const h = createTestHarness({ slowInventoryDelayMs: 120, timeoutMs: 2_000 });
    try {
      const firstPromise = h.patrol.runPatrol({ trigger: "scheduled" });
      // Allow first run to enter active state.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const secondRun = await h.patrol.runPatrol({ trigger: "scheduled" });
      const firstRun = await firstPromise;

      expect(firstRun.status).toBe("completed");
      expect(secondRun.status).toBe("skipped_overlap");
      expect(secondRun.reason).toContain(firstRun.id);

      const runs = h.patrol.listRuns();
      expect(runs.some((r) => r.status === "skipped_overlap")).toBe(true);
    } finally {
      h.close();
    }
  });

  it("stops and records a timeout when a single patrol run exceeds timeoutMs", async () => {
    const h = createTestHarness({ slowInventoryDelayMs: 250, timeoutMs: 40 });
    try {
      const run = await h.patrol.runPatrol({ trigger: "scheduled" });

      expect(run.status).toBe("timed_out");
      expect(run.reason).toBe("timeout_ms:40");
      expect(h.patrol.listRuns().some((r) => r.status === "timed_out")).toBe(true);
    } finally {
      h.close();
    }
  });

  it("uses snapshot summary cache and tracks patrol token spend separately from work budget", async () => {
    const h = createTestHarness();
    try {
      const first = await h.patrol.runPatrol({ trigger: "scheduled", fixtureName: "normal" });
      const second = await h.patrol.runPatrol({ trigger: "scheduled", fixtureName: "normal" });

      expect(first.tokenUsage.cacheHit).toBe(false);
      expect(first.tokenUsage.smallModelTokens).toBeGreaterThan(0);

      expect(second.tokenUsage.cacheHit).toBe(true);
      expect(second.tokenUsage.smallModelTokens).toBe(0);
      expect(second.tokenUsage.largeModelTokens).toBe(0);

      const spend = h.patrol.getSpendSummary();
      expect(spend.totalRuns).toBe(2);
      expect(spend.cacheHits).toBe(1);
      expect(spend.daySmallTokens).toBe(first.tokenUsage.smallModelTokens);
      expect(spend.dayCostUsd).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it("normalizes multi-platform fields into canonical Ontology fields and keeps 4 deferred adapters as stubs", async () => {
    const checkedAt = "2026-11-26T10:00:00.000Z";
    expect(
      normalizeInventoryRecord({ platform: "taobao", sku: "A1", stock: 33, warehouse: "w1" }, checkedAt)
        .available_quantity,
    ).toBe(33);
    expect(
      normalizeInventoryRecord(
        { platform: "shopify", sku: "A2", inventory_quantity: 44, warehouse: "w2" },
        checkedAt,
      ).available_quantity,
    ).toBe(44);
    expect(
      normalizeInventoryRecord({ platform: "jd", sku: "A3", stockNum: 55, warehouse: "w3" }, checkedAt)
        .available_quantity,
    ).toBe(55);
    expect(
      normalizeInventoryRecord({ platform: "erp", sku: "A4", on_hand_qty: 66, warehouse: "w4" }, checkedAt)
        .available_quantity,
    ).toBe(66);

    expect(
      normalizeOrderRecord({ platform: "taobao", order_id: "O1", status: "WAIT_SELLER_SEND_GOODS" }, checkedAt)
        .status,
    ).toBe("paid_unshipped");
    expect(
      normalizeOrderRecord({ platform: "shopify", order_id: "O2", status: "unfulfilled" }, checkedAt).status,
    ).toBe("paid_unshipped");

    const stubs = createDefaultStubAdapters();
    expect(stubs.price.implemented).toBe(false);
    expect(stubs.logistics.implemented).toBe(false);
    expect(stubs.supplier_reply.implemented).toBe(false);
    expect(stubs.hot_product.implemented).toBe(false);
    expect(await stubs.price.read()).toEqual([]);
    expect(await stubs.logistics.read()).toEqual([]);
    expect(await stubs.supplier_reply.read()).toEqual([]);
    expect(await stubs.hot_product.read()).toEqual([]);
  });
});
