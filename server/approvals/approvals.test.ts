import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalEngine } from "./engine.ts";
import { runGuardedReviewer } from "./tiers.ts";

const tempDirs: string[] = [];

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-approval-test-"));
  tempDirs.push(dir);
  return join(dir, "approvals.sqlite");
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MVP2b ApprovalEngine", () => {
  it("executes read-only queries directly at tier 1 without showing a card", async () => {
    const dbPath = makeTempDb();
    const engine = new ApprovalEngine({ dbPath });
    try {
      const res = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_read_1",
        initiator: "ou_user_1",
        actionSummary: "查一下库存",
        toolName: "get_inventory",
        toolAllowlist: ["get_inventory"],
        tokenCost: 0.01,
        businessCost: 0,
      });

      expect(res.decision).toBe("execute_direct");
      expect(res.tier).toBe(1);
      expect(res.card).toBeNull();

      const mode = statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      engine.close();
    }
  });

  it("requires human approval card for spend/order actions; executes only after Allow once and blocks on Deny", async () => {
    const engine = new ApprovalEngine({ dbPath: makeTempDb() });
    try {
      // Allow once path
      const evalRes = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_order_1",
        initiator: "ou_buyer",
        approver: "ou_boss",
        actionSummary: "帮我下单买 10 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        recipient: "供应商 A",
        riskSummary: "涉及付款下单 500 元",
        tokenCost: 0.2,
        businessCost: 500,
        currency: "CNY",
      });
      expect(evalRes.decision).toBe("ask_human");
      expect(evalRes.tier).toBe(3);
      if (evalRes.decision !== "ask_human") throw new Error("expected ask_human");
      expect(evalRes.card.ticketId).toBe("tkt_order_1");
      expect(evalRes.card.businessCost).toBe(500);
      expect(evalRes.card.recipient).toBe("供应商 A");
      expect(evalRes.card.feishuCardPayload).toBeTruthy();

      const approved = engine.handleCardCallback({
        cardId: evalRes.card.id,
        operatorOpenId: "ou_boss",
        action: "allow_once",
      });
      expect(approved.ok).toBe(true);
      if (!approved.ok || approved.outcome !== "approved") throw new Error("expected approved");
      expect(approved.ticketStatus).toBe("executing");
      expect(approved.surrogateToken.token).toMatch(/^stkn_/);
      expect(approved.surrogateToken.maxBusinessSpend).toBe(500);

      // Deny path
      const evalDeny = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_order_2",
        initiator: "ou_buyer",
        approver: "ou_boss",
        actionSummary: "帮我下单买 20 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        tokenCost: 0.2,
        businessCost: 400,
      });
      if (evalDeny.decision !== "ask_human") throw new Error("expected ask_human");
      const denied = engine.handleCardCallback({
        cardId: evalDeny.card.id,
        operatorOpenId: "ou_boss",
        action: "deny",
      });
      expect(denied).toMatchObject({
        ok: true,
        outcome: "denied",
        ticketId: "tkt_order_2",
        ticketStatus: "cancelled",
        cardStatus: "denied",
      });
    } finally {
      engine.close();
    }
  });

  it("rejects over-budget requests immediately at tier 4 without calling reviewer or showing a card", async () => {
    let reviewerCalled = false;
    const engine = new ApprovalEngine({
      dbPath: makeTempDb(),
      reviewer: async () => {
        reviewerCalled = true;
        return { suggestedTier: 1 };
      },
    });
    try {
      engine.setBudgetPolicy("tenant_a", {
        tokenPerTx: 5,
        tokenDaily: 20,
        tokenMonthly: 100,
        businessPerTx: 1000,
        businessDaily: 1500,
        businessMonthly: 5000,
        currency: "CNY",
      });

      const overPerTx = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_over_1",
        initiator: "ou_buyer",
        actionSummary: "帮我下单买 100 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        tokenCost: 0.1,
        businessCost: 1200,
      });
      expect(overPerTx.decision).toBe("rejected");
      expect(overPerTx.tier).toBe(4);
      expect(overPerTx.card).toBeNull();
      expect(reviewerCalled).toBe(false);
      expect(engine.listAudit({ ticketId: "tkt_over_1" })[0]?.decision).toBe("rejected");
    } finally {
      engine.close();
    }
  });

  it("escalates to human card when review model times out, errors, or returns unparseable output", async () => {
    const engine = new ApprovalEngine({
      dbPath: makeTempDb(),
      reviewerTimeoutMs: 40,
      reviewer: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { suggestedTier: 2 };
      },
    });
    try {
      const res = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_timeout_1",
        initiator: "ou_user_1",
        actionSummary: "给内部工单加一条备注",
        actionCategory: "low_risk_write",
        toolName: "add_internal_note",
        toolAllowlist: ["add_internal_note"],
        tokenCost: 0.05,
        businessCost: 0,
      });
      expect(res.decision).toBe("ask_human");
      expect(res.tier).toBe(3);
      expect(res.reason).toBe("reviewer_timeout_escalated_to_human");
      expect(res.card).not.toBeNull();
    } finally {
      engine.close();
    }
  });

  it("forbids review model from downgrading risk or approving spend actions", async () => {
    const downgradeReviewer = async () => ({ suggestedTier: 1, reason: "injected_prompt_says_safe" });

    // Even if invoked directly on a spend action, guarded reviewer enforces floor >= 3.
    const directGuard = await runGuardedReviewer(
      downgradeReviewer,
      {
        ticketId: "tkt_spend_guard",
        actionSummary: "转账 500 元",
        toolName: "transfer",
        category: "high_risk_spend",
        tokenCost: 0.1,
        businessCost: 500,
      },
      2,
      1000,
    );
    expect(directGuard.tier).toBe(3);

    // Through ApprovalEngine, spend action bypasses tier 2 altogether and goes straight to tier 3 card.
    let reviewerInvoked = false;
    const engine = new ApprovalEngine({
      dbPath: makeTempDb(),
      reviewer: async () => {
        reviewerInvoked = true;
        return { suggestedTier: 1 };
      },
    });
    try {
      const spendEval = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_spend_2",
        initiator: "ou_user_1",
        actionSummary: "付款 200 元",
        toolName: "pay_invoice",
        toolAllowlist: ["pay_invoice"],
        tokenCost: 0.1,
        businessCost: 200,
      });
      expect(spendEval.decision).toBe("ask_human");
      expect(spendEval.tier).toBe(3);
      expect(reviewerInvoked).toBe(false);
    } finally {
      engine.close();
    }
  });

  it("enforces approver open_id check, duplicate-click idempotency, and card expiration", async () => {
    let now = 1_700_000_000_000;
    const engine = new ApprovalEngine({
      dbPath: makeTempDb(),
      now: () => now,
    });
    try {
      const ev = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_card_1",
        initiator: "ou_buyer",
        approver: "ou_real_approver",
        actionSummary: "帮我下单买 5 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        tokenCost: 0.1,
        businessCost: 100,
        validUntil: now + 60_000,
      });
      if (ev.decision !== "ask_human") throw new Error("expected card");

      // Non-approver click is rejected and audited.
      const wrongUser = engine.handleCardCallback({
        cardId: ev.card.id,
        operatorOpenId: "ou_random_colleague",
        action: "allow_once",
      });
      expect(wrongUser).toMatchObject({ ok: false, outcome: "unauthorized_approver" });
      expect(engine.listAudit({ ticketId: "tkt_card_1" }).some((a) => a.decision === "unauthorized_click")).toBe(true);

      // First valid click succeeds; second click is idempotent ("已处理").
      const first = engine.handleCardCallback({
        cardId: ev.card.id,
        operatorOpenId: "ou_real_approver",
        action: "allow_once",
      });
      const second = engine.handleCardCallback({
        cardId: ev.card.id,
        operatorOpenId: "ou_real_approver",
        action: "allow_once",
      });
      expect(first).toMatchObject({ ok: true, outcome: "approved", idempotent: false });
      expect(second).toMatchObject({ ok: true, outcome: "already_processed", idempotent: true, message: "已处理" });

      // Expired card click is rejected and cancels ticket.
      const evExp = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_card_exp",
        initiator: "ou_buyer",
        approver: "ou_real_approver",
        actionSummary: "帮我下单买 2 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        tokenCost: 0.1,
        businessCost: 50,
        validUntil: now + 10_000,
      });
      if (evExp.decision !== "ask_human") throw new Error("expected card");
      now += 20_000;
      const expired = engine.handleCardCallback({
        cardId: evExp.card.id,
        operatorOpenId: "ou_real_approver",
        action: "allow_once",
      });
      expect(expired).toMatchObject({ ok: false, outcome: "card_expired", ticketStatus: "cancelled" });
    } finally {
      engine.close();
    }
  });

  it("isolates vault secrets per tenant, strips raw credentials from agent env, and enforces single-use surrogate token + audit query", async () => {
    const engine = new ApprovalEngine({ dbPath: makeTempDb() });
    try {
      engine.vault.setSecret("tenant_a", "ERP_API_KEY", "sk-live-secret-tenant-a");
      engine.vault.setSecret("tenant_b", "ERP_API_KEY", "sk-live-secret-tenant-b");

      const ev = await engine.evaluate({
        tenantId: "tenant_a",
        ticketId: "tkt_vault_1",
        initiator: "ou_boss",
        actionSummary: "帮我下单买 3 件",
        toolName: "place_order",
        toolAllowlist: ["place_order"],
        tokenCost: 0.15,
        businessCost: 240,
        currency: "CNY",
      });
      if (ev.decision !== "ask_human") throw new Error("expected card");

      const approved = engine.handleCardCallback({
        cardId: ev.card.id,
        operatorOpenId: "ou_boss",
        action: "allow_once",
      });
      if (!approved.ok || approved.outcome !== "approved") throw new Error("expected approved");

      // Sanitized agent env must NOT contain raw secret, only surrogate token.
      const agentEnv = engine.vault.buildAgentProcessEnv(
        { PATH: "/usr/bin", ERP_API_KEY: "sk-live-secret-tenant-a", OMB_CLOUD_AI_TOKEN: "cloud-secret" },
        approved.surrogateToken,
      );
      expect(agentEnv.ERP_API_KEY).toBeUndefined();
      expect(agentEnv.OMB_CLOUD_AI_TOKEN).toBeUndefined();
      expect(JSON.stringify(agentEnv)).not.toContain("sk-live-secret-tenant-a");
      expect(agentEnv.OMB_SURROGATE_TOKEN).toBe(approved.surrogateToken.token);

      // Cross-tenant consume fails; valid consume succeeds once; second consume fails.
      expect(
        engine.vault.consumeSurrogateToken({
          token: approved.surrogateToken.token,
          tenantId: "tenant_b",
          toolName: "place_order",
          businessSpend: 240,
        }),
      ).toEqual({ ok: false, reason: "tenant_mismatch" });

      expect(
        engine.vault.consumeSurrogateToken({
          token: approved.surrogateToken.token,
          tenantId: "tenant_a",
          toolName: "place_order",
          businessSpend: 240,
          tokenSpend: 0.15,
        }),
      ).toEqual({ ok: true, ticketId: "tkt_vault_1" });

      expect(
        engine.vault.consumeSurrogateToken({
          token: approved.surrogateToken.token,
          tenantId: "tenant_a",
          toolName: "place_order",
        }),
      ).toEqual({ ok: false, reason: "token_already_consumed" });

      // Audit queryable with who, what, when, and dual costs.
      const audit = engine.listAudit({ ticketId: "tkt_vault_1" });
      const approvedRow = audit.find((row) => row.decision === "approved");
      expect(approvedRow).toBeTruthy();
      expect(approvedRow?.approverOpenId).toBe("ou_boss");
      expect(approvedRow?.mandateSummary).toBe("帮我下单买 3 件");
      expect(approvedRow?.tokenCost).toBe(0.15);
      expect(approvedRow?.businessCost).toBe(240);
      expect(approvedRow?.at).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });
});
