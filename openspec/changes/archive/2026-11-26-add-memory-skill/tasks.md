# Tasks: MVP5 记忆与技能 `add-memory-skill`

- 时间：1–2 周
- 每项做完改 `- [ ]` 为 `- [x]`，不要攒到最后。

## 第 0 步：复用盘点（先盘点再动手）

- [x] 0. 对照本地目录，列出已有模块：`server/memory-dream.ts`、`memory-store.ts`、`memory-topics.ts`、`memory-journal.ts`、`memory-tidy.ts`、`skill-learn.ts`、`skill-review.ts`、`skill-library.ts`、`skill-switch.ts`、`org-library.ts`。写一张“已有 / 要改 / 要新建”表，放在 handoff.md 里。
- [x] 0. 确认 MVP4 已完成并推送（最新提交 `3912d66`）：只读巡检、工具层白名单拦截、最小适配器、三档分流，本 change 不改巡检。
- [x] 0. 确认 MVP2a / MVP2b 已完成：`TicketEngine` 和四层审批都已实现，技能被执行、要花钱或要删数据时才走审批，技能沉淀本身不走审批。

## 第 1 步：新建 change 与写文档

- [x] 1. 新建 change：`openspec new change add-memory-skill`，确认只生成隐藏的 `.openspec.yaml`，再把本包的 5 个文件复制进去（不要嵌套一层多余的文件夹，文件要和 `.openspec.yaml` 在同一层）。
- [x] 2. 写文档：proposal / design / specs / tasks / handoff 都已写好，核对一遍本地目录名和函数名，错的改过来（已将 `specs/memory-skill.md` 规范为 `specs/memory-skill/spec.md`）。
- [x] 3. 人批 R1：在 handoff.md 里写“批准 R1，可以做，范围只限 proposal 里写的，不扩范围”。要扩大范围，必须出 R2，重新批。

## 第 2 步：三层记忆与每晚复盘

- [x] 4. 三层记忆：短期（当前会话）、中期（每天 / 每周摘要）、长期（客户偏好、规则、白名单），三层都能写、能读。
- [x] 5. 每晚复盘：复用 `server/memory-dream.ts`，每天晚上跑一次，只写记忆，不执行、不花钱、不发消息。
- [x] 6. 记忆污染防护：高影响记忆（白名单、付款规则）先攒到待确认列表，等人确认后才写进长期记忆，复盘不能自动写。

## 第 3 步：技能沉淀与 Curator

- [x] 7. 技能沉淀：重复三次以上的流程，沉淀成技能，写清输入、输出、工具、边界、失败怎么办。
- [x] 8. Curator：活跃 → 过期 → 归档，定期合并重复技能、归档长期不用的技能。
- [x] 9. 核心技能锁：只有采购 / 付款 / 数据删除三个核心技能锁定，哈希存控制面，运行时校验，不一致就拒绝加载；其他技能 Agent 可以自己改，有日志，能回滚。

## 第 4 步：测 + 归档

- [x] 10. 按 specs 一条一条测，不要只测 happy path，也要测坏情况（见 specs/memory-skill/spec.md），尤其要测记忆污染和高影响记忆待确认。
- [x] 11. 审计 + 归档：`openspec validate --all --strict --no-interactive` 通过，`openspec archive add-memory-skill`，再推到 GitHub。
