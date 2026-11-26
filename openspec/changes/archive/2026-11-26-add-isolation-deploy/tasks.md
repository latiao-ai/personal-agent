# Tasks: MVP6 隔离与部署 `add-isolation-deploy`

- 时间：4–8 周（新版 roadmap 的时间，不是旧版的 2–4 周）
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：技术验证（先验证再动手，不要等到 MVP6 才开始选型）

- [x] 0. 选型：Firecracker / Cloud Hypervisor / Kata，或云厂商的轻量 VM。比冷启动时间、常驻内存、持久磁盘支持、快照支持，再定。验证结果写进 handoff.md。
- [x] 0. `openmausbot serve` 无界面运行在 VM 里的冷启动时间和常驻内存，实测，不要猜。
- [x] 0. 持久磁盘加快照的备份与恢复，在宿主机上验证一次。
- [x] 0. 现有 `server/local-vm-*.ts`（租约、座位池、配置）能否改造成 microVM 调度器，盘点完再动手。
- [x] 0. 对照本地目录，列出已有模块：`server/local-vm-*.ts`、控制面租户接口、飞书网关、MVP2b 预算、MVP5 记忆技能。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP5 已完成并推送（最新提交 `cc0d388`）：三层记忆、每晚复盘、污染防护、技能沉淀、Curator、核心技能锁，本 change 不改这些规则，只改存放和加载方式。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-isolation-deploy`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：一用户一台 microVM

- [x] 4. 一用户一台 microVM，带持久磁盘；同一台服务器上运行多台。VM 长期存在，VM 重启状态还在。
- [x] 5. 用户之间隔离：文件、网络、登录三样都要隔。VM 之间网络互不可达，VM 只能访问控制面接口和出口代理。
- [x] 6. 同一用户的多个 Bot 共享 VM，只做权限区分：各自的工具白名单、工作目录、可用连接器；审批和预算按 Bot 记账。

## 第 3 步：资源调度与控制面

- [x] 7. 资源调度：每台 VM 设资源配额；空闲 VM 休眠，释放内存；预热池；记录单机密度和唤醒延迟；准备好迁移流程。
- [x] 8. 控制面：飞书网关按 `open_id` 找 VM；VM 休眠与唤醒，消息排队不丢；租户开通与销户（先导出，再彻底删除）；监控告警；按租户计量计费。
- [x] 9. 预装账号：VM 里预装账号，Bot 能代客户去点、去授权；客户也能在 VM 上注册自己的邮箱。凭证在 Vault 里，不在 VM 明文文件里。
- [x] 10. 存放和加载纠正：长期记忆、技能库、知识库、Ontology 的本体在控制面，VM 启动时不加载全量副本，只按 Ticket 按需检索 Top-K。实时数据不进知识库，实时去查数据库 / ERP / 平台 API。

## 第 4 步：私有部署与测 + 归档

- [x] 11. 私有部署：核心逻辑留在厂商云端，客户只跑 Worker，必须回连控制平面；或用编译好的容器镜像，不给源码。`enterprise/` 不能未经授权分发，SaaS / 托管先拿商业许可。
- [x] 12. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/isolation-deploy.md），尤其要测网络扫描、休眠唤醒、销户删除。
- [x] 13. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-isolation-deploy`，再推到 GitHub。
