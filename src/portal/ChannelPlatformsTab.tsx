import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Link2, MessageSquare, Radio, Trash2, UserCheck } from "lucide-react";

import type { GatewayHealthSnapshot, WeixinIlinkQrSession } from "../../shared/gateway";
import type {
  ChannelBinding,
  ChannelChatType,
  ChannelPlatform,
  PortalBotSummary,
  TenantChannelAllowlist,
  UserIdentity,
  WeixinIdentity,
} from "../../shared/portal";

interface ChannelPlatformsTabProps {
  bots: PortalBotSummary[];
  onNotify: (msg: string) => void;
  onError: (msg: string) => void;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message || data.error || `请求失败 (${res.status})`);
  return data;
}

/**
 * Customer Portal "消息平台" tab: binds any tenant Bot to Feishu or Personal WeChat (iLink).
 * Enterprise WeChat (WeCom) is intentionally omitted in this release.
 */
export function ChannelPlatformsTab({ bots, onNotify, onError }: ChannelPlatformsTabProps) {
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayHealthSnapshot | null>(null);
  const [weixinNote, setWeixinNote] = useState("个人微信以私聊为主（iLink 机器人一般不能进普通微信群，不承诺群聊回复）");
  const [feishuIds, setFeishuIds] = useState<UserIdentity[]>([]);
  const [weixinIds, setWeixinIds] = useState<WeixinIdentity[]>([]);
  const [feishuAllowlist, setFeishuAllowlist] = useState("");
  const [weixinAllowlist, setWeixinAllowlist] = useState("");

  // New binding form
  const [botId, setBotId] = useState(bots[0]?.botId ?? "");
  const [platform, setPlatform] = useState<ChannelPlatform>("feishu");
  const [platformAppId, setPlatformAppId] = useState("");
  const [platformSecret, setPlatformSecret] = useState("");
  const [chatId, setChatId] = useState("");
  const [chatType, setChatType] = useState<ChannelChatType>("group");
  const [label, setLabel] = useState("");

  // Weixin iLink QR
  const [wxQr, setWxQr] = useState<WeixinIlinkQrSession | null>(null);

  // Identity linking inputs
  const [feishuOpenIdInput, setFeishuOpenIdInput] = useState("");
  const [weixinOpenIdInput, setWeixinOpenIdInput] = useState("");
  const [weixinIlinkInput, setWeixinIlinkInput] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [bRes, idRes, fAllow, wAllow] = await Promise.all([
        api<{ bindings: ChannelBinding[]; gatewayStatus: GatewayHealthSnapshot | null; weixinNote: string }>(
          "/api/portal/channels/bindings",
        ),
        api<{ feishu: UserIdentity[]; weixin: WeixinIdentity[] }>("/api/portal/identities"),
        api<{ allowlist: TenantChannelAllowlist }>("/api/portal/channels/allowlist?platform=feishu"),
        api<{ allowlist: TenantChannelAllowlist }>("/api/portal/channels/allowlist?platform=weixin"),
      ]);
      setBindings(bRes.bindings);
      setGatewayStatus(bRes.gatewayStatus);
      if (bRes.weixinNote) setWeixinNote(bRes.weixinNote);
      setFeishuIds(idRes.feishu);
      setWeixinIds(idRes.weixin);
      setFeishuAllowlist(fAllow.allowlist.allowedSenderIds.join(", "));
      setWeixinAllowlist(wAllow.allowlist.allowedSenderIds.join(", "));
    } catch (err) {
      onError(err instanceof Error ? err.message : "加载消息平台配置失败");
    }
  }, [onError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!botId && bots[0]?.botId) setBotId(bots[0].botId);
  }, [botId, bots]);

  const handleBind = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/portal/channels/bindings", {
        method: "POST",
        body: JSON.stringify({
          botId: botId.trim(),
          platform,
          platformAppId: platformAppId.trim(),
          platformSecret: platformSecret.trim() || undefined,
          chatId: chatId.trim(),
          chatType: platform === "weixin" ? "p2p" : chatType,
          label: label.trim() || undefined,
        }),
      });
      setPlatformSecret("");
      setChatId("");
      setLabel("");
      onNotify("消息平台绑定已保存，常驻网关已热加载生效");
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "绑定失败");
    }
  };

  const handleUnbind = async (id: string) => {
    try {
      await api(`/api/portal/channels/bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
      onNotify("已解绑该会话，网关已热加载");
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "解绑失败");
    }
  };

  const handleStartWeixinQr = async () => {
    try {
      const res = await api<{ qrSession: WeixinIlinkQrSession }>("/api/portal/channels/weixin/qr/start", {
        method: "POST",
        body: "{}",
      });
      setWxQr(res.qrSession);
    } catch (err) {
      onError(err instanceof Error ? err.message : "获取微信 iLink 二维码失败");
    }
  };

  const handleBindFeishuIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/portal/identities/feishu", {
        method: "POST",
        body: JSON.stringify({ feishuOpenId: feishuOpenIdInput.trim() }),
      });
      setFeishuOpenIdInput("");
      onNotify("飞书账号身份已绑定");
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "绑定飞书账号失败");
    }
  };

  const handleBindWeixinIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("/api/portal/identities/weixin", {
        method: "POST",
        body: JSON.stringify({
          weixinOpenId: weixinOpenIdInput.trim(),
          ilinkAccountId: weixinIlinkInput.trim(),
        }),
      });
      setWeixinOpenIdInput("");
      setWeixinIlinkInput("");
      onNotify("个人微信 iLink 身份已绑定");
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "绑定微信身份失败");
    }
  };

  const handleSaveAllowlist = async (targetPlatform: ChannelPlatform) => {
    const raw = targetPlatform === "feishu" ? feishuAllowlist : weixinAllowlist;
    const ids = raw
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api("/api/portal/channels/allowlist", {
        method: "PUT",
        body: JSON.stringify({ platform: targetPlatform, allowedSenderIds: ids }),
      });
      onNotify(`${targetPlatform === "feishu" ? "飞书" : "个人微信"}白名单已保存（仅对本租户生效）`);
      await loadAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存白名单失败");
    }
  };

  return (
    <div className="space-y-6">
      {/* Gateway Status */}
      <section className="rounded-xl border border-hairline bg-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Radio className="w-4 h-4 text-ink" aria-hidden="true" />
          <div>
            <div className="text-[14px] font-semibold">常驻消息网关状态</div>
            <div className="text-[12px] text-ink-secondary">
              {gatewayStatus?.running
                ? `在线（PID ${gatewayStatus.pid}）· 已转发 ${gatewayStatus.routedCount} · 已拦截 ${gatewayStatus.rejectedCount}`
                : "离线"}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px]">
          {(gatewayStatus?.adapters ?? [])
            .filter((a) => a.platform !== "wecom")
            .map((a) => (
              <span
                key={a.platform}
                className="rounded-full border border-hairline bg-panel px-3 py-1 text-ink-secondary"
              >
                {a.platform === "feishu" ? "飞书" : "个人微信"}：{a.state === "online" ? "在线" : a.state === "reconnecting" ? "重连中" : "离线"}
              </span>
            ))}
        </div>
      </section>

      {/* Bind Bot to Platform */}
      <section className="rounded-xl border border-hairline bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h2 className="text-[16px] font-semibold">为任意 Bot 绑定消息平台</h2>
        </div>

        <form onSubmit={(e) => void handleBind(e)} className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>选择 Bot（可输入自定义 Bot ID）</span>
            <input
              list="portal-bot-list"
              required
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
              placeholder="例如 bot_procurement 或 dr-eggbot"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
            <datalist id="portal-bot-list">
              {bots.map((b) => (
                <option key={b.botId} value={b.botId} />
              ))}
            </datalist>
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>消息平台</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as ChannelPlatform)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            >
              <option value="feishu">飞书（WebSocket 长连接）</option>
              <option value="weixin">个人微信（iLink Bot，私聊为主）</option>
            </select>
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>{platform === "feishu" ? "飞书 App ID" : "iLink 账号 ID（xxx@im.bot）"}</span>
            <input
              required
              value={platformAppId}
              onChange={(e) => setPlatformAppId(e.target.value)}
              placeholder={platform === "feishu" ? "cli_xxxx" : "bot_xxxx@im.bot"}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>{platform === "feishu" ? "飞书 App Secret（存入 Vault）" : "iLink Token（存入 Vault）"}</span>
            <input
              type="password"
              value={platformSecret}
              onChange={(e) => setPlatformSecret(e.target.value)}
              placeholder="仅写入控制面 Vault，不回显"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>{platform === "feishu" ? "飞书群/私聊 Chat ID" : "微信私聊 Chat ID"}</span>
            <input
              required
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder={platform === "feishu" ? "oc_xxxx" : "wx_dm_xxxx"}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>

          {platform === "feishu" && (
            <label className="space-y-1 text-[12px] text-ink-secondary">
              <span>会话类型</span>
              <select
                value={chatType}
                onChange={(e) => setChatType(e.target.value as ChannelChatType)}
                className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
              >
                <option value="group">内部群聊（@ 回复）</option>
                <option value="p2p">私聊</option>
              </select>
            </label>
          )}

          <label className="space-y-1 text-[12px] text-ink-secondary md:col-span-2">
            <span>备注名称（可选）</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如 采购内部测试群"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>

          {platform === "weixin" && (
            <div className="md:col-span-2 rounded-lg border border-hairline bg-panel p-3 space-y-2 text-[12px] text-ink-secondary">
              <p>{weixinNote}</p>
              <button
                type="button"
                onClick={() => void handleStartWeixinQr()}
                className="rounded-full border border-hairline bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-ink/[0.06]"
              >
                生成个人微信 iLink 扫码登录二维码
              </button>
              {wxQr && (
                <div className="flex items-center gap-4 pt-2">
                  <div className="rounded-lg bg-card p-2 border border-hairline">
                    <QRCodeSVG value={wxQr.qrUrl} size={112} />
                  </div>
                  <div className="space-y-1">
                    <div>会话：{wxQr.sessionId}</div>
                    <div>状态：{wxQr.status}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded-full bg-accent text-accent-ink px-4 py-2 text-[13px] font-medium hover:opacity-90"
            >
              保存绑定并热加载网关
            </button>
          </div>
        </form>
      </section>

      {/* Active Bindings List */}
      <section className="rounded-xl border border-hairline bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h3 className="text-[15px] font-semibold">已绑定的频道（{bindings.length}）</h3>
        </div>
        {bindings.length === 0 ? (
          <p className="text-[13px] text-ink-tertiary">暂无频道绑定。</p>
        ) : (
          <div className="space-y-2">
            {bindings.map((b) => (
              <div
                key={b.id}
                className="rounded-lg border border-hairline bg-panel p-3 flex flex-wrap items-center justify-between gap-2 text-[13px]"
              >
                <div>
                  <div className="font-medium">
                    {b.botId} · {b.platform === "feishu" ? "飞书" : "个人微信"}（{b.chatType}）· {b.status}
                  </div>
                  <div className="text-[12px] text-ink-secondary">
                    Chat: {b.chatId} · App: {b.platformAppId} · {b.label}
                  </div>
                </div>
                {b.status === "active" && (
                  <button
                    type="button"
                    onClick={() => void handleUnbind(b.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-danger/40 text-danger px-3 py-1 text-[12px]"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    解绑
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Identity Linking & Per-Tenant Allowlists */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
            <h3 className="text-[15px] font-semibold">飞书 / 微信身份绑定</h3>
          </div>
          <form onSubmit={(e) => void handleBindFeishuIdentity(e)} className="flex gap-2">
            <input
              required
              value={feishuOpenIdInput}
              onChange={(e) => setFeishuOpenIdInput(e.target.value)}
              placeholder="飞书 open_id（ou_xxxx）"
              className="flex-1 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
            <button type="submit" className="rounded-full bg-control border border-hairline px-3 py-1.5 text-[12px]">
              绑定飞书
            </button>
          </form>
          <div className="text-[12px] text-ink-tertiary">
            已绑定飞书：{feishuIds.map((i) => i.feishuOpenId).join(", ") || "无"}
          </div>

          <form onSubmit={(e) => void handleBindWeixinIdentity(e)} className="space-y-2 pt-2 border-t border-hairline">
            <input
              required
              value={weixinOpenIdInput}
              onChange={(e) => setWeixinOpenIdInput(e.target.value)}
              placeholder="微信发送者 ID"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
            <div className="flex gap-2">
              <input
                required
                value={weixinIlinkInput}
                onChange={(e) => setWeixinIlinkInput(e.target.value)}
                placeholder="iLink 账号 ID（xxx@im.bot）"
                className="flex-1 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
              />
              <button type="submit" className="rounded-full bg-control border border-hairline px-3 py-1.5 text-[12px]">
                绑定微信
              </button>
            </div>
          </form>
          <div className="text-[12px] text-ink-tertiary">
            已绑定微信：{weixinIds.map((i) => `${i.weixinOpenId} (${i.ilinkAccountId})`).join(", ") || "无"}
          </div>
        </div>

        <div className="rounded-xl border border-hairline bg-card p-4 space-y-3">
          <h3 className="text-[15px] font-semibold">本租户白名单（按租户隔离）</h3>
          <div className="space-y-1.5">
            <label className="text-[12px] text-ink-secondary block">飞书允许的 open_id（逗号分隔）</label>
            <div className="flex gap-2">
              <input
                value={feishuAllowlist}
                onChange={(e) => setFeishuAllowlist(e.target.value)}
                placeholder="ou_1, ou_2"
                className="flex-1 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
              />
              <button
                type="button"
                onClick={() => void handleSaveAllowlist("feishu")}
                className="rounded-full bg-control border border-hairline px-3 py-1.5 text-[12px]"
              >
                保存
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] text-ink-secondary block">个人微信允许的发送者 ID（逗号分隔）</label>
            <div className="flex gap-2">
              <input
                value={weixinAllowlist}
                onChange={(e) => setWeixinAllowlist(e.target.value)}
                placeholder="wx_user_1"
                className="flex-1 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
              />
              <button
                type="button"
                onClick={() => void handleSaveAllowlist("weixin")}
                className="rounded-full bg-control border border-hairline px-3 py-1.5 text-[12px]"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
