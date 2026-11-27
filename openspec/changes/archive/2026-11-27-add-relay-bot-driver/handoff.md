# add-relay-bot-driver — handoff

- 编号与版本：`add-relay-bot-driver` v1（含 2026-11-27 17:43 合并的飞书-Web 同步）
- 主执行者：Antigravity
- 授权状态及出处：R1 已确认；维护者于 2026-11-27 19:26 最终审核通过并批准归档推送 `origin/main`
- 分支与基线：`main`，基线 `ed3179f`
- 最近验证：Vitest 89/89 全通过、`oxlint --deny-warnings` 0 错 0 警、`tsc --noEmit` 0 错、`vite build` 通过、`openspec validate --all --strict --no-interactive` 13/13 通过；真中转站（`https://www.hi-x.cn/v1`，`deepseek-v4-1-flash`）四项实测全部通过
- 阻塞或下一步：已归档并推送 `origin/main`

## 已完成文件清单

- `server/llm-proxy/engine.ts` / `server/llm-proxy/routes.ts`：扩展 OpenAI `tools` / `tool_calls` / `tool_call_id` 兼容、保留上游 HTTP 状态码（`upstreamStatus`）、支持 `expectedTenantId` 跨租户虚拟令牌拦截（403 `tenant_mismatch`）与超时错误映射。
- `server/drivers/relay.ts`：新增进程内中转驱动 `RelayDriver`（动态读取启用主供应商 `defaultModel`、最多 8 轮工具调用循环、错误映射 `relay_auth_failed` / `relay_timeout` / `relay_unavailable` / `relay_quota_exceeded`）与 `createRelayProviderDriver`（实现 `ProviderDriver`/`ProviderAdapter.sendTurn`，目录仅暴露 `控制面中转 · <defaultModel>`，复用 `mountChatTools`）。
- `server/host/relay-wiring.ts`：运行时关闭全部 CLI 驱动（仅注册 `relay` 驱动，无 CLI 回退开关），提供旧 CLI 会话空闲自动迁移与一次性提示（不中断进行中轮次）。
- `server/routing/host.ts`：`createRoutingHost` 支持透传可选 `smallModel` 与 `jevTimeoutMs`。
- `server/gateway/thread-sync.ts`：新增 `feishu_thread_mappings` SQLite 映射表 `(bot_id, feishu_open_id, chat_id) -> thread_id`、按 `create_time` 串行队列及 `createStoreThreadSink`。
- `server/gateway/engine.ts` / `server/gateway/host.ts` / `server/portal/host.ts`：默认 `dispatchToBot` 改为调用 `RelayDriver.runTurn`；飞书私聊先写用户消息（`source: "feishu"`）进 Web thread → 调中转模型 → 先写模型答案进 thread 再发回飞书；任一步失败在 thread 记失败记录并向飞书回复“处理失败，请重试”；原子 `event_id` 去重。
- `server/index.ts`：接入 `relayWiring`、`createStoreThreadSink(store)` 与 `createRoutingHost(tickets.engine, { smallModel: portal.llmProxy.engine.createJevSmallModel("tenant_default") })`（保持 15,276 行不触发文件大小棘轮）。
- `packages/phone-protocol/src/wire.ts`：`WireMessage` 增加可选 `source?: "feishu" | "weixin" | "web"`（保持 1,000 行）。
- `openspec/changes/add-relay-bot-driver/specs/relay-bot-driver/spec.md`：补齐 OpenSpec 严格校验格式（10 条 `ADDED Requirements`）。
- `scripts/verify-relay-live.ts`：Step 7 隔离真中转站联调脚本（使用临时目录，不触碰真实用户数据）。
- 测试文件：`server/drivers/relay.test.ts`、`server/host/relay-wiring.test.ts`、`server/gateway/gateway-relay-sync.test.ts`、`server/host/relay-e2e.test.ts`。

## Step 7 真中转站联调实测（2026-11-27，隔离临时目录）

- 目标中转站：`https://www.hi-x.cn/v1`，请求模型：`deepseek-v4-1-flash`（实测响应模型：`deepseek-v4-1-flash-261017`）
- **1/4 主界面 Bot 问答**：完整耗时 **1628 ms**（< 3 s 目标，v1 非流式完整返回）
- **2/4 飞书 DM 链路**：完整耗时 **1260 ms**（< 3 s 目标），`status=routed`，回复 `联调成功`
- **3/4 Jev 小模型分流**：完整耗时 **65 ms**，`outcome=replied_by_manager`，模糊消息正确回落 `bot_chief_of_staff`（`lead`）
- **4/4 `tool_calls` 透传探测**：完整耗时 **2481 ms**，**`passthrough=true`**，`rounds=2`，`toolCallsExecuted=1`，模型正确触发 `check_inventory(SKU-102)` 并结合工具返回 `42` 生成最终答复（无受影响 Bot 需降级）

## 逐条验收记录（Step 8.4，对照 `specs/relay-bot-driver.md` 10 组）

| 需求 | 验收方式 | 结果 |
| --- | --- | --- |
| 需求 1：切 DeepSeek 后 Bot 走中转回复 | `relay-e2e.test.ts` + Step 7 真中转站实测（1628 ms） | 通过 |
| 需求 2：模型选择器仅显示 `控制面中转 · <defaultModel>` | `relay-wiring.test.ts` + `relay-e2e.test.ts` | 通过 |
| 需求 3：Jev 小模型走中转站 | `relay-wiring.test.ts`（40 条 `cases.json`，误路由 < 5%、回落 < 20%）+ Step 7 实测（65 ms） | 通过 |
| 需求 4：飞书网关走中转站 | `gateway-relay-sync.test.ts` + Step 7 实测（1260 ms） | 通过 |
| 需求 5：中转失败直接报错不回退 CLI | `relay.test.ts` + `relay-wiring.test.ts` + `relay-e2e.test.ts`（401/超时/429） | 通过 |
| 需求 6：租户虚拟令牌隔离与 402 额度熔断 | `relay.test.ts` + `relay-e2e.test.ts`（403 跨租户拒绝、402 不调上游不计费） | 通过 |
| 需求 7：关闭 CLI 不留回退开关 | `relay-wiring.ts` + `relay-wiring.test.ts`（注册表无 `codex`/`claude`/`grok`） | 通过 |
| 需求 8：真中转站联调与 `tool_calls` 记录 | Step 7 `scripts/verify-relay-live.ts` 四项实测全通过，`tool_calls` 透传为 `true` | 通过 |
| 需求 9：飞书私聊映射并写入 Web thread | `gateway-relay-sync.test.ts`（3 条消息复用单 thread、`source: "feishu"`、去重、串行有序） | 通过 |
| 需求 10：模型答案先写 thread 再发回飞书 | `gateway-relay-sync.test.ts`（双写顺序断言 + 失败留记录并回复“处理失败，请重试”） | 通过 |

## 未覆盖项说明

- v1 采用非流式完整回复（按 `design.md §3` 约定），因此记录的是完整耗时（1260–1628 ms，均 < 3 s）；流式首 token 优化留待后续迭代。
- 飞书群聊同步与 Web 界面反向代发飞书按 `design.md §8.4` 不在本变更范围。
