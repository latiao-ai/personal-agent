# tenancy-architecture Specification

## Purpose
定义托管个人助理的租户粒度、控制面与用户 microVM 职责边界、资源与网络隔离、模型代理、许可证及上游同步约束，供后续 MVP 2–6 实施遵循。

## Requirements

### Requirement: 边界图完整
设计文档 SHALL 有一张控制面 / VM 边界图，图中 SHALL 包含：IM 网关、租户与身份、Ticket 与 Mandate 存储、审批记录、预算计数、Vault、LLM 转发代理、审计日志、长期记忆 / 技能库（控制面）；OpenMausBot 运行时、会话、工作记忆、技能只读副本、浏览器和工作文件、带签名的 Mandate 只读副本（VM 内）。

#### Scenario: 边界图与结论表一致
- WHEN 打开 `design.md` 的边界图
- THEN 图中每一项都能在 `proposal.md` 的结论表里找到对应项，没有多出来的、也没有少掉的

### Requirement: 六个决策都有结论
设计文档 SHALL 对 6 个决策每项都有结论：租户粒度、宿主机规范、控制面与 VM 的边界、引擎接入、`enterprise/` 目录、上游同步策略。

#### Scenario: 宿主机三项有具体内容
- WHEN 检查宿主机规范
- THEN 配额、网络隔离、容量与迁移三项都有具体数值或明确的“待确认 + 默认值”，不是只写“要注意”

#### Scenario: 引擎接入写清 Key 位置
- WHEN 检查引擎接入
- THEN 明确写着“中转站总 Key 放在控制面 LLM 代理层，不直接放进用户 VM；VM 只拿带租户标识的内部虚拟 Key”

#### Scenario: enterprise 写清二选一
- WHEN 检查 `enterprise/` 决策
- THEN 明确写着“上线对外售卖前二选一：买正式托管授权，或把用到的一小块能力迁到自研控制面后删除该目录”，并且列出了实际用到的能力清单

### Requirement: 与后面 MVP 无矛盾
设计文档 SHALL 有一张“对后面 MVP 的影响”表，覆盖 MVP2a、MVP2b、MVP3、MVP4、MVP5、MVP6。

#### Scenario: Ticket 存储位置一致
- WHEN 检查 MVP2a 的影响行
- THEN 写着“Ticket 存在控制面，不存在 VM 里”，与边界图一致

#### Scenario: 技能锁不分档
- WHEN 检查 MVP5 的影响行
- THEN 写着“核心技能锁死，其他技能不分档、不审批”，与用户 2026-11-26 的决定一致

### Requirement: 只写文档，不改代码
本 change SHALL 不包含任何业务代码改动。

#### Scenario: git diff 只有文档
- WHEN 运行 `git diff --stat`（或 `git status`）
- THEN 改动只在 `openspec/changes/decide-tenancy-architecture/` 下，没有 `packages/`、`server/` 等代码目录的改动

### Requirement: 校验与归档
本 change SHALL 通过严格校验后归档。

#### Scenario: validate 通过
- WHEN 运行 `openspec validate --all --strict --no-interactive`
- THEN 退出码为 0，没有 ERROR / WARNING

#### Scenario: archive 后不在活跃列表
- WHEN 运行 `openspec archive decide-tenancy-architecture` 后再运行 `openspec list`
- THEN 活跃列表里不再有 `decide-tenancy-architecture`，它已在 `openspec/changes/archive/` 下
