## ADDED Requirements

### Requirement: A 客户的 Bot 看不到 B 客户的文件和订单
系统 MUST 为每个用户租户分配独立的 microVM 与持久磁盘工作区，A 客户的 Bot MUST NOT 读取到 B 客户的文件、订单或浏览器登录状态，且越权尝试 MUST 记录拒绝审计。凡涉及写入的验证 MUST 在隔离测试环境中执行，禁止使用正在运行的应用或真实数据。

#### Scenario: A 客户的 Bot 看不到 B 客户的文件和订单
- WHEN A 客户的 Bot 尝试读取 B 客户的文件和订单
- THEN 读不到，有拒绝记录

### Requirement: A 用户 VM 内的 agent 主动扫描网络访问不到 B 的 VM 和控制面内部接口
系统 MUST 强制执行 VM 间网络隔离，VM 之间 MUST 互不可达，VM MUST 仅允许访问声明的控制面公开接口与出口代理；当 A 用户 VM 内的 agent 主动扫描网络并尝试访问 B 的 VM 或控制面内部接口时，系统 MUST 阻断连接并记录拒绝审计。

#### Scenario: A 用户 VM 内的 agent 主动扫描网络访问不到 B 的 VM 和控制面内部接口
- WHEN A 用户 VM 内的 agent 主动扫描网络，尝试访问 B 的 VM 和控制面内部接口
- THEN 访问不到，有拒绝记录

### Requirement: VM 重启状态审计记录还在
系统 MUST 将 VM 状态、会话与工作文件保存在持久磁盘上，并将权威审计记录保存在控制面；当 VM 重启后，持久磁盘状态与控制面审计记录 MUST 保持完整可用。

#### Scenario: VM 重启状态审计记录还在
- WHEN VM 重启
- THEN 状态还在，审计记录还在（审计记录以控制面为准）

### Requirement: VM 休眠时发飞书消息唤醒后照常回复不丢消息
系统 MUST 支持空闲 VM 休眠以释放内存；当目标 VM 处于休眠状态且飞书网关按 `open_id` 路由到消息时，控制面 MUST 先将消息持久化排队，唤醒对应 VM 后按序投递并照常回复，MUST NOT 丢失消息。

#### Scenario: VM 休眠时发飞书消息唤醒后照常回复不丢消息
- WHEN VM 休眠时发一条飞书消息
- THEN 消息先排队，唤醒后照常回复，不丢消息

### Requirement: 销户后数据可导出之后彻底删除
系统 MUST 在租户销户流程中先导出该租户的完整数据快照给客户，随后彻底删除其 VM、持久磁盘、记忆/技能/知识库命名空间及 Vault 凭据，并写入不可变销户删除记录；删除完成后 MUST 无法再读取任何该租户数据。

#### Scenario: 销户后数据可导出之后彻底删除
- WHEN 一个租户销户
- THEN 数据先导出给客户，之后彻底删除，删除有记录，删除后读不到

### Requirement: 同一用户的多个 Bot 共享 VM 只做权限区分
系统 MUST 允许同一用户的多个 Bot 共享同一台 VM，并通过控制面下发的 Mandate、工具白名单、工作目录、可用连接器以及按 Bot 独立记账的审批与预算做权限区分，使采购 Bot 能下单而巡检 Bot 只能读。

#### Scenario: 同一用户的多个 Bot 共享 VM 只做权限区分
- WHEN 采购 Bot 下单，巡检 Bot 尝试下单
- THEN 采购 Bot 能下单，巡检 Bot 被拒，有拒绝记录

### Requirement: VM 启动时不加载全量记忆和技能副本只按 Ticket 按需检索
系统 MUST 将长期记忆、技能库、知识库与 Ontology 本体存放在控制面；VM 启动时 MUST NOT 加载全量记忆或技能副本，MUST 仅在接到 Ticket 时按需检索 Top-K 切片并在任务结束后从上下文清理。

#### Scenario: VM 启动时不加载全量记忆和技能副本只按 Ticket 按需检索
- WHEN VM 启动，接到一个 Ticket
- THEN 只检索这个 Ticket 需要的记忆和技能 Top-K，不加载全量副本

### Requirement: 实时数据不进知识库实时去查数据库 ERP 平台 API
系统 MUST 禁止将库存、订单状态、实时价格等实时业务数据写入知识库；当查询库存等实时数据时，系统 MUST 实时查询数据库 / ERP / 平台 API，MUST NOT 从知识库读取旧数据。

#### Scenario: 实时数据不进知识库实时去查数据库 ERP 平台 API
- WHEN 查库存
- THEN 实时去查数据库 / ERP / 平台 API，不从知识库里查旧数
