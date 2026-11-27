# add-relay-bot-driver — 任务

基线：main `ed3179f`。预计 2–3 周。

## Step 0 — 复用盘点（先做，不要跳过）

本地在 `/Users/latiao/OpenMausBot` 里确认以下内容，文件名、函数名以实测为准，包里的名字只是推测：

- [x] 0.1 列出 `server/drivers/` 下的驱动文件，确认 CLI 驱动（claude / codex / grok）的轮次接口名与签名。
- [x] 0.2 确认工具执行入口：中转驱动拿到 `tool_calls` 后，调哪个现有函数执行工具。
- [x] 0.3 确认 `server/index.ts` 里 `createLlmProxyHost` / `createRoutingHost` / `createPortalHost` 的调用位置与依赖注入方式。
- [x] 0.4 确认 `server/llm-proxy/engine.ts` 的 `chatCompletions` 返回结构（是否含 `usage`、`tool_calls`）、`createJevSmallModel` 的签名、`issueVirtualToken` 的默认值。
- [x] 0.5 确认主界面模型选择器的数据来源文件（`src/` 下），确认它现在从哪里读模型列表。
- [x] 0.6 确认 `server/gateway/engine.ts` 的 `dispatchToBot` 注入点，确认 `server/index.ts` 里网关的创建位置。

## Step 1 — 中转驱动

- [x] 1.1 新建 `server/drivers/relay.ts`，实现与 CLI 驱动同一轮次接口，进程内调 `proxy.chatCompletions`。
- [x] 1.2 模型名每次从已启用主供应商取 `defaultModel`，不写死。
- [x] 1.3 实现工具调用循环：解析 `tool_calls` → 调现有工具执行入口 → 结果回传模型，最多 8 轮。
- [x] 1.4 错误映射：401/403 → `relay_auth_failed`；超时 → `relay_timeout`；429/5xx → `relay_unavailable`；超额度 → 402 不计费。
- [x] 1.5 单元测试 `server/drivers/relay.test.ts`：mock 代理，覆盖文本回复、工具调用一轮、超额度、401、超时。

## Step 2 — 关闭 CLI

- [x] 2.1 关闭 CLI 使用能力：Bot 轮次不再实例化 CLI 驱动，CLI 驱动代码保留但不可达。
- [x] 2.2 主界面模型选择器只显示 `控制面中转 · <defaultModel>`；旧会话新一轮自动切到中转模型并提示一次。
- [x] 2.3 隔离测试：新会话走中转，旧进行中轮次不中途切换；模型选择器里找不到任何 CLI 模型。

## Step 3 — Jev 小模型接线

- [x] 3.1 `server/index.ts` 启动时用 `llmProxy.createJevSmallModel(tenantId)` 生成小模型。
- [x] 3.2 `createRoutingHost` 增加可选 `smallModel` 参数，透传给 `RoutingEngine`。
- [x] 3.3 固定规则仍优先，500 ms 超时、0.6 阈值不变，超时回落 lead Bot。
- [x] 3.4 用 `evals/routing/cases.json`（40 条）复测：误路由 < 5%，回落 < 20%。

## Step 4 — 飞书网关接线

- [x] 4.1 `server/gateway/engine.ts` 的默认 `dispatchToBot` 从占位回复改成真调用 `RelayDriver.runTurn`。
- [x] 4.2 绑定表、租户校验、白名单、身份校验保持不变。
- [x] 4.3 隔离测试：飞书 DM 发消息，网关收到后经中转站回复，不再是 `[botId] 已收到消息`。

## Step 5 — 主界面 Bot 接线

- [x] 5.1 Bot 轮次固定用 `RelayDriver`，不再有驱动选择分支。
- [x] 5.2 中转站失败时直接报错，不回退 CLI。
- [x] 5.3 隔离测试：新会话回复来自 DeepSeek，模型选择器里没有 CLI 模型。

## Step 6 — 飞书-Web 同步

- [x] 6.1 新增映射表：`(bot_id, feishu_open_id, chat_id) → thread_id`，网关收到私聊时查表，没有就新建 thread，有就复用。
- [x] 6.2 网关收到消息先写进 thread（带来源 `feishu`），Web 界面刷新后能看到这条用户消息。
- [x] 6.3 模型答案先写进 thread，再由网关发回飞书；任一步失败，thread 留失败记录，飞书侧发“处理失败，请重试”。
- [x] 6.4 按飞书 `event_id` 去重，同一 thread 按 `create_time` 串行处理，不并发调模型。
- [x] 6.5 隔离测试：飞书发 3 条消息，Web 界面看到 3 条用户消息 + 3 条模型答案，飞书也收到 3 条答案，顺序一致，无重复。

## Step 7 — 真中转站联调

- [x] 6.1 用真实中转站（`https://www.hi-x.cn`，`deepseek-v4-1-flash`）联调：主界面 Bot 一轮问答、飞书 DM 一轮、Jev 分流一轮。
- [x] 6.2 记录首 token 耗时与完整耗时，简单问答目标 < 3 s。
- [x] 6.3 记录工具调用是否透传 `tool_calls`；不透传则在 handoff 里明确写明，并标注受影响的 Bot。

## Step 8 — 回归与验收

- [x] 7.1 `vitest run` 全过，`oxlint --deny-warnings` 0，`tsc -b` 0，`vite build` 通过。
- [x] 7.2 `openspec validate --all --strict --no-interactive` 全过。
- [x] 7.3 隔离 e2e：管理员切 DeepSeek → 新会话回复 DeepSeek；超额度 → 402；Key 失效 → 明确错误；跨租户令牌 → 拒绝。
- [x] 8.4 按 `specs/relay-bot-driver.md` 逐条验收并记录结果（共 10 组）。

## Step 9 — 归档与推送

- [x] 8.1 `openspec archive add-relay-bot-driver`，验证后按维护者最终审计结果推送到 `origin/main`。
- [x] 8.2 handoff 里如实记录：真中转站联调结果、工具调用透传情况、耗时、未覆盖项。
