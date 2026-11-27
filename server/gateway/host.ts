import type { PortalEngine } from "../portal/engine.ts";
import { ChannelGatewayEngine, type BotDispatcher } from "./engine.ts";

export interface GatewayHost {
  engine: ChannelGatewayEngine;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): void;
}

/** Composes the resident multi-platform messaging gateway alongside the control-plane server. */
export function createGatewayHost(
  dataDir: string,
  deps: { portal: PortalEngine; dispatchToBot?: BotDispatcher },
): GatewayHost {
  const engine = new ChannelGatewayEngine({
    dataDir,
    portal: deps.portal,
    dispatchToBot: deps.dispatchToBot,
  });
  return {
    engine,
    start: () => engine.start(),
    stop: () => engine.stop(),
    close: () => engine.close(),
  };
}
