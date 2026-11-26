import { join } from "node:path";

import { createTicketRoutes } from "../routes/tickets.ts";
import type { RouteHandler } from "../routes/table.ts";
import { TicketEngine } from "./engine.ts";

export interface TicketHost {
  engine: TicketEngine;
  routes: RouteHandler;
  observeWebhook: (input: {
    webhookId: string;
    webhookName: string;
    deliveryId: string;
    prompt: string;
    botId: string;
    byPerson?: boolean;
  }) => void;
  close: () => void;
}

export function createTicketHost(dataDir: string): TicketHost {
  const engine = new TicketEngine({ dbPath: join(dataDir, "tickets.sqlite") });
  return {
    engine,
    routes: createTicketRoutes({ tickets: engine }),
    observeWebhook: (input) => {
      if (input.byPerson === true) return;
      try {
        engine.intakeExternalWebhook(input);
      } catch (error) {
        console.error("tickets: webhook observe intake failed", error);
      }
    },
    close: () => engine.close(),
  };
}
