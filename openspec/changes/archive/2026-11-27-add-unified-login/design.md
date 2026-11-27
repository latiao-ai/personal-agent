# Design: add-unified-login（统一登录 + 任意 Bot 接消息平台 + 中转 DeepSeek）

- Change: `add-unified-login`
- 阶段：`add-customer-portal`（d04dfe7）之后，MVP6 部署之前
- 时间：3–4 周（估计值，本地 agent 按第 0 步盘点后确认；草稿版约 1 周是只算统一登录 + 绑定表，本次加了常驻网关、个人微信、中转 DeepSeek 三件，时间相应拉长）
- 状态：定稿，待 R1

## 1. 架构图（文字版）

```
  未登录
      │
      ▼
  /login（唯一入口，账号 + 密码）
      ├─ 客户账号 ──► /portal（他自己的租户）
      └─ 管理员账号 ─► /admin（所有租户）
            │
            │ 服务端路由守卫（没登录 → /login；角色不对 → 自己的页面 / 403）
            ▼
  ┌──────────────────────────────────────────────────────┐
  │  控制面 / 服务端                                        │
  │    账号表：账号 → user_id → tenant_id（密码哈希存库，      │
  │      不靠启动环境变量；管理员在 /admin 里建账号）           │
  │    Bot 表：bot_id，tenant_id，owner_user_id              │
  │    ChannelBinding（绑定表）：见第 4 节                     │
  │    UserIdentity：user_id，tenant_id，feishu_open_id       │
  │    LLM 代理：中转站总 Key 在 Vault，VM 只拿临时令牌        │
  │    路由守卫：每个请求先验 session，再验 tenant_id 和角色    │
  └──────────────────────────────────────────────────────┘
        │ 飞书 / 个人微信消息进来
        ▼
  ┌──────────────────────────────────────────────────────┐
  │  网关（一个常驻进程，平台只是一个适配器）                  │
  │    FeishuAdapter / WeixinAdapter：收消息 → 统一格式        │
  │    按绑定表路由：(平台, chat_id) → bot_id → tenant_id     │
  │    回复原路返回；WeComAdapter 本次只留占位                 │
  └──────────────────────────────────────────────────────┘
        │
        ▼
  对应 Bot 的会话（按租户隔离）
        │
        ▼
  模型：控制面 LLM 代理 → 中转站 → DeepSeek（不再走本地 CLI）
```

**读图规则**：登录只认账号和角色，页面只认路由守卫，消息只认绑定表，模型只认控制面 LLM 代理。四样都不要靠前端藏起来，也不要靠本机 CLI。

## 2. 统一登录入口

### 2.1 现在的三套入口

| 入口 | 现在是谁在用 | 现在的登录方式 |
|---|---|---|
| `/` 主界面 | 运营 / 开发者（用户自己） | 没有登录，单机单用户，数据在 Mac 的 `~/.openmausbot` 里，账号是“唐浩南” |
| `/portal` | 客户 | 设计上是飞书扫码登录，但扫码链路是断的（见 proposal） |
| `/admin` | 管理员 | 环境变量 `OMB_ADMIN_USERNAME` / `OMB_ADMIN_PASSWORD`，启动时在 `portal.sqlite` 里创建一个管理员账号；没设这两个变量就一个管理员都没有；第一次创建之后再改环境变量不会改密码 |

### 2.2 改成之后

```
未登录 → /login
         ├─ 账号 + 密码 → 是客户 → /portal（他自己的租户）
         └─ 账号 + 密码 → 是管理员 → /admin（所有租户）
```

- `/login` 里就是账号密码登录，客户账号和管理员账号都在这里登，不再分两个登录框。管理员单独用账号密码、不用飞书扫码，这个分开是有意的：管理员能看所有客户、能上下线租户，身份不能和客户混。但登录入口可以统一，里面分两个 tab 也行，进去之后再按角色跳转。
- `/portal` 和 `/admin` 这两个页面本身保留，不删也不只是藏起来。删了会断书签、飞书里的链接和已经写好的跨租户 403 测试；只靠前端藏也没用，地址栏直接输还是能打开。
- 真正起作用的是服务端的守门：
  - 没登录，直接打开 `/portal` 或 `/admin` → 跳回 `/login`
  - 客户登录了，却打开 `/admin` → 跳回他自己的 `/portal`，或者报 403
  - 管理员登录了，打开 `/portal` → 跳回 `/admin`
- 现在那个各管各的登录框收掉：以后登录只在 `/login` 做一次，进了自己的页面就不用再登一次了。

### 2.3 账号怎么来、怎么管

- 手机号先不做，只保留账号密码。注册不开放给用户自己注册，暂定必须在后台管理页面（`/admin`）里注册，由管理员来建账号。
- 管理员账号不能再只靠启动时的环境变量：新账号的创建、改密码、停用，都要落在 `/admin` 的管理界面里。`OMB_ADMIN_USERNAME` / `OMB_ADMIN_PASSWORD` 只留作第一次冷启动建第一个管理员的办法，建完之后就走管理界面，不要再靠改环境变量 + 重启来管账号。
- 密码存哈希，不存明文；密码不要写进代码、不要提交到 GitHub、不要出现在日志里。沿用 `server/portal/admin.ts` 的 scrypt 哈希 + 盐，不新发明一套。
- 老账号（唐浩南那个）不用绑手机号，单独给它设一个账号密码登录，专门留着测试用。手机号注册的账号是另外一套，走它自己的租户和 Bot，不跟老账号混在一起。
- **建完自动跳到测试账号**：管理员在 `/admin` 里建完一个账号（测试账号用户名为 `tanghaonan`，密码由创建时设定，本包不写密码值），管理后台自动跳转到这个新建的测试账号上，方便马上验证。跳转时不要把明文密码带在 URL 里；跳转后用新建账号的 session 直接进 `/portal`，不要再让管理员手动登一次。

## 3. 身份映射：登录后怎么知道是哪个用户的 Bot、哪个 Bot 接了哪个群

手机号登录只是认出“你是谁”，账号密码登录也一样。之后能不能看到哪个 Bot、哪个 Bot 接了哪个飞书群，都是靠数据库里这几张表的关联：

```
账号 → user_id → tenant_id → Bot 列表
                              → 飞书绑定记录
```

**1. 账号登录，先认出 tenant**
注册时账号唯一，生成一个 `user_id`，再对应一个 `tenant_id`。一个用户目前就是一个租户。登录成功后，session 里就带着 `user_id` 和 `tenant_id`。之后在 `/portal` 里看到的所有东西，后端都要拿这个 `tenant_id` 去过滤，只返回这个租户的 Bot、Ticket、审批、消耗，别的租户的一条也看不到。这就是现在 portal 里已经在做的服务端隔离，账号密码登录只是把原来靠 `open_id` 认人，换成靠账号认人。

**2. Bot 归属，看 Bot 表里的 tenant_id**

```
Bot：bot_id，tenant_id，owner_user_id
```

登录后查 Bot 列表，就是 `where tenant_id = 你登录的那个 tenant_id`。所以登录后看到的，就是自己的 Bot，不会看到别人的。

**3. Bot 接了哪个飞书群，看一张绑定表**
见第 4 节的 `ChannelBinding`。一个 Bot 可以接多个群，所以这是一对多。一个群一般只让一个 Bot 回话，不然两个 Bot 会抢着回。

**4. 两边怎么对上，分两个方向**

- *在 portal 里看：* 登录 → 查自己的 Bot 列表 → 对每个 Bot 再查绑定表 → 有记录的就显示“已接入飞书群：test 群”，没记录的显示“未接入”。这个判断完全在服务端做，不是前端藏起来的。
- *在飞书群里收到消息时：* 网关收到消息，拿到 `chat_id` → 查绑定表找到 `bot_id` → 再查这个 Bot 的 `tenant_id` → 确认这个群确实属于这个租户 → 才把消息转给这个 Bot。

**5. 账号和飞书 open_id 要绑在一起**
账号是你登录用的身份，飞书里认人用的是 `open_id`，这是两套身份。光有账号登录，还不知道你在飞书里是谁。所以用户第一次在 portal 里，要做一次绑定：比如在飞书群里 @ 机器人发一个绑定码，或者在 portal 里点“绑定飞书账号”，用飞书扫一下。绑完之后就多一条：

```
UserIdentity：user_id，tenant_id，feishu_open_id
```

之后飞书群里谁说话、谁审批，都能对应回这个账号密码注册的用户。个人微信同理，再加一张 `WeixinIdentity`（`user_id`，`tenant_id`，`weixin_open_id` / iLink 账号 ID），不要把微信和飞书的身份混在一张表里。

## 4. 任意 Bot 接消息平台：照 Hermes 的做法改，本次就做常驻网关

### 4.1 Hermes 是怎么做的（2026-11-27 查 Hermes 文档后总结）

核心就一句话：**网关是一个常驻进程，平台只是一个适配器，Bot 是按 profile 绑定的，不是按进程绑定的。**

- **一个网关进程同时接所有平台**：网关是单个后台进程，接所有配置好的平台，处理会话、跑定时任务、发语音消息。飞书、企业微信、Telegram、Discord 在 Hermes 里不是各跑一个脚本，而是 `gateway/platforms/` 下面各一个适配器，收到的消息都先变成统一格式，再按会话分发给对应的 Agent。
- **任意一个 Bot 怎么接**：在 UI 里点需要绑定的那个 Bot 的 profile，进「消息平台」，找到飞书，把 App ID 和 App Secret 填进去，保存；选企业微信就填 Bot ID 和 Secret，保存，重启网关。底层是每个 profile 各自一份配置和凭据：每个 profile 有自己的 `.env` 放自己的 token，`config.yaml` 里有 `platforms.<平台>` 一块，声明这个 Bot 要接哪个平台、主频道是哪个群。
- **一个凭据只能属于一个 Bot**：同一个 `(平台, token)` 在两个 profile 里会被停掉一个（`duplicate_credential`）。这也是用户之前 `lark-cli` 和网关抢同一个 App ID 会丢消息的原因。
- **飞书接法**：支持两种模式，推荐 WebSocket，不用公网 URL。权限和事件就几个：收消息 `im:message`、`im.message.receive_v1`；发消息 `im:message:send_as_bot`；读图片 / 文件 / 群信息 `im:resource`、`im:chat`；卡片按钮回调 `card.action.trigger`，还要在应用里开互动卡片能力。群里只回 @，私聊全回，群里不同人会话默认分开。
- **个人微信（Weixin）接法**：走腾讯 iLink Bot API，扫码登录，生成一个 iLink 机器人身份（例如 `xxx@im.bot`），不是你自己的个人微信号。主要是私聊能用，一般不能被拉进普通微信群。凭据是 iLink 账号 ID + token，存在每个 Bot 的配置里。
- **企业微信接法（本次不做，只作记录）**：不用建企业自建应用，是直接建一个智能机器人，凭据只有 Bot ID 和 Secret 两个，连腾讯的 WebSocket 网关（`wss://openws.work.weixin.qq.com`），发 `aibot_subscribe` 鉴权帧。断了自动重连是指数退避：2 秒、5 秒、10 秒、30 秒、60 秒，心跳 30 秒一次，消息按 ID 去重 5 分钟。
- **为什么 Hermes 的网关一直在线**：网关注册成系统服务（Linux 上 systemd、macOS 上 launchd），进程死了会被拉起来，WebSocket 断了 SDK 自己重连，两层保障。用户的网关现在是手动跑的 `python scripts/feishu_gateway.py`，终端一关、Mac 一睡、进程一死就没人拉起来。

> 上面 Hermes 的细节是 2026-11-27 当天查 Hermes 文档后在聊天里总结的，写进设计时只作参考实现，不是照抄代码。本地 agent 在第 0 步要按 Hermes 最新文档核对一遍适配器名、权限名和配置项，错的改过来，不要照抄旧的。

### 4.2 照搬到本项目里：分层照抄，代码不抄

不用照抄 Hermes 的代码，照抄它的分层就行：

**现在：**

```
飞书 App → 一个 Python 进程 → 固定 --bot → 固定 --thread
```

**改成 Hermes 式：**

```
飞书 App / 个人微信 iLink Bot
      ↓
一个常驻网关（控制面服务，systemd / launchd）
      ↓
平台适配器：FeishuAdapter / WeixinAdapter，统一收消息格式
      ↓
按绑定表路由：(平台, chat_id) → bot_id → tenant_id
      ↓
对应 Bot 的会话，回复原路返回
```

### 4.3 绑定表：落到控制面数据库里

Hermes 里对应的是每个 profile 的 `platforms` 配置，本项目要落到控制面数据库里：

```
ChannelBinding
  bot_id, tenant_id
  platform: feishu / weixin
  platform_app_id / bot_id
  feishu_chat_id / weixin_chat_id
  chat_type: p2p / group
  status: active / disabled
```

在 portal 里给每个 Bot 加一个「消息平台」页，选飞书就填 App ID / Secret，选个人微信就走 iLink 扫码，保存后网关热加载，不用重启整个项目。企业微信本次不做，`WeComAdapter` 只留一个空接口 / 占位。

### 4.4 常驻网关怎么做

- **Mac 本地**：launchd 用户服务，跟着登录启动；`pnpm dev:server` 启动项目时，网关也要跟着起来，不要再靠手动开第三个终端跑 Python 脚本。
- **Linux 服务器**：systemd 用户服务 / 系统服务，`Restart=always`，进程退出自动拉起；开机自启。
- **断线重连**：WebSocket 层靠 Lark SDK / iLink SDK 自己重连（指数退避）；进程层靠 systemd / launchd 拉起。两层都要有，只做一层不够。
- **唯一消费者**：启动时声明“本应用唯一消费者”，`lark-cli` 等同凭据客户端必须停掉；投递按 `event_id` 去重，飞书重投不重复回复。
- **网关日志**：网关的收发、路由、拒绝、重连都要记日志，日志存在控制面，portal 里能看到网关状态（在线 / 离线 / 重连中），不要让用户靠 `ps aux | grep feishu_gateway` 去猜网关在不在。

### 4.5 两个地方不能照搬 Hermes

1. **Hermes 是单用户多 profile，本项目是多租户**：绑定表里必须带 `tenant_id`，网关收到消息先验租户，再验 Bot，不能只按 `chat_id` 查。白名单也要落到数据库里，按租户配，不能用 Hermes 那种 `FEISHU_ALLOWED_USERS=ou_xxx` 环境变量，不然一个客户改白名单会影响另一个客户。
2. **Hermes 的凭据是每个 profile 一份 `.env`**：本项目里平台凭据（App ID / Secret、Bot ID / Secret、iLink token）要进控制面 Vault，按租户分开，不能写进代码、不能提交到 GitHub、不能写进日志。

### 4.6 飞书外部群的限制（配置注意事项，不在本 change 的代码范围里）

用户那个 `test` 群是外部群，飞书只允许自定义机器人（webhook，只能单向推送，收不到消息）和开了“对外共享”的应用机器人被加进去。应用机器人要进外部群，需要：企业自建应用 → 完成企业 / 团队认证或个人实名认证 → 版本管理与发布里创建版本 → 对外共享勾上“允许机器人被添加到外部群中使用” → 审核发布。用户截图里开的“允许被其他机器人邀请进群”管的是机器人拉机器人，不是人在群里点“添加机器人”，而且改完不发布新版本是不生效的。先拿内部群验证收消息、@、回复都通了，再去搞外部群的认证和发布。群消息接收权限也要在开放平台开并发布新版本，不然机器人进了群也收不到 @。

## 5. 所有 Bot 统一走第三方中转 DeepSeek

### 5.1 现在

- 每个 Bot 回答时，harness 拉起本机装好并登录的 `claude / codex / grok` CLI，一个会话一个进程。
- 新装一台机器必须先装 CLI 并登录，不然模型选择器里没 Bot 可选；CLI 没登录、过期、被吊销，Bot 就回不了话。

### 5.2 改成之后

```
Bot → harness → 控制面 LLM 代理 → 第三方中转站 → DeepSeek
```

- **provider 配置**：在控制面配一个 OpenAI 兼容的 provider，`base_url` 填中转站地址，`api_key` 填中转站总 Key（只在控制面 Vault / LLM 代理层），`model` 填中转站支持的 DeepSeek 模型名（示例 `deepseek-chat` / `deepseek-v4-flash`，以本地核对的中转站文档为准）。
- **VM 只拿临时令牌**：VM 里不放总 Key，只拿带租户标识的内部虚拟 Key / 临时令牌访问控制面 LLM 代理，由控制面统一做限流、按用户 / Bot 计费、预算熔断和中转站切换。令牌过期、吊销、超预算都立即失效。
- **Jev 也可以走中转**：门口 Jev 快分流走中转站的小模型，不用再装本地模型；500 ms 超时回落到 lead bot 的规则不变。
- **本地 CLI 不再是前置**：新装一台机器，不装 `claude / codex / grok` 也能跑；已装 CLI 的机器也不再依赖它。启动检查里“至少一个 agent CLI 已登录”那一项，本次改完后改为“控制面 LLM 代理可达、中转站 Key 有效”。
- **不要把 Key 写进镜像**：中转站总 Key 不进代码、不进日志、不进 microVM 镜像、不进 `code.img`。测试阶段用 Lima 挂文件夹也一样，Key 只在控制面。

### 5.3 不换执行引擎

本次只换模型调用的路，不换执行引擎。继续用 OpenMausBot harness，Hermes Agent 当执行引擎那 8 件（Bot→Hermes profile、记忆、routine、审批、工具、网关、前端）本次不做，2026-11-27 14:33 用户已决定先不换。

## 6. 待核对（开始写代码之前，在本地核对这 10 项）

- [ ] `src/main.tsx`：`/portal` 和 `/admin` 两个路由现在是怎么分发的？懒加载的 `CustomerPortalApp` / `AdminConsoleApp` 在哪？`/login` 加在哪里最顺？
- [ ] `server/portal/engine.ts` 和 `server/portal/routes/portal.ts`：飞书扫码登录那套（`qrBaseUrl`、`qr/confirm`、5 分钟 TTL）现在是怎么写的？哪些可以删，哪些要留作以后参考？
- [ ] `server/index.ts` 里的 `createPortalHost`：现在有没有传 `bootstrapAdmin`？管理员账号的创建、改密码、停用，现在有没有管理界面，还是只能靠 `OMB_ADMIN_USERNAME` / `OMB_ADMIN_PASSWORD` 环境变量？
- [ ] `portal.sqlite`：账号、租户、Bot、绑定现在存在哪几张表里？`tenant_id` 现在是怎么分的？加 `ChannelBinding` 和 `UserIdentity` / `WeixinIdentity` 三张表要改哪些查询？
- [ ] `scripts/feishu_gateway.py`：现在启动参数 `--bot` / `--thread` / `--port` 是怎么传的？路由 JSON（`open_id` → 会话 ID）和 `deliveries.sqlite3` 现在长什么样？改成按绑定表路由，要动哪些地方？
- [ ] Hermes 最新文档：按第 4.1 节核对一遍适配器名、权限名（`im.message.receive_v1`、`im:message:send_as_bot`、`card.action.trigger` 等）和配置项，错的改过来。
- [ ] 个人微信 iLink：Hermes 的 Weixin 适配器现在是怎么扫码登录的？iLink 账号 ID / token 存在哪？群聊限制是不是还是“一般不能进普通微信群”？
- [ ] 中转站文档：中转站的 `base_url`、支持的 DeepSeek 模型名、Key 格式、限流和计费口径是什么？控制面 LLM 代理现在有没有（LiteLLM / 自建转发），还是要新建？
- [ ] 现有模型调用层：`server/ask-routing.ts`、`local-routing.ts`、`chief-of-staff.ts` 里调 CLI 的地方在哪？改成调 LLM 代理，要动哪些函数？
- [ ] 常驻服务：Mac 上 launchd 配置现在有没有（草稿里提到的 `feishu-gateway-autostart.md` + `feishu-gateway.plist`）？Linux 上 systemd 单元文件现在有没有？网关日志现在存在哪？

## 7. 风险

- 只在前端藏入口，不在服务端守门。防法：守卫必须在服务端做，前端藏入口只是体验，不是安全。
- 一个群两个 Bot 抢着回。防法：绑定表里一个群同一时间只允许一个 active 绑定，换绑要先解绑旧的；同一个 `(平台, token)` 在两个 Bot 里会被停掉一个。
- 平台凭据 / 中转站 Key 写进代码或提交到 GitHub。防法：凭据只放控制面 Vault / 本地配置，不进仓库、不进日志；中转站总 Key 不进 VM 镜像。
- 飞书外部群拉不进机器人，被当成代码问题。防法：先拿内部群验证，再按 4.6 节做对外共享认证和发布；群消息接收权限开了并发布新版本才算完。
- 网关常驻后，旧的手动脚本还在跑，两个网关抢同一个 App ID。防法：上线常驻网关前，先停掉手动跑的 `feishu_gateway.py` 和 `lark-cli`，启动时声明唯一消费者。
- 中转站挂了，Bot 全挂。防法：控制面 LLM 代理要做中转站切换 / 熔断，中转站不可用时按预算规则降级，不要让 Bot 无限重试。
- 隔离环境验证：凡是涉及写入的验证，只能在隔离测试环境中做，不能用正在运行的应用或真实数据。
