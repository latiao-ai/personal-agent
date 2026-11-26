# Tasks: MVP1.5 架构决策 `decide-tenancy-architecture`

- 类型：只写文档，不改代码
- 时间：2–3 天
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有的相关模块：`server/local-vm-*.ts`（租约、座位池、配置）、`server/contracts.ts`、`docs/custom-engines.md`、`docs/approval-levels.md`、`enterprise/` 目录。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP1 网关现状：网关独立运行，通过 harness HTTP API 投递消息，已与 harness 松耦合；仍需在 MVP6 将网关部署在 VM 外的控制面，本 change 不改代码。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：目录及隐藏 `.openspec.yaml` 已存在；确认 proposal、design、handoff、tasks 与 `.openspec.yaml` 同层，规范正文位于 `specs/tenancy-architecture/spec.md`，没有重复嵌套目录。
- [x] 2. 写 proposal.md：现状、目标、6 项决策结论、不做清单、成功标准。
- [x] 3. 写 design.md：边界图、6 个决策、5 项待核对、对后面 MVP 的影响表。边界图与 proposal 六项结论建立对应。

## 第 2 步：补齐宿主机与许可证细节

- [x] 4. 宿主机方案：写明配额建议默认值（2 vCPU / 4 GB / 20 GB，待 MVP6 验证）、VM 间网络互不可达、VM 只访问控制面少数接口和出口代理、宿主机不放用户明文数据、单机容量测量与持久磁盘迁移/快照恢复。
- [x] 5. 引擎方案：写明总 Key 在控制面 LLM 代理、VM 使用带租户标识的短期内部虚拟 Key，以及限流、按用户 / Bot 核算、预算熔断、中转站切换和签名 token 约束。注明现有自定义引擎尚未实现这些能力。
- [x] 6. `enterprise/` 清单：列出当前实际能力及未实现的 `sso`，说明许可证要求和上线前二选一（正式托管授权，或迁移所需能力后删除）。

## 第 3 步：人批 R1 与归档

- [x] 7. 人批 R1：用户于 2026-11-26 指示“照着这个 tasks.md 文件，把任务不断完成”，据此批准 R1；范围仅限本文档的 6 个决策和文档，不扩围。扩大范围必须出 R2，重新批。
- [x] 8. 校验：`openspec validate --all --strict --no-interactive` 通过；`openspec status --change decide-tenancy-architecture --json` 能看到它。
- [x] 9. 归档：已由 `openspec archive decide-tenancy-architecture` 归档至本目录，生效规范已复制到 `openspec/specs/tenancy-architecture/spec.md`。
- [ ] 10. 推送：维护者最终审计接受并确定发布后，将本 change 的改动推送到 https://github.com/latiao-ai/personal-agent；不得把工作区中其他未提交文件带入提交。
