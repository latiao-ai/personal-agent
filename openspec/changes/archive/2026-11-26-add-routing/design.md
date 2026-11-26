# Design: add-routing（路由，MVP3）

- Change: `add-routing`
- 阶段：MVP3，MVP2b 之后、MVP4 之前
- 时间：1 周

## 1. 架构图（文字版）

```
飞书群聊（只响应 @ 机器人）
  │ 群消息 + @
  │ 先过滤：发送者是 Bot 自己？ → 是，丢掉，不触发路由
  ▼
┌──────────────────────────────────────────────┐
│  门口 Jev（快分流，几百毫秒）                   │
│  复用：docs/decision-model.md                  │
│       server/ask-routing.ts                    │
│       local-routing.ts                         │
│       room-routing-members.ts                  │
│                                              │
│  小模型 + 固定规则，派给哪个 Manager Bot        │
│  不确定 → 回落到 lead bot                       │
│  不做工单、不做审批                            │
└──────────────────────────────────────────────┘
  │ 派给 Manager Bot（Chief of Staff）
  ▼
┌──────────────────────────────────────────────┐
│  里面 Router（Router-Worker）                  │
│  复用：server/chief-of-staff.ts                │
│                                              │
│  判断是不是新活：                              │
│    ├─ 闲聊 / 问答 → 不生成 Ticket，直接回       │
│    ├─ 副作用工作 → 生成 Ticket                 │
│    │    （复用 MVP2a TicketEngine）            │
│    │    → 派给采购 / 下单 / 跟单 Bot           │
│    └─ 外部事件 → 生成 Ticket，默认 observe      │
│                                              │
│  Specialist 不直接回群，只能通过 Manager Bot 回 │
│  转手上限 max_hops = 4，超了交回给人            │
└──────────────────────────────────────────────┘
  │ 生成的 Ticket 照常走 MVP2b 审批
  ▼
控制面：Ticket 存储、审批记录、审计日志（MVP2a / MVP2b 已有）
```

**读图规则**：门口只管“派给谁”，里面只管“是不是新活、派给哪个 Specialist”。门口不做工单，里面不做审批，审批还是 MVP2b 的事。

## 2. 借鉴谁

- **OpenMausBot Jev**：快决策模型，在房间设为 Auto 时，几百毫秒选哪个 Bot 回每条未 @ 的消息，回落到 lead bot；作为 Chief of Staff 时，唤醒队友并分配模型。
- **DeepSeek Super Agent**：Router-Worker，Router 生成 Ticket，Worker 执行。
- **Hermes**：profile-based message routing，单网关拥有所有会话。

## 3. 关键决定

### 3.1 门口 Jev：快分流

- 小模型，几百毫秒，目标是“快”，不是“准到 100%”。
- 先用固定规则 + 小模型：规则先拦（例如“查库存”→ 采购 Bot，“跟工厂”→ 跟单 Bot），规则拦不住的，再让小模型判。
- 不确定回落到 lead bot，不要瞎派。回落率要量，见 3.5。
- 不做工单：门口不生成 Ticket，只派给 Manager Bot。生成 Ticket 是里面 Router 的事。
- 不做复杂模型选择：先用固定规则 + 小模型，不做多模型比选、不做动态模型切换。

### 3.2 里面 Router：是不是新活

| 输入 | 是不是新活 | 怎么做 |
|---|---|---|
| 闲聊 / 问答 / 查询 | 否 | 不生成 Ticket，Manager Bot 直接回 |
| 副作用工作：写数据、发消息、花钱、长任务 | 是 | 生成 Ticket（复用 MVP2a `TicketEngine`），派给采购 / 下单 / 跟单 Bot |
| 会话中途要做副作用事 | 是（中途生成） | 同上 |
| 外部事件：新订单、库存变化、Webhook | 是，默认 observe | 生成 Ticket，状态 `observe`，只记录不执行 |

判断规则写死在代码里，不要让模型判断“这句要不要生成 Ticket”。复用 MVP2a 的确定性分类器（`server/tickets/classifier.ts`，严禁调用模型）。

### 3.3 Specialist 不直接回群

- Specialist 只能通过 Manager Bot 回，不能直接在群里说话。
- 转手上限 `max_hops = 4`：Manager → Specialist → Manager → Specialist，最多 4 次，超了交回给人。
- 每次转手都要记 hop 数，记在 Ticket 里，方便审计。

### 3.4 飞书群聊规则：先只响应 @

- 先只响应 @ 机器人，不监听全部群消息。
- 监听全部群消息需要更多权限，成本也更高，等 MVP3 跑通后再评估。
- 飞书群聊需要新的权限：要开群消息权限。MVP1 只开了私聊消息接收权限，群聊权限要另外开。
- 群消息的 `event_id` 去重，复用 MVP1 / MVP2a 的去重逻辑（`routine-event-receipts.ts`，`event_id` 去重）。

### 3.5 防循环

两条，缺一不可：

1. `max_hops = 4`，超了交回给人。
2. 按发送者 ID 过滤：Bot 自己发的消息，不会再触发路由。发送者是 Bot 的 `open_id` 或 Bot 的 user id，直接丢掉，不进 Jev，不进 Router。

### 3.6 路由准确率：用 `evals/` 样例集量

- 在 `evals/` 下建一组固定样例（建议 30–50 条），覆盖：查库存、跟工厂、下单、查价格、查物流、闲聊、模糊消息。
- 目标值写进 specs：**误派率 < 5%、回落率 < 20%**。
- 之后每次改提示词或换模型都重跑这组样例，防止悄悄退化。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。

### 3.7 控制面 / VM 边界（MVP1.5）

- 飞书网关在控制面，先按飞书 `open_id` 找到用户和对应 VM，再在 VM 内按会话或频道路由到具体 Bot。
- 网关作为唯一消费者，一个 App ID 只能有一个长连接。MVP1 的教训：`lark-cli` 和网关同时连会漏消息，归档前要确认同凭据客户端不会再连上。
- 路由决策（Jev + Router）在哪里跑？本 change 的决定：**门口 Jev 在控制面跑**（快分流要常驻），**里面 Router 在 VM 内跑**（要读 VM 内的会话和工作记忆）。Ticket 生成在控制面，审批在控制面。

## 4. 待核对（开始写代码之前，在本地核对这 5 项）

- [ ] `docs/decision-model.md`、`server/ask-routing.ts`、`local-routing.ts`、`room-routing-members.ts` 的真实入口和函数名：Jev 现在是怎么派的？回落到 lead bot 的条件是什么？
- [ ] `server/chief-of-staff.ts` 的真实入口：Manager Bot 现在是怎么唤醒队友、分配模型的？
- [ ] MVP2a 的 `server/tickets/classifier.ts` 和 `TicketEngine`：Router 怎么调用它生成 Ticket？不要重写分类器。
- [ ] 飞书群消息权限：MVP1 开了哪些权限？群消息权限现在开了吗？没开的话，在飞书开放平台补开。群消息的 `event_id` 在网关里有没有存下来？
- [ ] `evals/` 目录现在有没有？没有的话，新建 `evals/routing/`，先写 30–50 条样例，再写代码。

## 5. 风险

- 群里七嘴八舌。防法：Specialist 不直接回群。
- 路由循环。防法：`max_hops = 4` + 按发送者 ID 过滤。
- 监听全部群消息，权限和成本都高。防法：先只响应 @。
- 路由瞎派。防法：固定规则 + 小模型，不确定回落到 lead bot，用 `evals/` 量准确率。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。
