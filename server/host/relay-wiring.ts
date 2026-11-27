import type { AnyProviderDriver, InstanceConfigMap, ModelSelection } from "../contracts.ts";
import {
  createRelayProviderDriver,
  RELAY_DRIVER_KIND,
  RELAY_INSTANCE_ID,
  relayModelLabel,
  resolveActiveRelayModel,
} from "../drivers/relay.ts";
import type { ControlPlaneLlmProxy } from "../llm-proxy/engine.ts";

export interface RelayMigratableStore {
  bot(id: string): { id: string; name: string; modelSelection: ModelSelection } | null | undefined;
  taskByThread(botId: string, threadId: string): { threadId: string; modelSelection?: ModelSelection } | null | undefined;
  patchBot(id: string, patch: { modelSelection: ModelSelection }): unknown;
  patchTask(botId: string, threadId: string, patch: { modelSelection?: ModelSelection }): unknown;
  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } },
  ): unknown;
}

export interface RelayWiring {
  readonly drivers: readonly AnyProviderDriver[];
  attachProxy(proxy: ControlPlaneLlmProxy): void;
  getProxy(): ControlPlaneLlmProxy | null;
  providerConfigs(): InstanceConfigMap;
  activeSelection(): ModelSelection;
  migrateLegacyCliSelection(
    store: RelayMigratableStore,
    botId: string,
    threadId: string,
    isBusy: boolean,
  ): boolean;
}

/**
 * Control-plane relay-only wiring for OpenMausBot:
 * - Disables all local CLI drivers from ProviderRegistry (no CLI fallback or switch).
 * - Exposes only the single `relay` instance whose catalog dynamically reads defaultModel from admin config.
 * - Automatically migrates legacy CLI sessions on their next idle turn with a one-time notice,
 *   never interrupting an in-progress turn.
 */
export function createRelayWiring(options?: { defaultTenantId?: string }): RelayWiring {
  let activeProxy: ControlPlaneLlmProxy | null = null;
  const relayDriver = createRelayProviderDriver(() => activeProxy, {
    defaultTenantId: options?.defaultTenantId ?? "tenant_default",
  });
  const drivers: readonly AnyProviderDriver[] = [relayDriver];

  const activeSelection = (): ModelSelection => ({
    instanceId: RELAY_INSTANCE_ID,
    model: resolveActiveRelayModel(activeProxy) ?? "deepseek-chat",
  });

  return {
    drivers,
    attachProxy(proxy: ControlPlaneLlmProxy) {
      activeProxy = proxy;
    },
    getProxy() {
      return activeProxy;
    },
    providerConfigs(): InstanceConfigMap {
      return {
        [RELAY_INSTANCE_ID]: {
          driver: RELAY_DRIVER_KIND,
          displayName: "控制面中转",
          enabled: true,
          config: {},
        },
      };
    },
    activeSelection,
    migrateLegacyCliSelection(
      store: RelayMigratableStore,
      botId: string,
      threadId: string,
      isBusy: boolean,
    ): boolean {
      if (isBusy) return false;
      const bot = store.bot(botId);
      if (!bot) return false;
      const task = store.taskByThread(botId, threadId);
      const botNeedsMigration = bot.modelSelection.instanceId !== RELAY_INSTANCE_ID;
      const taskNeedsMigration =
        task?.modelSelection !== undefined && task.modelSelection.instanceId !== RELAY_INSTANCE_ID;

      if (!botNeedsMigration && !taskNeedsMigration) {
        const currentModel = resolveActiveRelayModel(activeProxy);
        if (currentModel && bot.modelSelection.model !== currentModel) {
          store.patchBot(botId, { modelSelection: { instanceId: RELAY_INSTANCE_ID, model: currentModel } });
        }
        return false;
      }

      const nextSelection = activeSelection();
      if (botNeedsMigration) {
        store.patchBot(botId, { modelSelection: nextSelection });
      }
      if (task && taskNeedsMigration) {
        store.patchTask(botId, threadId, { modelSelection: undefined });
      }
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: {
          name: `notice: 该会话已自动切换至控制面中转模型（${relayModelLabel(nextSelection.model)}），本地 CLI 驱动已停用。`,
          ok: true,
        },
      });
      return true;
    },
  };
}
