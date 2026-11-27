# relay-bot-driver Specification Delta

## ADDED Requirements

### Requirement: 管理员切到 DeepSeek 后 Bot 回复走控制面中转
系统 SHALL 在管理后台启用中转站供应商后，让所有 Bot 的新会话经控制面 LLM 代理转发至中转站回复，不再实例化本地 CLI 驱动，也不设 CLI 回退开关。

#### Scenario: 管理员启用 DeepSeek 中转站后发起新会话
- **WHEN** 管理员在 `/admin` 保存并启用 DeepSeek 中转站（默认模型 `deepseek-v4-1-flash`），且用户在主界面新建会话提问
- **THEN** Bot 通过 `RelayDriver` 调用控制面 LLM 代理返回 DeepSeek 回复，不再返回 `GPT-5.6-Sol` 或其他 CLI 模型回复

### Requirement: 主界面模型选择器与管理后台一致
系统 SHALL 让主界面模型选择器仅显示控制面中转模型（`控制面中转 · <defaultModel>`），不再列出本地 CLI 模型；旧会话在下一轮空闲轮次自动切换并提示一次，不中断进行中的轮次。

#### Scenario: 打开主界面模型选择器
- **WHEN** 用户打开主界面模型选择器
- **THEN** 列表仅包含 `控制面中转 · <defaultModel>`，不包含任何 CLI 模型

### Requirement: Jev 小模型接入控制面中转
系统 SHALL 在服务端启动时通过 `llmProxy.createJevSmallModel` 生成小模型并传入 `RoutingEngine`；固定规则仍优先，保持 500 ms 超时与 0.6 置信度阈值，超时或不确定时回落 lead Bot。

#### Scenario: 使用 40 条路由样例集复测
- **WHEN** 运行 `evals/routing/cases.json` 全部 40 条样例
- **THEN** 误路由率小于 5%，回落率小于 20%

### Requirement: 飞书网关回复走控制面中转
系统 SHALL 将 `ChannelGatewayEngine` 的默认 `dispatchToBot` 改为调用 `RelayDriver.runTurn`，保持既有绑定表、租户校验、白名单和身份映射不变。

#### Scenario: 飞书私聊发送消息给已绑定 Bot
- **WHEN** 已绑定租户和白名单的飞书用户向 Bot 发送私聊消息
- **THEN** 网关经中转站生成真实回答并回复飞书，不再返回 `[botId] 已收到消息` 占位回复

### Requirement: 中转站失败时直接报错不回退 CLI
系统 SHALL 在中转站鉴权失败、超时或不可用时返回明确错误码（`relay_auth_failed`、`relay_timeout`、`relay_unavailable`），禁止静默回退到本地 CLI。

#### Scenario: 中转站返回 401、超时或 429
- **WHEN** 中转站上游返回 401/403、请求超时或返回 429/5xx
- **THEN** 驱动直接报错并透出对应错误码，不调用任何 CLI 驱动

### Requirement: 租户虚拟令牌隔离与额度熔断
系统 SHALL 为每次中转调用签发或校验租户级临时虚拟令牌，拒绝跨租户令牌调用，并在租户超额时返回 402 熔断且不调上游、不计费。

#### Scenario: 跨租户令牌调用或超额度熔断
- **WHEN** 租户 A 的令牌用于调用租户 B 的 Bot，或租户当日用量达到上限
- **THEN** 跨租户调用返回 403 拒绝；超额度调用返回 402 且不发起上游请求、不增加用量记录

### Requirement: 关闭 CLI 不留后台回退后门
系统 SHALL 在运行时关闭全部本地 CLI 驱动，不在本变更内提供管理员一键切回 CLI 的开关；如需恢复 CLI 须另开变更并经 R1 确认。

#### Scenario: 检查运行时驱动注册表
- **WHEN** 服务启动并初始化 `ProviderRegistry`
- **THEN** 注册表中仅存在 `relay` 驱动，不存在 `claude`、`codex`、`grok` 等 CLI 驱动实例

### Requirement: 真中转站联调验证
系统 SHALL 使用真实中转站（`https://www.hi-x.cn`，`deepseek-v4-1-flash`）联调主界面 Bot、飞书 DM 与 Jev 分流各一轮，并在 `handoff.md` 如实记录耗时与 `tool_calls` 透传情况。

#### Scenario: 真实中转站三链路联调
- **WHEN** 使用真实中转站配置依次执行主界面问答、飞书 DM 与 Jev 分流
- **THEN** 三条链路均通过验证，并记录实际耗时及 `tool_calls` 透传结论

### Requirement: 飞书私聊映射并写入 Web 可见会话
系统 SHALL 按 `(bot_id, feishu_open_id, chat_id)` 将飞书私聊映射到唯一的 Web `thread_id`，重复投递按 `event_id` 去重，同一 thread 按 `create_time` 串行处理，且用户消息带来源标记 `feishu` 写入该 thread。

#### Scenario: 飞书私聊连续发送 3 条消息
- **WHEN** 同一飞书用户向已绑定 Bot 连续发送 3 条私聊消息（含重复事件）
- **THEN** 仅复用同一个 Web thread，按顺序写入 3 条带 `source: "feishu"` 的用户消息且无重复、无并发模型调用

### Requirement: 模型答案双写到 Web 会话与飞书
系统 SHALL 将模型答案先写入映射的 Web thread，再由网关发回飞书；任一步失败时在 thread 记录失败信息并向飞书回复“处理失败，请重试”。

#### Scenario: 飞书私聊正常回复与失败降级
- **WHEN** 模型通过中转站生成答案，或模型/发送环节发生异常
- **THEN** 正常时先写入 Web thread 再发回飞书且内容一致；失败时 thread 留存失败记录且飞书收到“处理失败，请重试”
