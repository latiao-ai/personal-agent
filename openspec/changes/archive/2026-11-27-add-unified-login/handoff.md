# Handoff: 统一登录 + 任意 Bot 接消息平台 + 中转 DeepSeek `add-unified-login`

- Change: `add-unified-login`
- 阶段：`add-customer-portal`（d04dfe7）之后，MVP6 部署之前
- 时间：3–4 周（估计值，本地 agent 按第 0 步盘点后确认）
- 状态：**定稿，待 R1**（2026-11-27 14:36 用户说“帮我详细整理一下最新的 change，以及需要的详细文件”，本包即定稿版；此前 2026-11-27 中午的包是草稿，等用户补完其余几处再定稿，现已补完）
- 依据：2026-11-27 白天用户在主聊天里陆续定的事；2026-11-27 当天查 Hermes 文档后总结的参考实现（见 design.md §4.1）。

## 背景（2026-11-27，聊天里陆续定的）

- 用户把最新项目推到 GitHub（`d04dfe7`，add-customer-portal 实现），问怎么启动。启动时撞上旧服务没关干净抢锁（进程 1638），又撞上 `/admin` 登录框问账号密码——代码里根本没有默认账号密码，管理员账号只靠启动时环境变量 `OMB_ADMIN_USERNAME` / `OMB_ADMIN_PASSWORD` 在 `portal.sqlite` 里创建。
- 用户问两个页面有什么区别，又问“为什么要分成两个页面，之后不都是统一的账号登录然后管理员登录就跳转到后台管理”。用户自己给出了成熟产品该有的样子：一个登录入口，登录后按角色跳。Muse 当时提议写成下一个 change `add-unified-login`，用户说“可以，先记住这个要修改的地方，我之后还想再这一次 change 里多修改几处地方”。
- 之后陆续定下来的事（都在 proposal / design 里写明了）：
  - 飞书扫码登录那个配对修复不要了，以后改走账号密码登录。
  - 飞书群一般接管理 Bot，但也要提供用户自己任意的 Bot 都能接飞书。
  - 手机号注册登录先不做，只保留账号密码；注册必须在后台管理页面（`/admin`）里做。
  - 老账号（唐浩南那个）不用绑手机号，单独给它设一个账号密码登录，专门留着测试用。
  - 用户问“辣条智能体到底接的哪个 AI / 哪个 Bot”，查出来是隔离测试 Bot `FeishuBaselineProbe`（`e7f85baa-78b8-471d-bcab-fd966ec7d8e5`，隔离 harness 端口 19896），回的是假引擎写死的 `hello from fake claude`；飞书网关是手动跑的 Python 脚本，`pnpm` 启动项目的时候不带它。
  - 用户问 Hermes 的网关为什么一直在线，查出来 Hermes 是常驻服务 + 按 profile 绑平台适配器；用户让参考 Hermes 的消息平台做法，任意 Bot 接飞书或企业微信；2026-11-27 14:10 用户确认把 Hermes 式网关设计写进本 change。
  - 2026-11-27 14:12 用户说消息平台除了飞书，还可以加入一个微信，先不设置企业微信。定稿：平台是飞书 + 个人微信（Weixin，iLink），企业微信（WeCom）延后。
  - 2026-11-27 14:21 用户说每个 Bot 回答时调第三方中转站的 DeepSeek，问 harness 能不能换成 Hermes Agent。Muse 解释了两层：中转 DeepSeek 可以马上做；Hermes 当执行引擎代价大，要重做 MVP1–MVP6。用户原目标确实是引擎换 Hermes 以吃到快速更新，Muse 当时把目标记小了，已在 MEMORY.md 里纠正。
  - 2026-11-27 14:33 用户决定执行层先不换 Hermes，继续用 OpenMausBot harness。本 change 只做“借 Hermes 网关的分层”，不做“换 Hermes 当执行引擎”。
  - 2026-11-27 14:34 用户说创建账号密码时，新账号 `tanghaonan`，建完自动跳转到这个测试账号上。已写入 proposal / design / specs / tasks；密码值不写进任何文件、记忆或提交。

## 已确认的基线

- 代码基线：`5987204e3`
- 工作基线：`92eb6457ff128d4bbbd622ab9e4b42da4200f473`
- 最新 HEAD：`d04dfe7`（2026-11-27 10:01 核对，今日未再核对，如 HEAD 已变，以本地 `git log` 为准）
- 本地路径：`/Users/latiao/OpenMausBot`
- 远程仓库：https://github.com/latiao-ai/personal-agent
- `add-customer-portal`：已实现并推送 `d04dfe7`。本 change 复用的已有成果：`/portal` 和 `/admin` 两个路由、双通道审批、SSE 推送、服务端按 `tenant_id` 隔离。只加登录入口和守卫，不重做。
- MVP6：代码已完成并推送 `55214e7`，待 R1。本 change 可以先做，不等 MVP6；但网关常驻服务要和 MVP6 的部署规则对上，不要写两套规则。
- `add-credential-proxy`：文件已到，待 R1（Bot 登录平台、凭据代理那套）。本 change 是另一条线：客户 / 管理员登录 Web 后台 + Bot 接消息平台 + 中转 DeepSeek，两边不要混在一起。
- Lima + Firecracker：2026-11-27 在 M4 Mac 的 omb-test Lima VM 里验证通过，`/dev/kvm` 可用，Firecracker v1.18.0（aarch64），microVM 启动成功。完整步骤见 `~/workspace/mac-lima-setup.md`。阿里云普通 ECS 没有 `/dev/kvm`，跑不了 Firecracker。

## 复用盘点（第 0 步，已完成本地核对）

| 模块 / 路径 | 现状（已有） | 变更策略（已有 / 要改 / 要新建） | 具体改动点 |
| --- | --- | --- | --- |
| `src/main.tsx` | 已分发 `/portal`（懒加载 `CustomerPortalApp`）与 `/admin`（懒加载 `AdminConsoleApp`），并列入 `PAGES_WITHOUT_THE_APP` | **要改** | 增加 `/login` 路由分发，懒加载新建的统一登录页 `src/login/UnifiedLoginPage.tsx` |
| `src/portal/CustomerPortalApp.tsx`、`src/admin/AdminConsoleApp.tsx` | 各自内嵌登录框（飞书扫码 / 管理员表单）；6 页客户门户与管理后台业务完整 | **要改** | 保留全部业务页面，收掉内嵌登录框（未登录跳转 `/login`）；客户门户新增 Bot「消息平台」页（飞书/个人微信绑定与网关状态、飞书/微信身份绑定）；管理后台新增统一账号管理（建号/改密/停用）及建完自动跳转测试账号 |
| `server/portal/engine.ts`、`server/portal/admin.ts` | 已有 `PortalEngine` + `PortalAdminOps`（scrypt+盐哈希、管理员建号/登录/吊销、QR 登录、租户隔离、审计） | **要改** | 复用 scrypt 哈希与审计；新增统一账号管理（客户+管理员）、统一登录、测试账号一键会话跳转、老账号 `tanghaonan` 密码登录、`ChannelBinding`/`UserIdentity`/`WeixinIdentity`/租户白名单操作；保留 QR 接口但不作为登录入口 |
| `server/routes/portal.ts`（注：非 `server/portal/routes/portal.ts`） | 已有 `/api/portal/*` 与 `/api/admin/*` 全套接口与 Cookie 鉴权 | **要改** | 新增 `/api/auth/login`、`/api/auth/me`、`/api/auth/logout`、拒绝 `/api/auth/register`（403）；新增 `/api/admin/users/*`、`/api/portal/channels/*`、`/api/portal/identities/*` |
| `server/portal/host.ts`、`server/index.ts` | `createPortalHost` 未传 `bootstrapAdmin`（由 `PortalEngine` 读 `OMB_ADMIN_USERNAME`/`OMB_ADMIN_PASSWORD` 兜底）；静态路由直接放行 `/portal`、`/admin` | **要改** | 在 `server/index.ts` 静态路由前加服务端页面级路由守卫（未登录 302 → `/login`，角色不符 302/403）；挂载常驻网关托管与 `/api/llm/v1/*` 控制面 LLM 代理 |
| `portal.sqlite`（`server/portal/store.ts`） | 已有 `tenant_members`、`qr_challenges`、`customer_sessions`、`admin_accounts`、`admin_sessions`、`tenant_bot_states`、`tenant_schedules`、`tenant_approvers`、`memory_suggestions`、`core_skill_change_requests`、`portal_audit_log` | **要改** | 新增表：`portal_users`、`channel_bindings`、`user_identities`、`weixin_identities`、`tenant_channel_allowlists` |
| `scripts/feishu_gateway.py`、`scripts/feishu_relay.py` | 手动运行的 Python 单 Bot 脚本（写死 `--bot`、`--thread`、`--port`），路由 JSON 为 `open_id → thread`，去重库 `deliveries.sqlite3` | **要新建（替代）** | 新建控制面多平台常驻网关 `server/gateway/`（`FeishuAdapter`、`WeixinAdapter`、`WeComAdapter` 占位、单消费者锁、`event_id` 去重、按 `ChannelBinding`+`tenant_id` 路由、热加载）及 macOS `launchd` / Linux `systemd` 模板 |
| 模型调用层与控制面 LLM 代理 | 已内置 `openai-compat` 驱动（`docs/custom-engines.md`）、`ControlPlaneVault`（`server/approvals/vault.ts`）、`server/routing/jev.ts`（500ms 超时回落 lead bot）；尚无控制面 LLM 代理 | **要新建 + 要改** | 新建 `server/llm-proxy/`（OpenAI 兼容转发、主 Key 仅存 Vault/控制面环境变量、租户临时虚拟令牌、限流/预算熔断/降级）；接入 Jev 小模型；启动/健康检查支持 LLM 代理可达替代本地 CLI |
| Hermes & 个人微信 iLink 文档核对 | 2026-11-27 联网核对 | **已核对** | 飞书推荐 WebSocket 长连接，权限含 `im:message`、`im.message.receive_v1`、`im:message:send_as_bot`、`im:message:send`（卡片回调必需，防 200340）、`im:resource`、`im:chat`、`card.action.trigger`；注意通讯录权限下 `user_id`/`open_id` 解析差异；个人微信走腾讯 iLink Bot API 长轮询 + 扫码生成 `xxx@im.bot`，私聊为主、一般不能进普通微信群 |
| 中转站与基线状态 | `add-customer-portal` 已推送（`d04dfe78e`）；MVP6 `add-isolation-deploy` 已完成归档并推送（`55214e76a`）；仓库无硬编码中转站 Key | **已核对** | 中转站 `base_url` / 总 Key / 模型名通过控制面环境变量与 Vault 注入（`OMB_LLM_RELAY_BASE_URL`、`OMB_LLM_RELAY_API_KEY`、`OMB_LLM_RELAY_MODEL`、`OMB_LLM_RELAY_FAST_MODEL`），不硬编码厂商或 Key |

## 批准

- 批准：R1，2026-11-27，用户回复“批准 R1，可以做”，范围只限 proposal 里写的，不扩范围。
- 要扩大范围，必须出 R2，重新批。不能在改代码的时候偷偷扩。尤其注意：不要在本 change 里做手机号注册登录，不要修飞书扫码登录那个配对，不要做企业微信，不要把执行层换成 Hermes Agent，不要删 `/portal` 和 `/admin` 的业务代码。

## 做到哪了

- tasks.md 第 0–6 步及第 7 步任务 28：全部实现并完成隔离验证，**待维护者最终审计与归档推送（任务 29）**。
- 关键产出文件：
  - 共享契约：`shared/portal.ts`、`shared/gateway.ts`、`shared/llm-proxy.ts`
  - 统一登录与账号/身份/绑定控制面：`server/portal/store.ts`、`server/portal/admin.ts`、`server/portal/unified.ts`、`server/portal/engine.ts`、`server/portal/host.ts`、`server/routes/portal.ts`、`server/index.ts`
  - 多平台常驻网关：`server/gateway/adapters.ts`、`server/gateway/engine.ts`、`server/gateway/host.ts`、`scripts/gateway-daemon.ts`、`deploy/gateway/com.openmausbot.gateway.plist`、`deploy/gateway/openmausbot-gateway.service`
  - 控制面 LLM 代理（中转 DeepSeek）：`server/llm-proxy/engine.ts`、`server/llm-proxy/routes.ts`、`server/llm-proxy/host.ts`
  - 前端统一登录与门户/后台增强：`src/main.tsx`、`src/login/UnifiedLoginPage.tsx`、`src/portal/CustomerPortalApp.tsx`、`src/portal/ChannelPlatformsTab.tsx`、`src/admin/AdminConsoleApp.tsx`、`src/admin/AdminUsersSection.tsx`
  - 自动化测试：`server/portal/unified-login.test.ts`、`server/gateway/gateway.test.ts`、`server/llm-proxy/llm-proxy.test.ts`
- 验证证据（2026-11-27，全部在隔离临时目录/隔离回环端口中完成，未触碰运行中应用或真实数据）：
  - `vitest run`（11 个测试文件，**71/71 通过**）：`unified-login.test.ts` (2/2)、`portal.test.ts` (5/5)、`gateway.test.ts` (4/4)、`llm-proxy.test.ts` (4/4)、`routing.test.ts` (8/8)、`index-route-ratchet.test.ts` (1/1) 及 MVP2a–MVP6 回归（`tickets` 8/8、`approvals` 7/7、`patrol` 10/10、`memory-skill` 13/13、`isolation` 9/9）。
  - `oxlint --deny-warnings`（全部 26 个改动/新增文件）：0 warnings, 0 errors。
  - `tsc -b` + `vite build`：全部通过（15.22s）。
  - `openspec validate --all --strict --no-interactive`：11/11 全部通过。
- 未在隔离单测覆盖的真实外部环境项：真实飞书开放平台外部群对外共享发布（见 design.md §4.6）、真实个人微信手机扫码长轮询与真实第三方中转站在线联调（需填入维护者本机真实 `OMB_LLM_RELAY_BASE_URL` / `OMB_LLM_RELAY_API_KEY`）。

## 卡在哪

- 无阻塞；维护者已于 2026-11-27 最终审计通过（“通过，归档并推送”），进入归档与推送。

## 延后（本次明确不做，以后再议）

- 执行层换成 Hermes Agent：2026-11-27 14:33 用户决定先不换。涉及的 8 件（模型 CLI→中转、Bot→Hermes profile、记忆、routine、审批、工具、网关、前端）记在这里，以后再议；其中“模型走中转 DeepSeek”和“网关按 Hermes 分层”这两件，本次已经做了。
- 手机号注册 / 登录、企业微信（WeCom）、飞书扫码登录配对修复、老账号绑手机号：全部不做，见 proposal“不动什么”。

## 下一步

1. 用户批 R1（回“可以做”）。
2. 在 Mac 上：
   ```bash
   cd /Users/latiao/OpenMausBot
   openspec new change add-unified-login
   ```
   把本包的 5 个文件复制到刚生成的同名目录里，**文件要和隐藏的 `.openspec.yaml` 在同一层，不要嵌套一层多余的文件夹**。
3. 按 tasks.md 第 0 步先做复用盘点，填上面“复用盘点”一节，确认哪些是复用、哪些是新建，再写正式代码。
4. 按 specs/unified-login.md 一条一条测，在隔离测试环境中测，尤其要测没登录直开路由、角色不对串页面、一个群两个 Bot 抢回、不属于这个租户的群发消息、杀掉网关进程、停掉本地 CLI 这六种坏情况。
5. `openspec validate --all --strict --no-interactive` 通过后，`openspec archive add-unified-login`，再推到 GitHub。
6. 本 change 完成后，再开 MVP6 `add-isolation-deploy` 的部署那一步（文件已到，待 R1；代码已在 main，部署还没做）。
