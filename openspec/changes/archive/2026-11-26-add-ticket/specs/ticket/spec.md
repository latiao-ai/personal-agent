## ADDED Requirements

### Requirement: 副作用工作生成 Ticket
系统 MUST 仅对会产生副作用的工作生成 Ticket，且生成的 Ticket 字段齐全、id 唯一。凡涉及写入的验证 MUST 在隔离测试环境中执行。

#### Scenario: 发一句话生成一张 Ticket
- WHEN 白名单用户在飞书私聊发一句副作用工作，例如“帮我把这批货的库存改成 100”
- THEN 生成一张 Ticket，id 唯一，字段齐全：id、时间、来源、发起人、Mandate、工具白名单、预算、状态

#### Scenario: 普通对话不生成 Ticket
- WHEN 白名单用户发一句普通对话，例如“今天天气怎么样”或“查一下库存”
- THEN 不生成 Ticket，走会话直接回

### Requirement: 去重
系统 MUST 对重复到达的同一事件或同一消息去重，保证同一句话发两次只生成一张 Ticket。

#### Scenario: 同一句话发两次只生成一张
- WHEN 同一句话发两次
- THEN 只生成一张 Ticket，第二张不生成，有去重记录

### Requirement: 白名单外直接丢掉
系统 MUST 拒绝不在白名单内的发起人，不生成 Ticket、不回复，并写入拒绝日志。

#### Scenario: 白名单外发消息不生成 Ticket
- WHEN 白名单外的人发消息
- THEN 不生成 Ticket，不回复，日志里有拒绝记录

### Requirement: Mandate 不可变
系统 MUST 在生成 Ticket 时计算 Mandate 内容哈希并存在控制面；agent MUST 只能读取只读副本而不能修改，修改 Mandate MUST 转为新建关联工单并作废旧单。

#### Scenario: Mandate 改了旧单作废
- WHEN Mandate 改了
- THEN 旧 Ticket 状态改为 `superseded`，新 Ticket 用 `parent_id` 关联旧单，新 Ticket 重新审批

#### Scenario: agent 尝试修改 Mandate 被拒绝
- WHEN agent 尝试通过工具修改 Mandate
- THEN 被拒绝，有日志，Mandate 内容不变，哈希不变

### Requirement: 默认 observe 只用在外部事件
系统 MUST 仅对外部事件来源默认使用 `observe` 状态（只记录不执行），白名单用户的私聊 MUST 不走 `observe` 而照常回复。

#### Scenario: 外部事件默认 observe
- WHEN 外部事件到达，例如新订单、库存变化、Webhook
- THEN 生成 Ticket，状态为 `observe`，只记录，不执行

#### Scenario: 白名单用户私聊照常回复
- WHEN 白名单用户在飞书私聊发消息
- THEN 不走 observe，照常回复（普通对话直接回，副作用工作生成 Ticket 后按 MVP2b 审批流程走）

### Requirement: Ticket 存在控制面
系统 MUST 将 Ticket 持久化在控制面存储中，而非 VM 内；开发阶段 MUST 放在 harness 的独立 SQLite 文件并通过接口访问，禁止 VM 内 agent 直接读写。

#### Scenario: 开发阶段通过接口访问
- WHEN 检查 Ticket 存储
- THEN 开发阶段在 harness 的独立 SQLite 文件里，但通过接口访问；VM 内的 agent 不能直接读写这个文件
