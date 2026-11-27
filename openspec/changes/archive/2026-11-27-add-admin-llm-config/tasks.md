# Tasks: add-admin-llm-config

> 执行前先读 `design.md` §2 的复用盘点，在 Mac 本地逐项核对文件名和函数名，名字以本地为准。
> 每完成一步跑一次对应测试，不要攒到最后一起跑。
> 不要把真实 Key 写进代码、测试、文档、commit message。

## 0. 复用盘点（只读，不改代码）

- [x] 0.1 打开 `server/llm-proxy/engine.ts`，确认 `registerProvider` 的 Vault secret 名格式、`defaultModel` / `fastModel` 默认值、`chatCompletions` 的记账兜底逻辑。
- [x] 0.2 打开 `server/portal/store.ts`，确认 `portal.sqlite` 建表位置和迁移方式。
- [x] 0.3 打开 `server/routes/portal.ts`，确认 `/api/admin/*` 的守卫函数名和 401/403 返回方式。
- [x] 0.4 打开 `src/admin/AdminConsoleApp.tsx`，确认 `refreshAll` 和 `adminApi` 的写法。
- [x] 0.5 打开 `server/index.ts`，确认 `createPortalHost` 参数和 `llmProxy` 创建位置。
- [x] 0.6 确认 `server/routing/jev.ts` 不用改（500ms 超时、0.6 阈值保持不变）。

## 1. 共享类型

- [x] 1.1 `shared/llm-proxy.ts` 增加 `AdminLlmProviderView`、`LlmPricing`、`TenantLlmUsage`，字段按 `design.md` §3.2。
- [x] 1.2 跑 `pnpm typecheck`，确认无类型错误。

## 2. 数据库

- [x] 2.1 `server/portal/store.ts` 增加 `llm_providers`、`llm_pricing`、`llm_usage_daily` 三张表（SQL 按 `design.md` §3.1）。
- [x] 2.2 新建 `server/llm-proxy/store.ts`，实现 `listProviders`、`getProvider`、`upsertProvider`、`getPricing`、`upsertPricing`、`addUsage`、`getUsage`。
- [x] 2.3 `addUsage` 用 `INSERT ... ON CONFLICT DO UPDATE` 累加，写一个并发累加的单元测试。

## 3. 代理改造

- [x] 3.1 `server/llm-proxy/engine.ts` 增加 `loadProvidersFromStore(store)`，启动时从库加载已启用的 Provider，Vault 无 Key 的行跳过并记日志。
- [x] 3.2 增加 `updateProvider(input)`，有新 Key 先写 Vault 再更新内存，无新 Key 只改配置。
- [x] 3.3 增加 `testProvider(id)`，用 `fastModel` 发最小调用（`max_tokens: 5`），超时 5 秒，失败不改变生效配置。
- [x] 3.4 改 `chatCompletions`：调用前查当日用量，超 `maxTokensPerDay` / `maxCostPerDay` 直接抛 402；调用后按定价表算 `cost` / `revenue`，写 `llm_usage_daily`，更新虚拟令牌用量。
- [x] 3.5 跑 `server/llm-proxy/llm-proxy.test.ts`，确认现有用例仍通过。

## 4. 管理员操作

- [x] 4.1 `server/portal/admin.ts` 的 `AdminOpsDeps` 增加 `llmProxy` 和 `llmStore`。
- [x] 4.2 实现 `listLlmProviders`，只返回脱敏视图。
- [x] 4.3 实现 `saveLlmProvider`，校验 `baseUrl` 必须 `https://` 开头、`defaultModel` 必填、`apiKey` 为空 = 不改 Key。
- [x] 4.4 实现 `rotateLlmApiKey`，需 `confirm: true`，旧 Key 立刻失效，记审计。
- [x] 4.5 实现 `testLlmProvider`，透传 `llmProxy.testProvider` 的结果。
- [x] 4.6 实现 `setLlmPricing`，校验 `price >= cost`，否则 400。
- [x] 4.7 实现 `setTenantLlmBudget` 和 `getTenantLlmUsage`。
- [x] 4.8 每个方法末尾调 `recordAudit`，`after` 里不写 Key。

## 5. 路由

- [x] 5.1 `server/routes/portal.ts` 增加 `GET /api/admin/llm/providers`、`POST /api/admin/llm/providers`、`PUT /api/admin/llm/providers/:id`。
- [x] 5.2 增加 `POST /api/admin/llm/providers/:id/test`、`POST /api/admin/llm/providers/:id/rotate`。
- [x] 5.3 增加 `GET/PUT /api/admin/llm/pricing/:providerId`、`GET /api/admin/llm/usage/:tenantId`、`PUT /api/admin/llm/tenants/:tenantId/budget`。
- [x] 5.4 增加 `GET /api/portal/llm/usage`，只返回当前租户用量，不返回 `baseUrl`、Key、成本价。
- [x] 5.5 验证：未登录调 `/api/admin/llm/*` 返回 401；客户账号调返回 403。

## 6. 启动迁移

- [x] 6.1 `server/index.ts`（经 `server/portal/host.ts` + `PortalEngine`）增加启动迁移：`llm_providers` 为空且环境变量齐全时，把环境变量写进库 + Vault，`id` 为 `primary-deepseek-relay`。
- [x] 6.2 启动后调用 `loadProvidersFromStore`，把 `llmProxy` 注入 `PortalAdminOps`。
- [x] 6.3 验证：已配置环境变量的老部署，首次启动后 `/api/admin/llm/providers` 能看到迁移后的 Provider，且 Key 仍可用。

## 7. 前端：管理后台

- [x] 7.1 新建 `src/admin/AdminLlmSection.tsx`，表单字段按 `design.md` §6.1（名称、地址、Key 密码框、默认模型、分流小模型、成本价、售价、启用开关、保存/测试/轮换）。
- [x] 7.2 `src/admin/AdminConsoleApp.tsx` 的 `refreshAll` 增加拉取 `/api/admin/llm/providers`，在租户区块下方渲染 `AdminLlmSection`。
- [x] 7.3 Key 输入框 `placeholder="已配置 ****1234，留空不改"`，保存后只显示后 4 位和更新人/时间。
- [x] 7.4 测试失败时显示错误，不改变生效配置；轮换 Key 需二次确认。

## 8. 前端：客户门户

- [x] 8.1 `src/portal/CustomerPortalApp.tsx` 增加只读“模型用量”区块：模型名、今日/当月 token、费用、剩余额度。
- [x] 8.2 数据来自 `GET /api/portal/llm/usage`，页面上不出现 Key、地址、成本价。

## 9. 测试

- [x] 9.1 `server/llm-proxy/llm-proxy.test.ts` 补用例：保存 Provider 后接口只返回 `apiKeyLast4`；不填 Key 保存不改变旧 Key；轮换后旧 Key 401、新 Key 可用。
- [x] 9.2 补用例：租户超 `maxTokensPerDay` 再调返回 402，不扣费。
- [x] 9.3 补用例：一次调用后 `llm_usage_daily` 的 input/output/cost/revenue 与定价表一致。
- [x] 9.4 补用例：客户账号调 `/api/admin/llm/providers` 返回 403；未登录返回 401。
- [x] 9.5 跑全量：控制面 Vitest 全绿、前端 `tsc -b`、`oxlint --deny-warnings`、`vite build`、`file-size-ratchet.test.ts` 全通过。
- [x] 9.6 隔离 e2e：在临时目录起隔离 harness，跑通：管理员保存 → 测试连通性 → 客户调用一次 → 管理员看用量 → 超额度熔断 → 轮换 Key。

## 10. 验收与归档

- [x] 10.1 跑 `openspec validate --all --strict --no-interactive`，全部通过。
- [x] 10.2 手动验收：维护者于 2026-11-27 审核通过。
- [x] 10.3 按工作区规则归档：`openspec archive add-admin-llm-config`，再跑一次 validate，commit 并推送到 `origin/main`。
- [x] 10.4 在 `openspec/WORKSPACE.md` 记录本次 change 的完成情况和验证结果。

## 预计时间

- 后端（类型 + 数据库 + 代理 + 管理员操作 + 路由）：3–5 天
- 启动迁移 + 前端（管理后台 + 客户门户）：2–3 天
- 测试 + 验收 + 归档：1–2 天
- 合计：1–2 周
