# Handoff: add-admin-llm-config

变更：`add-admin-llm-config`（v1）｜执行者：Antigravity｜授权状态：R1 已确认，最终审计已通过（2026-11-27 维护者回复“通过”）｜基线：`main` `bf1dc3afa`｜最近验证：Vitest 74/74（含新增 7/7、portal 5/5、unified-login 2/2、MVP2a–MVP6 59/59、file-size-ratchet 1/1）、`oxlint --deny-warnings` 0 错 0 警、`tsc -b` 通过、`vite build` 通过、`openspec validate --all --strict --no-interactive` 12/12 通过｜状态：已归档并推送 `origin/main`。

## 背景

- 上一个 change：`add-unified-login`，main `bf1dc3a`，已实现并推送。
- 本 change 的来源：2026-11-27 15:52，维护者提出统一管理用户使用 API Key 的地方应在管理员后台，管理员在后台配置，租户共用对应模型，SaaS 产品可按量定价。
- 2026-11-27 16:02，维护者确认按 `openspec/changes/add-admin-llm-config/tasks.md` 连续实施并自测，维护者负责关键步骤与最终成果审核。

## 本次改动文件

- `shared/llm-proxy.ts`：新增 `AdminLlmProviderView`、`LlmPricing`、`TenantLlmUsage`、`PortalTenantLlmUsageView`。
- `server/llm-proxy/store.ts`（新建）：封装 `llm_providers`、`llm_pricing`、`llm_usage_daily` 读写与事务、`INSERT ... ON CONFLICT DO UPDATE` 并发安全累加及月汇总。
- `server/portal/store.ts`：在 `portal.sqlite` 建表脚本中纳入 3 张 LLM 表并暴露 `getDb()`。
- `server/approvals/vault.ts`：补充控制面内部 `getSecret(tenantId, name)`（仅控制面读取，不暴露 VM/HTTP）。
- `server/llm-proxy/engine.ts`：新增 `attachStore`、`bootstrapFromEnvAndLoad`、`loadProvidersFromStore`、`updateProvider`、`rotateProviderApiKey`、`getApiKeyMask`、`testProvider`、`getTenantBudget`/`setTenantBudget`、`getPortalUsageView`；`chatCompletions` 调用前按 `llm_usage_daily` 校验每日 token/费用上限（超限 402 不调中转站），调用后按定价表计算 `cost`/`revenue` 落库。
- `server/portal/admin.ts`：`AdminOpsDeps` 注入 `llmProxy` 和 `llmStore`，实现 `listLlmProviders`、`saveLlmProvider`、`rotateLlmApiKey`、`testLlmProvider`、`getLlmPricing`、`setLlmPricing`、`setTenantLlmBudget`、`getTenantLlmUsage`，全部记 `PortalAuditEntry` 且不写明文 Key。
- `server/portal/engine.ts`：初始化 `llmStore` + `llmProxy`、执行首次环境变量迁移与 DB 优先加载，暴露管理端和客户门户只读用量委托方法（保持文件 < 1000 行通过 file-size-ratchet）。
- `server/llm-proxy/host.ts` & `server/portal/host.ts`：让 `/api/llm/*` 与 `/api/admin/llm/*` 共享同一 `ControlPlaneLlmProxy` 实例。
- `server/routes/portal-llm.ts`（新建）& `server/routes/portal.ts`：挂载 `/api/admin/llm/*`（复用管理员 401/403 守卫）与 `/api/portal/llm/usage`（仅返回当前租户脱敏只读用量）。
- `src/admin/AdminLlmSection.tsx`（新建）& `src/admin/AdminConsoleApp.tsx`：在租户区块下方新增“模型配置与定价”区块，支持保存、脱敏后 4 位展示、测试连通性（失败不改生效配置）、轮换 Key 二次确认。
- `src/portal/CustomerPortalApp.tsx`：在“消耗”页新增只读“模型用量”区块，不展示 Key、地址、成本价。
- `server/llm-proxy/llm-proxy.test.ts`：新增并发 `addUsage`、401/403 权限、脱敏、空 Key 保留、`https://` 校验、定价 `price >= cost` 校验、按定价表记账、超额度 402 熔断与调大额度恢复、测试连通性、二次确认轮换 Key、环境变量首次迁移与重启后 DB 优先等隔离 e2e 用例。

## 验证证据

- `./node_modules/.bin/vitest run server/llm-proxy/llm-proxy.test.ts server/portal/portal.test.ts scripts/testing/file-size-ratchet.test.ts`：3 个文件 13/13 通过（含 `llm-proxy.test.ts` 7/7、`portal.test.ts` 5/5、`file-size-ratchet.test.ts` 1/1）。
- `./node_modules/.bin/vitest run server/portal/unified-login.test.ts`：2/2 通过。
- `./node_modules/.bin/vitest run server/tickets/ server/approvals/ server/routing/ server/patrol/ server/memory-skill/ server/isolation/ server/gateway/`：59/59 回归通过。
- `./node_modules/.bin/oxlint --deny-warnings ...`：16 个改动文件 0 warnings, 0 errors。
- `./node_modules/.bin/tsc -b`：0 errors（注：`tsc -p tsconfig.server.json` 存在 2 个与本次无关的既有文件错误：`server/patrol/engine.ts:454` 与 `server/memory-skill/memory-skill.test.ts:568`，本次所有改动文件 0 类型错误）。
- `./node_modules/.bin/vite build`：22.26s 构建通过。

## 待维护者审核

- 10.2 手动浏览器验收（`/admin` 配 Key、`/portal` 看用量，确认无明文 Key 泄露）。
- 10.3 / 10.4 确认通过后执行 `openspec archive add-admin-llm-config`、更新 `openspec/WORKSPACE.md`、commit 并推送 `origin/main`。
