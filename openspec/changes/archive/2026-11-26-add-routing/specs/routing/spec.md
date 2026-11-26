## ADDED Requirements

### Requirement: 群里查库存派给采购 Bot
系统 MUST 在群聊收到 @ 机器人的“查库存”请求时派给采购 Bot，并由 Manager Bot 汇总回群。凡涉及写入的验证 MUST 在隔离测试环境中执行。

#### Scenario: 群里发查库存派给采购 Bot
- WHEN 群里 @ 机器人发“查库存”
- THEN 派给采购 Bot，采购 Bot 通过 Manager Bot 回，不直接回群

### Requirement: 群里跟工厂派给跟单 Bot
系统 MUST 在群聊收到 @ 机器人的“跟一下工厂”请求时派给跟单 Bot，并由 Manager Bot 汇总回群。

#### Scenario: 群里发跟一下工厂派给跟单 Bot
- WHEN 群里 @ 机器人发“跟一下工厂”
- THEN 派给跟单 Bot，跟单 Bot 通过 Manager Bot 回，不直接回群

### Requirement: 群里闲聊不生成 Ticket
系统 MUST 对群聊中的闲聊消息不生成 Ticket，由 Manager Bot 直接回复。

#### Scenario: 群里发闲聊不生成 Ticket
- WHEN 群里 @ 机器人发闲聊，例如“今天天气不错”
- THEN 不生成 Ticket，Manager Bot 直接回

### Requirement: 模糊消息回落到 lead bot
系统 MUST 在无法确定目标专业 Bot 时将模糊消息回落到 lead bot，不得瞎派。

#### Scenario: 发一条模糊的消息回落到 lead bot
- WHEN 群里 @ 机器人发一条模糊的消息，例如“这个怎么样”
- THEN 回落到 lead bot，不瞎派给采购或跟单 Bot

### Requirement: 只响应 @ 机器人
系统 MUST 在飞书群聊中仅响应 @ 机器人的消息，未 @ 机器人时不得回复也不得生成 Ticket。

#### Scenario: 群里不 @ 不回
- WHEN 群里发消息，没有 @ 机器人
- THEN 不回，不生成 Ticket

### Requirement: Specialist 不直接回群
系统 MUST 禁止 Specialist Bot 直接向群聊发言，所有回复 MUST 经由 Manager Bot 汇总转回。

#### Scenario: Specialist 不直接回群
- WHEN Specialist 要回消息
- THEN 不直接在群里发，只能通过 Manager Bot 回

### Requirement: 转手上限 max_hops = 4
系统 MUST 对 Bot 间转手次数强制设置上限 `max_hops = 4`，达到上限时交回给人并记录日志。

#### Scenario: 转手超过 4 次交回给人
- WHEN 转手次数达到 4 次
- THEN 交回给人，不再转手，有日志

### Requirement: Bot 自己发的消息不触发路由
系统 MUST 按发送者 ID 过滤 Bot 自身发出的消息，防止路由循环。

#### Scenario: Bot 自己发的消息不触发路由
- WHEN Bot 自己在群里发了一条消息
- THEN 不触发路由，不生成 Ticket，不再回

### Requirement: 路由准确率
系统 MUST 在 `evals/` 固定样例集（30–50 条）上满足误派率 < 5% 且回落率 < 20%。

#### Scenario: evals 样例集准确率达标
- WHEN 在 `evals/` 样例集（30–50 条）上跑路由
- THEN 误派率 < 5%、回落率 < 20%
