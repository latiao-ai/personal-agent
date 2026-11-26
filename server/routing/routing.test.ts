import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RoutingRole } from "../../shared/routing.ts";
import { TicketEngine } from "../tickets/engine.ts";
import { MAX_ROUTING_HOPS, RoutingEngine } from "./engine.ts";

const tempDirs: string[] = [];

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routing-test-"));
  tempDirs.push(dir);
  const tickets = new TicketEngine({
    dbPath: join(dir, "tickets.sqlite"),
    allowlist: new Set(["ou_member_1"]),
  });
  const routing = new RoutingEngine({ tickets });
  return { tickets, routing };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MVP3 RoutingEngine (Gate Jev + Inner Router-Worker)", () => {
  it("routes inventory query to procurement bot via Manager Bot without direct group posting", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const res = await routing.routeGroupMessage({
        eventId: "grp_evt_1",
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: true,
        text: "@助理 查库存",
      });

      expect(res.outcome).toBe("dispatched_to_specialist");
      if (res.outcome !== "dispatched_to_specialist") throw new Error("expected dispatch");
      expect(res.specialistRole).toBe("procurement");
      expect(res.specialistBotId).toBe("bot_procurement");
      expect(res.replyChannel).toBe("manager_only");
      expect(res.specialistMayPostDirectly).toBe(false);
      expect(res.ticket).toBeNull();
    } finally {
      tickets.close();
    }
  });

  it("routes factory follow-up to followup bot via Manager Bot", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const res = await routing.routeGroupMessage({
        eventId: "grp_evt_2",
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: true,
        text: "@助理 跟一下工厂",
      });

      expect(res.outcome).toBe("dispatched_to_specialist");
      if (res.outcome !== "dispatched_to_specialist") throw new Error("expected dispatch");
      expect(res.specialistRole).toBe("followup");
      expect(res.specialistBotId).toBe("bot_followup");
      expect(res.replyChannel).toBe("manager_only");
      expect(res.specialistMayPostDirectly).toBe(false);
    } finally {
      tickets.close();
    }
  });

  it("does not create a Ticket for chitchat and replies via Manager Bot", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const res = await routing.routeGroupMessage({
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: true,
        text: "@助理 今天天气不错",
      });

      expect(res.outcome).toBe("replied_by_manager");
      expect(res.ticket).toBeNull();
      expect(tickets.listTickets()).toHaveLength(0);
    } finally {
      tickets.close();
    }
  });

  it("falls back ambiguous messages to lead bot without misrouting", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const res = await routing.routeGroupMessage({
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: true,
        text: "@助理 这个怎么样",
      });

      expect(res.outcome).toBe("replied_by_manager");
      if (res.outcome !== "replied_by_manager") throw new Error("expected lead fallback");
      expect(res.jev.fallbackToLead).toBe(true);
      expect(res.jev.targetRole).toBe("lead");
      expect(res.ticket).toBeNull();
    } finally {
      tickets.close();
    }
  });

  it("ignores group messages without @mention and creates no Ticket", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const res = await routing.routeGroupMessage({
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: false,
        text: "帮我下单买 10 件",
      });

      expect(res.outcome).toBe("ignored_no_mention");
      expect(res.ticket).toBeNull();
      expect(tickets.listTickets()).toHaveLength(0);
    } finally {
      tickets.close();
    }
  });

  it("creates a Ticket via MVP2a TicketEngine for side-effect work and enforces Specialist reply & max_hops=4", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const dispatched = await routing.routeGroupMessage({
        eventId: "grp_evt_order",
        chatId: "oc_group_1",
        senderId: "ou_member_1",
        mentionedBot: true,
        text: "@助理 帮我下单买 10 件",
      });
      expect(dispatched.outcome).toBe("dispatched_to_specialist");
      if (dispatched.outcome !== "dispatched_to_specialist") throw new Error("expected dispatch");
      expect(dispatched.specialistRole).toBe("order");
      expect(dispatched.ticket).not.toBeNull();
      expect(dispatched.ticket?.source).toBe("feishu_group");

      // Specialist attempting direct group post is forbidden.
      const directAttempt = routing.handleSpecialistReply({
        chatId: "oc_group_1",
        ticketId: dispatched.ticket?.id ?? null,
        specialistBotId: "bot_order",
        managerBotId: "bot_chief_of_staff",
        text: "我直接发群里了",
        deliveryMode: "direct_group",
        hops: 1,
      });
      expect(directAttempt).toMatchObject({ ok: false, outcome: "direct_group_forbidden" });

      // Relay via Manager Bot succeeds.
      const relayed = routing.handleSpecialistReply({
        chatId: "oc_group_1",
        ticketId: dispatched.ticket?.id ?? null,
        specialistBotId: "bot_order",
        managerBotId: "bot_chief_of_staff",
        text: "已生成下单工单待审批",
        deliveryMode: "via_manager",
        hops: 1,
      });
      expect(relayed).toMatchObject({ ok: true, outcome: "relayed_via_manager", replyChannel: "manager_only" });

      // Reaching max_hops = 4 escalates to human with audit log.
      const escalated = routing.handleSpecialistReply({
        chatId: "oc_group_1",
        ticketId: dispatched.ticket?.id ?? null,
        specialistBotId: "bot_order",
        managerBotId: "bot_chief_of_staff",
        text: "再转一次",
        handoffToRole: "procurement",
        hops: MAX_ROUTING_HOPS - 1,
      });
      expect(escalated).toMatchObject({ ok: false, outcome: "escalated_to_human", maxHops: 4 });
      expect(routing.listAudit().some((a) => a.action === "max_hops_escalated")).toBe(true);
    } finally {
      tickets.close();
    }
  });

  it("ignores messages sent by bots themselves to prevent routing loops", async () => {
    const { tickets, routing } = makeEngine();
    try {
      const byFlag = await routing.routeGroupMessage({
        chatId: "oc_group_1",
        senderId: "ou_some_bot",
        senderIsBot: true,
        mentionedBot: true,
        text: "@助理 查库存",
      });
      const byKnownId = await routing.routeGroupMessage({
        chatId: "oc_group_1",
        senderId: "bot_procurement",
        mentionedBot: true,
        text: "@助理 帮我下单买 5 件",
      });

      expect(byFlag.outcome).toBe("ignored_bot_self");
      expect(byKnownId.outcome).toBe("ignored_bot_self");
      expect(tickets.listTickets()).toHaveLength(0);
    } finally {
      tickets.close();
    }
  });

  it("meets evals/routing/cases.json accuracy targets (misroute < 5%, fallback < 20%)", async () => {
    const { tickets, routing } = makeEngine();
    const casesPath = join(process.cwd(), "evals", "routing", "cases.json");
    const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Array<{
      id: string;
      category: string;
      text: string;
      expectedRole: RoutingRole;
      expectTicket: boolean;
      expectFallback?: boolean;
    }>;

    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThanOrEqual(50);

    let misroutes = 0;
    let fallbacks = 0;
    try {
      for (const sample of cases) {
        const res = await routing.routeGroupMessage({
          eventId: `eval_${sample.id}`,
          chatId: "oc_eval_group",
          senderId: "ou_member_1",
          mentionedBot: true,
          text: `@助理 ${sample.text}`,
        });
        if (res.outcome !== "dispatched_to_specialist" && res.outcome !== "replied_by_manager") {
          misroutes += 1;
          continue;
        }
        if (res.jev.fallbackToLead) fallbacks += 1;
        if (res.jev.targetRole !== sample.expectedRole) misroutes += 1;
        const createdTicket = res.ticket !== null;
        if (createdTicket !== sample.expectTicket) misroutes += 1;
      }
    } finally {
      tickets.close();
    }

    const misrouteRate = misroutes / cases.length;
    const fallbackRate = fallbacks / cases.length;
    expect(misrouteRate).toBeLessThan(0.05);
    expect(fallbackRate).toBeLessThan(0.2);
  });
});
