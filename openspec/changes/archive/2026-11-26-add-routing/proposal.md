# Change: add-routing（路由，MVP3）

> 状态：proposal 草稿，待你批 R1 后动手。
> 对应改造方案 MVP3（`~/workspace/personal-agent-mvp1-upgrade-roadmap.md` 2026-11-26 新版）。
> 前置：MVP2b `add-approval` 已完成并推送（最新提交 `786516d`，2026-11-26，见核对记录）；MVP2a `add-ticket` 已完成并归档；MVP1.5 已批 R1。
> 底座：OpenMausBot，本地 `/Users/latiao/OpenMausBot`；代码基线 `5987204e3`，
> 工作基线 `92eb6457ff128d4bbbd622ab9e4b42da4200f473`；最新 HEAD `786516d`。

## 为什么改

- MVP1 只通了私聊，MVP2 只通了工单和审批，但客户是在飞书群里说话的：群里发一句话，七八个 Bot 一起回，或者没人回，都不行。
- 要补上两层路由：门口快分流，几百毫秒派给对的 Manager Bot；里面 Router-Worker，判断是新活就生成 Ticket，派给采购 / 下单 / 跟单 Bot。
- 没有路由，群聊就没法用，MVP4 的巡检日报、MVP6 的多租户群聊也都没有落点。

## 改什么（范围）

只加路由，不改 Ticket 生成、不改审批：

1. **先复用，再新建**：Jev 快决策已经存在（`docs/decision-model.md`、`server/ask-routing.ts`、`local-routing.ts`、`room-routing-members.ts`），Manager Bot 对应现有的 Chief of Staff（`server/chief-of-staff.ts`）。本 change 主要是配置加飞书群接入，不需要从零写。
2. **门口 Jev**：小模型，几百毫秒，派给哪个 Manager Bot，不确定回落到 lead bot，不做工单。
3. **里面 Router**：判断是不是新活，是新活生成 Ticket（复用 MVP2a 的 `TicketEngine`），派给采购 / 下单 / 跟单 Bot。
4. **Specialist 不直接回群**：只能通过 Manager Bot 回，转手上限 `max_hops = 4`。
5. **飞书群聊规则**：先只响应 @ 机器人，不监听全部群消息。监听全部群消息需要更多权限，成本也更高。
6. **防循环**：除了 `max_hops = 4`，还要保证 Bot 自己发的消息不会再触发路由（按发送者 ID 过滤）。

## 不动什么（边界）

- 不改 Ticket 生成逻辑：Ticket 字段、Mandate 不可变、去重、observe，那是 MVP2a 已完成的事。本 change 只在 Router 里调用已有的 `TicketEngine` 生成 Ticket。
- 不改审批逻辑：四层审批、卡片回调、Vault、双口径预算，那是 MVP2b 已完成的事。本 change 生成的 Ticket 照常走 MVP2b 的审批。
- 不做只读巡检：那是 MVP4 的事。
- 不做记忆与技能：那是 MVP5 的事。
- 不做复杂模型选择：先用固定规则 + 小模型，不做多模型比选、不做动态模型切换。
- 不做群聊外的路由：私聊路由在 MVP1 已通，本 change 只做群聊。
- 不改 OpenMausBot 核心的 bot 调度、记忆、harness 服务；不删模块。
- 不接钉钉 / 企业微信；先只做飞书。

## 验收标准

- [ ] 群里发“查库存”，派给采购 Bot。
- [ ] 群里发“跟一下工厂”，派给跟单 Bot。
- [ ] 群里发闲聊，不生成 Ticket。
- [ ] 发一条模糊的消息，回落到 lead bot。
- [ ] 群里只响应 @ 机器人，不 @ 不回（除非已配置的其他规则）。
- [ ] Specialist 不直接回群，只能通过 Manager Bot 回；转手超过 4 次，交回给人。
- [ ] Bot 自己发的消息不会再触发路由。
- [ ] 路由准确率：`evals/` 样例集（30–50 条）上，误派率 < 5%、回落率 < 20%。
- [ ] `openspec validate --all --strict --no-interactive` 通过；`tasks.md` 全勾完；`handoff.md` 写清楚。

## 风险

- 群里七嘴八舌：多个 Bot 一起回。防法：Specialist 不直接回群，只能通过 Manager Bot 回。
- 路由循环：Bot 回 Bot，越转越多。防法：`max_hops = 4` + 按发送者 ID 过滤 Bot 自己的消息。
- 监听全部群消息，权限和成本都高。防法：先只响应 @ 机器人。
- 路由瞎派：小模型判断不准。防法：先用固定规则 + 小模型，不确定回落到 lead bot；用 `evals/` 样例集量准确率，改提示词或换模型后重跑。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。
