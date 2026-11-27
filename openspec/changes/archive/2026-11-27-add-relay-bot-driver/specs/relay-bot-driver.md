# relay-bot-driver

## 需求 1：管理员切到 DeepSeek 后，Bot 回复用 DeepSeek

系统 SHALL 在管理后台启用 DeepSeek 中转站后，让所有 Bot 的新会话走控制面 LLM 代理 → 中转站 → DeepSeek 回复，不再走本地 CLI。CLI 使用能力关闭，不设回退开关。

- 场景：管理员在 `/admin` 保存 DeepSeek 中转站（`deepseek-v4-1-flash`），开关为 `relay_only`，在主界面新建会话发“你好，你现在是什么模型回复你的”。
- 预期：回复来自 DeepSeek，不再是 `GPT-5.6-Sol` 或其他 CLI 模型。

## 需求 2：模型选择器与管理后台一致

系统 SHALL 让主界面模型选择器只显示控制面中转模型，不再列出 CLI 模型。

- 场景：开关为 `relay_only`，打开主界面模型选择器。
- 预期：只看到 `控制面中转 · deepseek-v4-1-flash`（模型名以管理后台当前配置为准），看不到 `GPT-5.6-Sol` 等 CLI 模型。

## 需求 3：Jev 小模型走中转站

系统 SHALL 把 `createJevSmallModel` 生成的小模型传入 `RoutingEngine`，用于 Jev 分流。

- 场景：用 `evals/routing/cases.json`（40 条）复测。
- 预期：误路由 < 5%，回落 < 20%；固定规则仍优先，500 ms 超时、0.6 阈值不变。

## 需求 4：飞书网关回复走中转站

系统 SHALL 把飞书网关的 `dispatchToBot` 从占位回复改成真调用，走同一条中转链路。

- 场景：飞书 DM 给已绑定的 Bot 发消息。
- 预期：回复是中转站生成的真回答，不再是 `[botId] 已收到消息：...`。

## 需求 5：不回退 CLI

系统 SHALL 在中转站失败时直接报错，不切回 CLI。

- 场景：中转站返回 401 / 超时 / 429。
- 预期：前端显示明确错误（`relay_auth_failed` / `relay_timeout` / `relay_unavailable`），不悄悄用 CLI 回复，也不提供 CLI 回退选项。

## 需求 6：租户隔离与计费

系统 SHALL 对每次中转调用使用该租户的临时虚拟令牌，超额度熔断，成本/收入记入用量表。

- 场景：租户 A 的令牌调租户 B 的 Bot。
- 预期：拒绝，401/403。
- 场景：租户当日 token 或费用超限。
- 预期：402，不调上游，不计费，前端显示额度已用完。

## 需求 7：关闭 CLI 不留后门

系统 SHALL 关闭 CLI 使用能力，不设回退开关。

- 场景：中转站长期不可用，需要恢复 CLI。
- 预期：必须另开一个 change 并走 R1，不能在本 change 里悄悄恢复，也不能由单个管理员在后台一键切回。

## 需求 9：飞书私聊写进 Web 界面可见的会话

系统 SHALL 把飞书私聊按 `(bot_id, 飞书 open_id, chat_id)` 映射到一个 thread，消息写进这个 thread，Web 界面能看到。

- 场景：飞书私聊给已绑定的 Bot 发 3 条消息。
- 预期：Web 界面里同一个 thread 出现 3 条用户消息（带来源 `feishu`），顺序与飞书一致，无重复；同一 open_id 不会每次新建 thread。

## 需求 10：模型答案双写到 Web 界面和飞书

系统 SHALL 把模型答案先写进 thread，再由网关发回飞书。

- 场景：飞书私聊发一条消息，模型用中转站思考后回答。
- 预期：Web 界面里该 thread 出现模型答案，飞书也收到同一条答案，内容一致；任一步失败，thread 留失败记录，飞书侧收到“处理失败，请重试”。

## 需求 8：真中转站联调

系统 SHALL 用真实中转站联调验证，不只用 mock。

- 场景：用 `https://www.hi-x.cn`、`deepseek-v4-1-flash` 联调主界面、飞书 DM、Jev 分流各一轮。
- 预期：三轮都通，简单问答 < 3 s；工具调用是否透传 `tool_calls` 如实记录在 handoff 里。
