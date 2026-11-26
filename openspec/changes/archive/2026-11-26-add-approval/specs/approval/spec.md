## ADDED Requirements

### Requirement: 只读不弹卡片
系统 MUST 对只读工作直接放行而不弹审批卡片。凡涉及写入的验证 MUST 在隔离测试环境中执行。

#### Scenario: 查库存不弹卡片
- WHEN 白名单用户发“查一下库存”
- THEN 不弹卡片，直接回，Ticket 状态为 `done` 或不生成执行 Ticket（按 MVP2a 的规则，普通查询不生成 Ticket）

### Requirement: 花钱必须弹卡片
系统 MUST 对花钱、下单、付款、删数据、对外发消息类动作弹出审批卡片，只有批准人点击允许后才可执行。

#### Scenario: 下单弹卡片点了才下
- WHEN 白名单用户发“帮我下单买 10 件”
- THEN 弹卡片，卡片上写清楚做什么、花多少钱、给谁、有什么风险；点了 Allow once 才下，不点不下

#### Scenario: 不点不下
- WHEN 卡片弹出来，用户点了 Deny 或一直不点
- THEN 不下单，Ticket 状态不变或改为 `cancelled`，有日志

### Requirement: 超预算直接拒绝
系统 MUST 对超过单笔、日或月上限的 Ticket 直接拒绝，不询问评审模型，也不弹卡片。

#### Scenario: 超预算的单直接拒绝
- WHEN 一张 Ticket 的业务花费超过单笔 / 日 / 月上限
- THEN 直接拒绝，有日志，不执行，不弹卡片

### Requirement: 评审模型超时降级
系统 MUST 在评审模型超时、报错或输出无法解析时一律降级为“先问人”弹卡片，绝不直接执行。

#### Scenario: 评审模型超时降级为弹卡片
- WHEN 评审模型超时
- THEN 降级为弹卡片，不会直接执行

### Requirement: 评审模型只能往上调
系统 MUST 限制评审模型只能将风险层级往上调而不能往下调，且 MUST NOT 允许评审模型放行花钱类动作。

#### Scenario: 评审模型不能把花钱判为直接做
- WHEN 一张花钱的 Ticket 经过评审模型
- THEN 评审模型不能把它判为第 1 层“直接做”，必须走到第 3 层“先问人”

### Requirement: 非批准人点击无效
系统 MUST 校验审批卡片点击人的 `open_id` 为该 Ticket 的指定批准人，非批准人点击 MUST 拒绝并写日志。

#### Scenario: 非批准人点击卡片无效
- WHEN 非批准人点击卡片
- THEN 无效并有日志，不执行

### Requirement: 同一张卡片点两次只执行一次
系统 MUST 保证同一张审批卡片的重复点击幂等，只执行一次。

#### Scenario: 同一张卡片点两次只执行一次
- WHEN 同一张卡片点两次
- THEN 只执行一次，第二次点击返回“已处理”，不重复执行

### Requirement: 卡片过期后点击无效
系统 MUST 在审批卡片超过 Mandate 有效期后拒绝点击，将状态标记为过期/取消且不执行。

#### Scenario: 卡片过期后点击无效
- WHEN 卡片过期后点击
- THEN 无效，Ticket 状态改为 `cancelled` 或 `superseded`，不执行

### Requirement: Agent 看不到真实凭据
系统 MUST 将真实凭据保存在控制面按租户隔离的 Vault 中，Agent MUST 只能拿到用完失效的临时替身 token，环境变量与日志中不得出现真实凭据。

#### Scenario: agent 进程里没有真实凭据
- WHEN 检查 agent 进程的环境变量和日志
- THEN 没有真实凭据，只有临时替身 token，用完失效

### Requirement: 审批记录落库
系统 MUST 将审批决定（批准人、审批内容、时间、模型 token 与业务花费）以及拒绝记录持久化到控制面存储中以供查询。

#### Scenario: 审批记录能查到
- WHEN 查审批记录
- THEN 能查到谁批的、批了什么、什么时候批的、花了多少钱（模型 token + 业务花费，分开记）
