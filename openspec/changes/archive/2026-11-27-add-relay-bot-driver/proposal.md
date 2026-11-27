# add-relay-bot-driver

## 背景

add-unified-login 的设计目标是：所有 Bot 经控制面 LLM 代理走第三方中转 DeepSeek，不再走本地 CLI。
add-admin-llm-config 把中转站的 Key、模型、定价、租户额度放进了管理后台。

2026-11-27 实测发现目标没有达成：

- 管理后台已保存 DeepSeek 中转站，`https://www.hi-x.cn`，默认模型 `deepseek-v4-1-flash`，连通性正常（228 ms）。
- OpenMausBot 前端里的 Bot 仍回答为 `GPT-5.6-Sol`，即仍走 Codex CLI 驱动。
- 按 main `ed3179f` 代码核对：
  - `server/index.ts` 里没有调用 `createJevSmallModel`；
  - `server/routing/host.ts` 创建 `RoutingEngine` 时没有传 `smallModel`；
  - `server/gateway/engine.ts` 的默认 `dispatchToBot` 仍是占位回复 `[botId] 已收到消息：...`；
  - 中转代理只暴露为 `/api/llm/v1/chat/completions` 接口，没有被回答链路调用。

用户在 2026-11-27 17:03 确认的原则：**一旦管理员在后台切到第三方中转站 API Key，所有用户就应该切换成 DeepSeek，而不是 CLI。管理员管理的模型是 Bot 回复的唯一事实来源。**

## 目标

1. 新增一个中转驱动（Relay Driver），与现有 CLI 驱动实现同一轮次接口，让 Bot 的回答可以直接走控制面 LLM 代理 → 中转站 → DeepSeek。
2. 关闭 CLI 使用能力，统一走中转站：删除模型来源的 CLI 选项，主界面模型选择器不再提供 CLI 模型，只显示控制面中转模型；Bot 轮次不再实例化 CLI 驱动。
3. 把 Jev 小模型接进中转站：`RoutingEngine` 传入 `createJevSmallModel` 生成的小模型。
4. 把飞书网关的 `dispatchToBot` 从占位回复改成真调用，走同一条中转链路。
5. 飞书私聊与 Web 界面同看一个会话：飞书来的每条消息写进 Web 界面可见的 thread，模型答案先写进这个 thread，再由网关发回飞书。
6. 保留租户隔离与计费：每次调用都用租户临时虚拟令牌，超额度熔断，成本/收入记入 `llm_usage_daily`。

## 飞书-Web 同步（2026-11-27 17:38 用户确认合并进本 change）

用户要求：即使辣条加不进飞书群，也要在飞书私聊里与辣条对话时，发送的消息显示在 Web 应用界面，模型同时用中转站思考，返回的答案也同步到飞书。

流程：

```
飞书私聊发消息
  → 网关收到
  → 消息写进 Web 界面可见的 thread（按 Bot + 飞书 open_id 映射）
  → 模型用中转站思考
  → 答案先写进这个 thread（Web 界面能看到）
  → 网关把答案发回飞书
```

## 非目标

- 不做多供应商负载均衡（仍以管理后台启用的主供应商为准）。
- 不做 BYOK（客户自带 Key）。
- 不改定价表、审批四层、Ticket、隔离、网关绑定表。
- 不改中转站地址、Key 的存储方式（仍在 Vault）。

## 验收

见 `specs/relay-bot-driver.md`，共 8 组验收，重点是：

- 管理员切到 DeepSeek 后，新会话的 Bot 回复确实来自 DeepSeek，且模型选择器不再能选 CLI 模型。
- 超额度、Key 失效、中转站不可达时有明确错误，直接报错，不切回 CLI。
- 跨租户令牌不能互相调用。
