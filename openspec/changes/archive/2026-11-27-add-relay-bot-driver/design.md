# add-relay-bot-driver — 设计

## 1. 现状与缺口（Step 0 结论，基线 main `ed3179f`）

| 环节 | 现状 | 缺口 |
| --- | --- | --- |
| 中转代理 | `server/llm-proxy/engine.ts`：`ControlPlaneLlmProxy`，`chatCompletions`、`createJevSmallModel`、`issueVirtualToken`、`registerProvider` 已有；`server/llm-proxy/routes.ts`：`/api/llm/v1/chat/completions`、`/api/llm/v1/models`、`/api/llm/health` 已有 | 只有接口，没有调用方 |
| Jev 分流 | `server/routing/jev.ts`：固定规则 + 可选小模型，500 ms 超时，0.6 阈值 | `server/routing/host.ts`：`new RoutingEngine({ tickets })`，没有传 `smallModel` |
| 飞书网关 | `server/gateway/engine.ts`：按绑定表路由、租户校验、白名单校验已有 | 默认 `dispatchToBot` 是占位回复，没有真 Bot 调用 |
| 主界面 Bot | 每个 Bot 有自己的模型选择器，走本地 CLI 驱动（claude / codex / grok） | 模型选择器与管理后台配置完全脱节 |
| 管理后台 | `add-admin-llm-config`：供应商、定价、租户额度已可配置 | 没有“模型来源”开关，管理员无法一键切断 CLI |

## 2. 设计原则

1. **管理员配置是唯一事实来源。** Bot 回复用哪个模型，不由每个 Bot 的本地选择器决定，由管理后台的供应商配置 + 模型来源开关决定。
2. **中转驱动与 CLI 驱动同接口。** 新增驱动只替换“模型调用”这一层，不重写轮次管理、会话、工具执行、审批、Ticket。
3. **关闭 CLI，不回退。** CLI 使用能力关闭后，中转站失败时直接报错，绝不悄悄切回 CLI 让用户以为还在用 DeepSeek，也不再提供 CLI 回退选项。
4. **租户隔离在令牌层。** 每次调用都用该租户的临时虚拟令牌，令牌里嵌预算与工具白名单，超限直接拒绝，不先调用再记账。

## 3. 新增：中转驱动 `server/drivers/relay.ts`

新建文件（Step 0 先确认本地 driver 的轮次接口名，文件名以实测为准）：

```ts
// server/drivers/relay.ts
export interface RelayDriverOptions {
  proxy: ControlPlaneLlmProxy;
  tenantId: string;
  botId: string;
}

export class RelayDriver {
  // 与 CLI 驱动同一轮次接口：接收消息历史 + 工具定义，返回回复 + 工具调用
  async runTurn(input: TurnInput): Promise<TurnResult>;
}
```

关键点：

- **进程内调用，不走 HTTP 回环。** 同一个 harness 进程内直接调 `proxy.chatCompletions(virtualToken, request)`，避免 `127.0.0.1:8799` 回环与额外鉴权。VM 内的 Bot 仍走 HTTP `/api/llm/v1/chat/completions`，用虚拟令牌。
- **模型名来自管理后台，不是写死的。** 每次调用前从 `proxy.listProviders()` 取已启用的主供应商的 `defaultModel`；`fastModel` 只给 Jev 小模型用。
- **工具调用循环。** 中转站返回 OpenAI 兼容的 `tool_calls` 时，按现有工具执行入口逐个执行，执行结果再发回模型，最多循环 8 次，超限则交回人工。只读巡检、采购、支付等工具仍受原有白名单与审批约束，中转驱动不放宽任何工具权限。
- **流式与非流式。** v1 先做非流式完整回复（`chatCompletions` 现有接口），前端以“工作了 N 秒”一次性展示；流式作为后续优化，不阻塞本 change。
- **错误映射。** 中转站 401/403 → `relay_auth_failed`；超时（> 30 s）→ `relay_timeout`；429/5xx → `relay_unavailable`；超租户额度 → `relay_quota_exceeded`（402，不产生计费）。

## 4. 模型来源开关

关闭 CLI 使用能力，不设回退开关：

- Bot 轮次不再实例化 CLI 驱动，CLI 驱动代码保留但不可达（后续清理时再删）。
- 主界面模型选择器只显示一个选项：`控制面中转 · <defaultModel>`；CLI 模型（GPT-5.6-Sol 等）不再列出，已选 CLI 模型的旧会话在新一轮开始时自动切到中转模型，并提示一次。
- 本 change 不再新增 `relay_only` / `cli_fallback` 开关；关闭 CLI 本身是一次性决定，不需要开关来回切。
- 若中转站长期不可用，恢复 CLI 需要另开一个 change 并走 R1，不在本 change 里留后门。

## 5. 接线点（共 3 处）

### 5.1 Jev 小模型

`server/index.ts`（或 `server/routing/host.ts` 的调用方）启动时：

```ts
const jevSmallModel = llmProxy.createJevSmallModel(tenantId);
const routing = createRoutingHost(tickets, { smallModel: jevSmallModel });
```

`createRoutingHost` 增加可选参数 `smallModel`，透传给 `RoutingEngine`。固定规则仍优先，小模型只在规则不匹配时调用，500 ms 超时、0.6 阈值不变。

### 5.2 飞书网关 `dispatchToBot`

`server/gateway/engine.ts` 的默认 `dispatchToBot` 从占位回复改为真调用：

```ts
dispatchToBot: async (req) => {
  const driver = new RelayDriver({ proxy: llmProxy, tenantId: req.tenantId, botId: req.botId });
  return driver.runTurn({ text: req.text, chatId: req.chatId, senderId: req.senderId });
}
```

网关的绑定表、租户校验、白名单、身份校验保持不变，只换最后一公里的调用。

### 5.3 主界面 Bot 轮次

Bot 轮次的驱动选择逻辑改为：

```ts
// CLI 已关闭：不再有 relayMode 分支，不再实例化 CLI 驱动
driver = new RelayDriver({ proxy, tenantId, botId });
```

正在进行中的轮次不中途切换；新轮次按当前开关取值。

## 6. 计费与熔断（复用 add-admin-llm-config）

- 每次调用前发虚拟令牌，令牌默认 200,000 token/天、$50/天（已有默认值），管理后台可按租户改。
- `chatCompletions` 已有计费逻辑（成本价/售价、用量表），中转驱动不重复记账，只传令牌。
- 超额度 → 402，不调上游，不计费，前端显示“今日模型额度已用完，请联系管理员”。
- Key 轮换后，已发出的虚拟令牌不受影响（已有行为），新令牌用新 Key。

## 7. 回滚

- 本 change 没有开关可回滚；若中转驱动本身有 bug，修复中转驱动或修复中转站配置，不切回 CLI。
- 若确实需要恢复 CLI，必须另开一个 change 并走 R1，不能悄悄恢复。

## 8. 飞书私聊与 Web 界面同看一个会话

### 8.1 映射

- 一个会话由 `(bot_id, 飞书 open_id, chat_id)` 唯一确定，映射到 harness 里的一个 thread。
- 网关收到飞书私聊时，先按这个三元组查 thread，没有就新建一个，有就复用，绝不每次新建。
- MVP1 的白名单/路由 JSON 里“每个 open_id 指向独立目标会话”的规则保留，改成由网关在 DB 里维护映射表，不再用本地 JSON 文件。

### 8.2 双写顺序

1. 网关收到飞书消息，先把用户消息写进 thread（Web 界面立刻能看到，用户消息带来源标记 `feishu`）。
2. 再调中转驱动思考，思考中 thread 显示“正在思考”状态。
3. 模型答案先写进 thread（Web 界面能看到），再由网关发回飞书。
4. 任何一步失败，thread 里留一条失败记录，飞书侧发一条“处理失败，请重试”，不静默丢消息。

### 8.3 去重与顺序

- 按飞书 `event_id` 去重（网关已有 `gateway_events` 表），重复投递只写一次。
- 同一个 thread 的消息按 `create_time` 串行处理，不并发调模型，避免回复乱序。

### 8.4 不做的事

- 群聊不同步进本 change：群聊要先开群消息接收权限 + 对外共享发布，不在本 change 范围。
- Web 界面里不能直接以飞书身份发消息回飞书：Web 界面是只看 + 审计，回复仍由飞书侧触发。

## 9. 风险

- **工具调用能力下降。** CLI 驱动（Codex / Claude）原生支持复杂的工具循环与文件操作，中转 DeepSeek 的工具调用能力取决于中转站是否透传 `tool_calls`。v1 先保证文本回复与 Jev 分流，工具调用循环要以隔离测试为准，不通过则该 Bot 仍走 CLI 并明确标注。
- **延迟。** 中转站多一跳，首 token 会比本地 CLI 慢，实测目标：简单问答 < 3 s。
- **模型幻觉差异。** DeepSeek 与 GPT-5.6-Sol 的回答风格、工具调用格式不同，验收要以真实中转站联调为准，不以 mock 为准。
