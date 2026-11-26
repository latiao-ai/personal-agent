import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TicketEngine, TicketEngineError } from "./engine.ts";
import { hashMandate, verifySignedMandateCopy } from "./mandate.ts";
import { createTicketRoutes } from "../routes/tickets.ts";
import { PASS, type RouteContext } from "../routes/table.ts";

const tempDirs: string[] = [];

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-ticket-test-"));
  tempDirs.push(dir);
  return join(dir, "tickets.sqlite");
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MVP2a TicketEngine", () => {
  it("creates a complete, unique ticket for side-effect Feishu DM from whitelisted user", () => {
    const dbPath = makeTempDb();
    const engine = new TicketEngine({
      dbPath,
      allowlist: new Set(["ou_allowed_1"]),
      signingSecret: "test-secret",
    });
    try {
      const res = engine.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "帮我把这批货的库存改成 100",
        eventId: "evt_001",
        toolAllowlist: ["inventory_write"],
        budget: { tokenLimit: 2.5, businessLimit: 500, currency: "CNY" },
      });

      expect(res.outcome).toBe("created");
      if (res.outcome !== "created") throw new Error("expected created");
      expect(res.replyNormally).toBe(true);
      expect(res.observeOnly).toBe(false);
      expect(res.ticket.id).toMatch(/^tkt_/);
      expect(res.ticket.status).toBe("ready");
      expect(res.ticket.source).toBe("feishu_dm");
      expect(res.ticket.initiator).toBe("ou_allowed_1");
      expect(res.ticket.toolAllowlist).toEqual(["inventory_write"]);
      expect(res.ticket.budget).toEqual({ tokenLimit: 2.5, businessLimit: 500, currency: "CNY" });
      expect(res.ticket.mandate.goal).toBe("帮我把这批货的库存改成 100");
      expect(res.ticket.mandate.approver).toBeNull();
      expect(res.ticket.mandateHash).toBe(hashMandate(res.ticket.mandate));
      expect(res.ticket.parentId).toBeNull();

      // Verify SQLite file permissions (0600 on POSIX).
      const mode = statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      engine.close();
    }
  });

  it("bypasses ticket creation for ordinary conversation and read-only queries", () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
    });
    try {
      const r1 = engine.intake({ source: "feishu_dm", initiator: "ou_allowed_1", text: "今天天气怎么样" });
      const r2 = engine.intake({ source: "feishu_dm", initiator: "ou_allowed_1", text: "查一下库存" });

      expect(r1).toMatchObject({ outcome: "conversation", replyNormally: true, observeOnly: false });
      expect(r2).toMatchObject({ outcome: "conversation", replyNormally: true, observeOnly: false });
      expect(engine.listTickets()).toHaveLength(0);
    } finally {
      engine.close();
    }
  });

  it("supports creating a ticket mid-conversation when a side-effect action is triggered", () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
    });
    try {
      const res = engine.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "按刚才聊的方案执行",
        midConversationSideEffect: true,
        threadId: "thread_123",
      });
      expect(res.outcome).toBe("created");
      if (res.outcome === "created") {
        expect(res.ticket.threadId).toBe("thread_123");
        expect(res.ticket.status).toBe("ready");
      }
    } finally {
      engine.close();
    }
  });

  it("deduplicates identical side-effect messages (with and without eventId) and survives restart", () => {
    const dbPath = makeTempDb();
    let now = 1_700_000_000_000;
    const engine1 = new TicketEngine({
      dbPath,
      allowlist: new Set(["ou_allowed_1"]),
      now: () => now,
    });
    let firstId: string;
    try {
      const a = engine1.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "帮我下单买 10 件",
      });
      const b = engine1.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "帮我下单买 10 件",
      });
      expect(a.outcome).toBe("created");
      expect(b.outcome).toBe("duplicate");
      if (a.outcome !== "created" || b.outcome !== "duplicate") throw new Error("unexpected");
      firstId = a.ticket.id;
      expect(b.ticket.id).toBe(firstId);
      expect(engine1.listTickets()).toHaveLength(1);

      const audit = engine1.listAudit(firstId);
      expect(audit.some((entry) => entry.action === "ticket_deduplicated")).toBe(true);
    } finally {
      engine1.close();
    }

    // Reopen SQLite to simulate process restart: same message still deduplicates.
    const engine2 = new TicketEngine({
      dbPath,
      allowlist: new Set(["ou_allowed_1"]),
      now: () => now + 10_000,
    });
    try {
      const c = engine2.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "帮我下单买 10 件",
      });
      expect(c.outcome).toBe("duplicate");
      if (c.outcome === "duplicate") {
        expect(c.ticket.id).toBe(firstId);
      }
      expect(engine2.listTickets()).toHaveLength(1);
    } finally {
      engine2.close();
    }
  });

  it("denies non-whitelisted senders with audit log and creates no ticket", () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
    });
    try {
      const res = engine.intake({
        source: "feishu_dm",
        initiator: "ou_stranger_999",
        text: "帮我把库存改成 0",
        eventId: "evt_stranger",
      });
      expect(res).toEqual({
        outcome: "denied",
        reason: "not_whitelisted",
        replyNormally: false,
        observeOnly: false,
      });
      expect(engine.listTickets()).toHaveLength(0);
      const audit = engine.listAudit();
      expect(audit.some((e) => e.action === "intake_denied" && e.actor === "ou_stranger_999")).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("defaults external events to observe-only while whitelisted DM does not observe", () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
    });
    try {
      const extOrder = engine.intake({
        source: "new_order",
        initiator: "erp_sync",
        text: "新订单 #9001 金额 1200 元",
        eventId: "ord_9001",
      });
      const extWebhook = engine.intakeExternalWebhook({
        webhookId: "wh_1",
        webhookName: "InventoryHook",
        deliveryId: "del_1",
        prompt: "SKU-42 库存下降至 3",
        botId: "bot_1",
      });
      const dm = engine.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "帮我把 SKU-42 库存改成 50",
        eventId: "evt_dm_1",
      });

      expect(extOrder.outcome).toBe("created");
      expect(extWebhook.outcome).toBe("created");
      expect(dm.outcome).toBe("created");
      if (extOrder.outcome !== "created" || extWebhook.outcome !== "created" || dm.outcome !== "created") {
        throw new Error("expected created");
      }

      expect(extOrder.ticket.status).toBe("observe");
      expect(extOrder.observeOnly).toBe(true);
      expect(extOrder.replyNormally).toBe(false);

      expect(extWebhook.ticket.status).toBe("observe");
      expect(extWebhook.observeOnly).toBe(true);

      expect(dm.ticket.status).toBe("ready");
      expect(dm.observeOnly).toBe(false);
      expect(dm.replyNormally).toBe(true);
    } finally {
      engine.close();
    }
  });

  it("enforces immutable mandates: revise supersedes old ticket and links parentId; agent mutation is denied", () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
      signingSecret: "control-plane-key",
    });
    try {
      const created = engine.intake({
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "采购 10 台设备",
        budget: { tokenLimit: 1, businessLimit: 1000, currency: "CNY" },
      });
      if (created.outcome !== "created") throw new Error("expected created");
      const oldId = created.ticket.id;
      const oldHash = created.ticket.mandateHash;

      // Signed read-only copy verifies cleanly, tampering breaks verification.
      const copy = engine.readMandateForAgent(oldId);
      expect(copy.readonly).toBe(true);
      expect(verifySignedMandateCopy(copy, "control-plane-key")).toBe(true);
      expect(
        verifySignedMandateCopy(
          { ...copy, mandate: { ...copy.mandate, goal: "采购 999 台设备" } },
          "control-plane-key",
        ),
      ).toBe(false);

      // Agent attempting to mutate mandate via tool is refused and audited; stored mandate is unchanged.
      const refusal = engine.rejectAgentMandateMutation(oldId, "bot_buyer", "edit_mandate", {
        budgetLimit: { businessLimit: 999999 },
      });
      expect(refusal).toEqual({
        denied: true,
        reason: "mandate_immutable",
        ticketId: oldId,
        mandateHash: oldHash,
      });
      const stillOriginal = engine.getTicket(oldId)!;
      expect(stillOriginal.mandateHash).toBe(oldHash);
      expect(stillOriginal.mandate.budgetLimit.businessLimit).toBe(1000);
      expect(engine.listAudit(oldId).some((e) => e.action === "mandate_mutation_denied")).toBe(true);

      // Revising mandate supersedes old ticket and creates new ticket with parentId.
      const { oldTicket, newTicket } = engine.reviseMandate(
        oldId,
        { goal: "采购 20 台设备", budgetLimit: { businessLimit: 2000 } },
        "ou_allowed_1",
      );
      expect(oldTicket.status).toBe("superseded");
      expect(newTicket.parentId).toBe(oldId);
      expect(newTicket.mandate.goal).toBe("采购 20 台设备");
      expect(newTicket.mandate.budgetLimit.businessLimit).toBe(2000);
      expect(newTicket.mandate.approver).toBeNull();
      expect(newTicket.mandateHash).not.toBe(oldHash);

      // Superseded ticket cannot be revised again.
      expect(() => engine.reviseMandate(oldId, { goal: "再改一次" }, "ou_allowed_1")).toThrow(TicketEngineError);
    } finally {
      engine.close();
    }
  });

  it("exposes control-plane HTTP routes and rejects in-place mandate mutations with 403", async () => {
    const engine = new TicketEngine({
      dbPath: makeTempDb(),
      allowlist: new Set(["ou_allowed_1"]),
      signingSecret: "route-secret",
    });
    const handler = createTicketRoutes({ tickets: engine });

    const call = async (method: string, path: string, body?: unknown) => {
      let statusCode = 0;
      let payload: unknown;
      const ctx = {
        req: {} as RouteContext["req"],
        res: { headersSent: false, writableEnded: false } as RouteContext["res"],
        url: new URL(`http://127.0.0.1:8799${path}`),
        path: path.split("?")[0]!,
        method,
        auth: { kind: "loopback", scopes: ["admin"], trust: "local" } as unknown as RouteContext["auth"],
        json: (_res: unknown, status: number, data: unknown) => {
          statusCode = status;
          payload = data;
        },
        readBody: async () => body,
      } as unknown as RouteContext;
      const out = await handler(ctx);
      return { passed: out === PASS, status: statusCode, payload: payload as Record<string, any> };
    };

    try {
      const intake = await call("POST", "/api/tickets/intake", {
        source: "feishu_dm",
        initiator: "ou_allowed_1",
        text: "更新客户白名单",
      });
      expect(intake.status).toBe(201);
      const id = intake.payload.ticket.id as string;
      const hash = intake.payload.ticket.mandateHash as string;

      const readCopy = await call("GET", `/api/tickets/${id}/mandate`);
      expect(readCopy.status).toBe(200);
      expect(readCopy.payload.mandateCopy.mandateHash).toBe(hash);
      expect(readCopy.payload.mandateCopy.readonly).toBe(true);

      const mutate = await call("PATCH", `/api/tickets/${id}/mandate`, {
        actor: "vm_agent_1",
        toolName: "ticket_patch",
        patch: { goal: "越权修改" },
      });
      expect(mutate.status).toBe(403);
      expect(mutate.payload.denied).toBe(true);
      expect(mutate.payload.mandateHash).toBe(hash);

      const revised = await call("POST", `/api/tickets/${id}/revise`, {
        actor: "ou_allowed_1",
        goal: "更新客户白名单并限定 10 条",
      });
      expect(revised.status).toBe(201);
      expect(revised.payload.oldTicket.status).toBe("superseded");
      expect(revised.payload.newTicket.parentId).toBe(id);

      const audit = await call("GET", `/api/tickets/${id}/audit`);
      expect(audit.status).toBe(200);
      expect(audit.payload.audit.some((e: { action: string }) => e.action === "mandate_mutation_denied")).toBe(true);
    } finally {
      engine.close();
    }
  });
});
