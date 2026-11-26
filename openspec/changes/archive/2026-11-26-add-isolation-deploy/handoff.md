# Handoff: MVP6 隔离与部署 `add-isolation-deploy`

- Change: `add-isolation-deploy`
- 阶段：MVP6，MVP5 之后，最后一个 MVP
- 时间：4–8 周（新版 roadmap 的时间，不是旧版的 2–4 周）
- 状态：**已通过维护者最终审计并归档推送**（2026-11-26 22:32，维护者确认“通过，归档并推送”）
- 依据：`~/workspace/personal-agent-mvp1-upgrade-roadmap.md`（2026-11-26 新版）MVP6 节

## 核对记录（2026-11-26 18:46，Muse 核对 GitHub `origin/main`）

- 最新 HEAD：`cc0d388` — `add-memory-skill: 实现 MVP5 三层记忆、每晚复盘、污染防护、技能沉淀、Curator 与核心技能锁`
- MVP5 已完成并归档推送，内容与本包的 proposal 一致：
  - 控制面三层记忆与技能引擎：独立 SQLite `memory-skill.sqlite`、短期会话 / 中期日周摘要 / 长期偏好规则白名单、同 VM 多 Bot 用户级共享与私有工作记忆隔离、最小 Ontology `preference` / `rule` 切片、只写记忆每晚复盘与独立 token 账本、高影响记忆待确认队列与外部指令注入污染防护、重复 ≥ 3 次五要素技能沉淀与租户隔离一句话触发、Curator 活跃→过期→归档与重复合并、采购 / 付款 / 数据删除核心技能锁控制面 SHA-256 运行时校验及非核心自由修改 / 日志 / 回滚
  - 文件：`server/memory-skill/engine.ts`、`host.ts`、`memory-skill.test.ts`、`rules.ts`、`skill-manager.ts`、`store.ts`、`server/routes/memory-skill.ts`、`shared/memory-skill.ts`；`openspec/changes/archive/2026-11-26-add-memory-skill/`；`openspec/specs/memory-skill/spec.md`
- 验证记录（见该提交的 WORKSPACE.md 记录）：`Vitest` 38/38 + 既有回归 94/94、oxlint、tsc、隔离端到端 11/11 及 `openspec validate --all --strict` 全通过，经维护者确认归档并推送 `origin/main`。
- **结论：没问题，可以开 MVP6。**
- **未阻塞 MVP6，但要记下来**：
  - 本次核对的 commit 页面只显示了前 400 行（主要是 `design.md` 的 diff），handoff.md 的完整验证数字没在页面上展开，上面引用的 38/38 + 94/94、11/11、validate 全通过来自该提交里 `WORKSPACE.md` 的归档记录，不是逐行读到的 handoff 原文。如果本地 agent 的 handoff 里数字不一致，以本地 handoff 为准。
  - design.md 里又有一处小瑕疵：第 3.7 节“企业共享技能模板”几个字在提交里显示成了乱码（`企业共享技��模板`），和 MVP4 的乱码是同一个问题，不影响代码，但归档前最好修一下，避免文档里留乱码。建议本地 agent 检查一下是不是复制粘贴时的编码问题。
  - MVP5 的 design.md 3.9 写的是“VM 只加载一份只读副本，启动时加载”，这句话是过度简化。正确做法是 VM 启动时不加载全量副本，只按 Ticket 按需检索 Top-K。本包的 proposal 和 design 里已经把这条纠正过来了，写进了 specs，作为 MVP6 的验收标准。
  - MVP1 仍有两项待验收：另一个白名单外账号、整机断网恢复（`lark-cli` 同凭据竞争消费者未清除，全断网恢复验收仍待做）。
  - 飞书群消息接收权限：MVP3 handoff 里写的是“开放平台开启群消息接收权限后直连”，真实群聊 @ 测试还没做，MVP3 的 7/7 是隔离环境跑的。
  - 服务端集成测试受 `listen EPERM` 阻塞，未误标完整回归通过。
  - 自建业务系统完整出口凭据注入，另开 `add-credential-proxy`，不在 MVP2b / MVP3 / MVP4 / MVP5 里做。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 最新 HEAD：`cc0d388`（2026-11-26）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- MVP0：已跑通，等 `bootstrap-dev-workspace` 最终审计。
- MVP1：已到 R2 收尾，剩下另一个白名单外账号验收、整机断网恢复验收、维护者最终审计。
- MVP1.5：已批 R1，2026-11-26 15:20，已归档推送 `2a15dc0`。
- MVP2a：已完成并归档推送 `7d978df`。
- MVP2b：已完成并归档推送 `786516d`。
- MVP3：已完成并归档推送 `19fb7db`。
- MVP4：已完成并归档推送 `3912d66`。
- MVP5：已完成并归档推送 `cc0d388`。

## 技术验证（第 0 步，2026-11-26 本地核对完成）

- [x] **选型**：**生产 Linux（KVM）宿主机选 Firecracker microVM**；**本地 macOS 开发与隔离测试通过统一 `MicroVmDriver` 抽象提供 `IsolatedLocalDriver` 仿真驱动（附带 `FirecrackerDriver` 生产配置与生命周期适配）**。
  - 对比结论：
    - **Firecracker**：内核冷启动 ~125 ms，VMM 内存开销 ~5 MB，原生 virtio-block 持久磁盘 + `CreateSnapshot` / `LoadSnapshot`（内存+状态恢复 < 200 ms），独立 TAP + netns/iptables 实现强网络隔离；加上 `openmausbot serve` 实测冷启动 1.51–1.57 s，端到端冷启动 ~1.7 s，空载常驻内存 ~450 MB（5 MB VMM + ~50 MB Guest Linux + ~392 MB Node）。
    - **Cloud Hypervisor**：偏通用 Linux VM（ACPI/热插拔更全），VMM 开销与镜像体积略高于 Firecracker，MVP6 轻量多租户场景不如 Firecracker 密度高。
    - **Kata Containers**：需叠加容器运行时（containerd/shim），链路更重、快照与长驻休眠控制粒度不如直接管 Firecracker。
    - **云厂商轻量 VM**：冷启动 10–30 s、单实例成本高且跨云锁定，不适合高密度休眠/预热池。
  - **配额结论**：默认 `2 vCPU / 4 GB RAM / 20 GB 持久盘` 成立（`openmausbot serve` 空载 RSS ~392 MB，4 GB 为 Guest OS + 浏览器/Playwright + 工作区留足 ~3.6 GB 余量；1 GB 在开启浏览器后会 OOM）。
- [x] **`openmausbot serve` 无界面运行实测**（Apple Silicon ARM64，Node `v24.14.0`，`--experimental-strip-types server/index.ts`，隔离临时目录 `OMB_DATA_DIR`）：
  - 冷启动到监听就绪：**1,507 ms – 1,572 ms**（约 **1.5 s**）
  - 常驻内存（RSS）：**391.7 MB**（V8 `heapUsed`：**111.4 MB**）
- [x] **持久磁盘加快照的备份与恢复实测**（宿主机隔离临时目录，4 MB 工作区 + `state.json`，`tar.gz` 快照 + SHA-256 完整性校验）：
  - 备份耗时：**22 ms**
  - 恢复耗时：**6 ms**
  - SHA-256 校验：**通过**（`origHash === restoredHash`）
- [x] **`server/local-vm-*.ts` 能否改造成 microVM 调度器**：
  - 盘点结论：`server/local-vm-lease.ts`（`LocalVmLease` / `LocalVmLeasePool`）与 `server/local-vm-seat-pool.ts`（`LocalVmSeatPool`）是面向单机本地桌面容器（Docker/Podman）的线程级互斥租约与座位亲和池，`server/local-vm-settings.ts` / `server/container-limits.ts` 定义了资源配额常量（默认 `4 GB / 2 vCPU`）。
  - **处置**：**不破坏原文件**（避免影响现有桌面 Local VM 与 `local-vm-*.test.ts` 回归）；直接复用 `DEFAULT_DESKTOP_RESOURCES` 配额常量，参考 `LocalVmLeasePool` / `LocalVmSeatPool` 的无竞态同步占座思路，在新建的 `server/isolation/` 控制面模块中实现面向“一用户一台长期 microVM + 预热池 + 休眠/唤醒 + 迁移”的调度器。

## 复用盘点（第 0 步，2026-11-26 本地核对完成）

| 模块 / 能力 | 状态 | 现有路径与真实入口 | MVP6 处置（已有 / 要改 / 要新建） |
|---|---|---|---|
| 本地 VM 租约/座位池/配额 | 已有 | `server/local-vm-lease.ts`、`server/local-vm-seat-pool.ts`、`server/local-vm-settings.ts`、`server/container-limits.ts`（`DEFAULT_DESKTOP_RESOURCES = { memoryGb: 4, cpus: 2 }`） | **保留原文件不侵入 + 复用配额常量**：新建 `server/isolation/scheduler.ts` 实现多租户 microVM 调度、配额限流、休眠/唤醒、预热池与迁移流程 |
| 控制面租户与 VM 接口 | 无现成多租户开通/销户/网络策略引擎 | 现有 `server/routes/` 有 `tickets.ts`、`approvals.ts`、`routing.ts`、`patrol.ts`、`memory-skill.ts`；无 `/api/isolation/*` | **要新建**：`shared/isolation.ts`、`server/isolation/{store,driver,scheduler,network-policy,knowledge-loader,engine,host}.ts`、`server/routes/isolation.ts`，并在 `server/index.ts` 挂载 |
| 飞书网关（按 `open_id` 路由 + 休眠排队） | 已有单机版 | `scripts/feishu_gateway.py`、`scripts/feishu_relay.py`（SQLite `deliveries` 队列表 + `conversations` 映射） | **保留原脚本不改 + 在控制面新建租户路由与休眠消息队列**：在 `server/isolation/` 实现按 `open_id` 查找租户与 VM、VM 休眠时持久化入队、唤醒后按序投递不丢消息，并提供 HTTP 入口供飞书网关直连 |
| MVP2b 审批、双口径预算与 Vault | 已有 | `server/approvals/budget.ts`（`evaluateDualBudget`、`DEFAULT_DUAL_BUDGET_POLICY`）、`server/approvals/vault.ts`（`ControlPlaneVault`、按 `tenantId` 隔离的密钥与临时替身 token） | **直接复用（不改规则）**：同 VM 多 Bot 权限区分按 Bot 独立记账；预装账号凭证仅存控制面 Vault，VM 只拿临时替身 token；按租户计量计费（token + VM 运行时长 + 存储用量）沿用双口径记法 |
| MVP5 记忆与技能引擎 | 已有 | `server/memory-skill/{engine,store,skill-manager,host}.ts`（`memory-skill.sqlite`、三层记忆、技能库、最小 Ontology 切片） | **不改分层/复盘/核心锁规则，只补齐按需 Top-K 检索与本体边界**：在 `server/isolation/` 中实现 VM 启动不加载全量副本、按 Ticket 检索控制面记忆/技能/知识库 Top-K 及用后清理，并强制拦截库存/订单状态/实时价格写入知识库（强制走实时数据源查询） |
| 私有部署与 `enterprise/` 边界 | 已有目录 | `enterprise/`（含独立 `LICENSE` / `FEATURES`）、`scripts/bundle-server.mjs` | **要新建校验与清单模块**：在 `server/isolation/deployment.ts` 提供 Worker 回连控制面配置校验、私有部署无源码打包/镜像清单校验，明确禁止未经授权分发 `enterprise/` 与源码 |

## 批准

- 批准：R1，2026-11-26 21:33，维护者在对话中明确确认“批准 R1，可以做”，范围只限 proposal 里写的，不扩范围。
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在 MVP6 里建全量 Ontology，不要在 MVP6 里把实时数据写进知识库，不要在 MVP6 里给源码。

## 做到哪了

- tasks.md 第 0–4 步（第 0–12 项）：全部完成并通过单元测试、坏情况测试、静态检查、类型检查、隔离端到端 HTTP 验证（9/9）及 `openspec validate --all --strict --no-interactive`（9/9）。
- tasks.md 第 4 步第 13 项（最终审计 + `openspec archive add-isolation-deploy` + 推送 GitHub）：已完成。

## 本次变更文件清单

- 新增：`shared/isolation.ts`（microVM 配额/生命周期、租户隔离、多 Bot 共享 VM 权限、飞书休眠唤醒队列、预装账号、按需 Top-K 检索、实时数据查询、销户导出/删除回执、计量计费、监控告警、单机密度与私有部署合规类型定义）
- 新增：`server/isolation/store.ts`（控制面独立 SQLite `isolation.sqlite` 持久化，确保审计日志与销户回执独立于用户 VM）
- 新增：`server/isolation/driver.ts`（统一 `MicroVmDriver` 接口、`IsolatedLocalDriver` 隔离磁盘/快照/唤醒驱动及 `buildFirecrackerConfig` 生产 Firecracker KVM 配置生成器）
- 新增：`server/isolation/network-policy.ts`（VM 间网络互不可达、阻断控制面内部接口与云元数据 `169.254.169.254`，仅放行声明的控制面公开接口与出口代理）
- 新增：`server/isolation/knowledge-loader.ts`（按 Ticket 检索控制面记忆/技能/知识库 Top-K 与共享 Ontology 切片、用后清理上下文；严格禁止库存/订单状态/实时价格写入知识库并强制实时查 DB/ERP/平台 API）
- 新增：`server/isolation/deployment.ts`（私有部署合规校验：禁源码分发、禁未授权 `enterprise/` 分发、强制保留 `LICENSE`/`NOTICE`/`third_party/cua-driver`）
- 新增：`server/isolation/engine.ts`（`IsolationEngine` 核心控制面编排器）
- 新增：`server/isolation/host.ts`（`createIsolationHost` 宿主工厂）
- 新增：`server/routes/isolation.ts`（控制面 HTTP 路由 `/api/isolation/*`）
- 新增：`server/isolation/isolation.test.ts`（9 项单测与坏情况测试，完整覆盖全部 8 条 spec 场景 + 预热池/快照迁移/Vault 预装账号/健康告警/私有部署合规校验）
- 修改：`server/approvals/vault.ts`（新增 `purgeTenantSecrets` 用于租户销户时彻底清除 Vault 密钥与替身 token）
- 修改：`server/index.ts`（4 处最小挂载：`createIsolationHost` 导入、实例化、`isolation.routes` 注册与退出清理）
- 文档：`openspec/changes/add-isolation-deploy/{design.md,handoff.md,tasks.md,specs/isolation-deploy/spec.md}`

## 验证证据（2026-11-26）

- Vitest（MVP6 + MVP2a/2b/3/4/5 + `local-vm-*` 回归）：`./node_modules/.bin/vitest run server/isolation/isolation.test.ts server/memory-skill/memory-skill.test.ts server/patrol/patrol.test.ts server/approvals/approvals.test.ts server/tickets/tickets.test.ts server/routing/routing.test.ts server/local-vm-lease.test.ts server/local-vm-seat-pool.test.ts` → **8 files / 75 passed（MVP6 新增 9/9）**
- 静态检查：`./node_modules/.bin/oxlint --deny-warnings shared/isolation.ts server/isolation/ server/routes/isolation.ts server/approvals/vault.ts` → **0 warnings, 0 errors**
- 类型检查：`./node_modules/.bin/tsc --noEmit` → **0 errors**
- OpenSpec 严格校验：`openspec validate --all --strict --no-interactive` → **9 passed, 0 failed**
- 隔离端到端 HTTP 验证：通过 `node --experimental-strip-types scripts/control-omb.ts launch` 启动独立临时实例（`http://127.0.0.1:22398`，未触碰真实应用与数据），逐条跑通全部 **8/8 spec 场景 + 私有部署合规校验（共 9/9 PASS）** 后发送 `SIGINT` 自动清理临时目录。
- 未验证项说明：本机为 macOS ARM64 无 Linux KVM，故 Firecracker 进程启动仅验证了 `buildFirecrackerConfig` 生成与控制面编排，真实 Firecracker KVM 宿主机单机密度实测需在部署到 Linux KVM 宿主机时执行。

## 恢复方式

- 如需回退本次代码改动，仅需还原 `server/index.ts` 中 4 处 `isolation` 挂载与 `server/approvals/vault.ts` 的 `purgeTenantSecrets` 方法，并删除 `shared/isolation.ts`、`server/isolation/` 与 `server/routes/isolation.ts`，不影响任何已有模块与数据。

## 卡在哪

- 无。等 R1。

## 下一步

1. 用户批 R1（回“可以做”）。
2. 在 Mac 上：
   ```bash
   cd /Users/latiao/OpenMausBot
   openspec new change add-isolation-deploy
   ```
   把本包的 5 个文件复制到刚生成的同名目录里，**文件要和隐藏的 `.openspec.yaml` 在同一层，不要嵌套一层多余的文件夹**。
3. 按 tasks.md 第 0 步先做技术验证，填上面“技术验证”一节，选型定了再写正式代码。
4. 按 specs/isolation-deploy.md 一条一条测，在隔离测试环境中测，尤其要测网络扫描、休眠唤醒、销户删除。
5. `openspec validate --all --strict --no-interactive` 通过后，`openspec archive add-isolation-deploy`，再推到 GitHub。
6. MVP6 完成后，整个 MVP0–MVP6 就闭环了。之后再开后续 change：`add-credential-proxy`（自建业务系统完整出口凭据注入）、价格 / 物流 / 供应商回复 / 爆品信号 4 类巡检数据源一类一类接、全量 Ontology。
