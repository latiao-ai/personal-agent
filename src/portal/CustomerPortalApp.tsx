import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Brain,
  CheckCircle2,
  Clock,
  Coins,
  Download,
  FileText,
  Lock,
  LogOut,
  MessageSquare,
  Settings,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import type { ApprovalButtonAction, DualBudgetPolicy } from "../../shared/approvals";
import type {
  CustomerSession,
  PortalApprovalView,
  PortalAuditEntry,
  PortalBotSummary,
  PortalMemorySkillView,
  PortalSpendOverview,
  TenantPortalSettings,
  TenantScheduleConfig,
} from "../../shared/portal";
import type { Ticket } from "../../shared/tickets";
import { ChannelPlatformsTab } from "./ChannelPlatformsTab";

type PortalTab = "bots" | "channels" | "approvals" | "spend" | "schedule" | "memory" | "settings";

const NAV_ITEMS: Array<{ id: PortalTab; label: string; icon: typeof Bot }> = [
  { id: "bots", label: "Bot 列表", icon: Bot },
  { id: "channels", label: "消息平台", icon: MessageSquare },
  { id: "approvals", label: "Ticket 与审批", icon: FileText },
  { id: "spend", label: "消耗", icon: Coins },
  { id: "schedule", label: "定时任务", icon: Clock },
  { id: "memory", label: "记忆与技能", icon: Brain },
  { id: "settings", label: "设置", icon: Settings },
];

async function portalApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.message || data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export function CustomerPortalApp() {
  const [session, setSession] = useState<CustomerSession | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [activeTab, setActiveTab] = useState<PortalTab>("bots");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  // 6 pages data
  const [bots, setBots] = useState<PortalBotSummary[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [approvals, setApprovals] = useState<PortalApprovalView[]>([]);
  const [spend, setSpend] = useState<PortalSpendOverview | null>(null);
  const [schedule, setSchedule] = useState<TenantScheduleConfig | null>(null);
  const [memorySkill, setMemorySkill] = useState<PortalMemorySkillView | null>(null);
  const [settings, setSettings] = useState<TenantPortalSettings | null>(null);
  const [audit, setAudit] = useState<PortalAuditEntry[]>([]);

  // Form drafts
  const [budgetDraft, setBudgetDraft] = useState<DualBudgetPolicy | null>(null);
  const [approversText, setApproversText] = useState("");
  const [suggestionDraft, setSuggestionDraft] = useState<{ memoryId: string; suggestedContent: string; reason: string } | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [botsRes, ticketsRes, approvalsRes, spendRes, schedRes, memRes, setRes, audRes] = await Promise.all([
        portalApi<{ bots: PortalBotSummary[] }>("/api/portal/bots"),
        portalApi<{ tickets: Ticket[] }>("/api/portal/tickets"),
        portalApi<{ approvals: PortalApprovalView[] }>("/api/portal/approvals"),
        portalApi<{ spend: PortalSpendOverview }>("/api/portal/spend"),
        portalApi<{ schedule: TenantScheduleConfig }>("/api/portal/schedule"),
        portalApi<PortalMemorySkillView>("/api/portal/memory-skill"),
        portalApi<{ settings: TenantPortalSettings }>("/api/portal/settings"),
        portalApi<{ audit: PortalAuditEntry[] }>("/api/portal/audit?limit=50"),
      ]);
      setBots(botsRes.bots);
      setTickets(ticketsRes.tickets);
      setApprovals(approvalsRes.approvals);
      setSpend(spendRes.spend);
      setBudgetDraft(spendRes.spend.policy);
      setSchedule(schedRes.schedule);
      setMemorySkill(memRes);
      setSettings(setRes.settings);
      setApproversText(setRes.settings.approverOpenIds.join(", "));
      setAudit(audRes.audit);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "加载租户数据失败");
    }
  }, []);

  useEffect(() => {
    void portalApi<{ session: CustomerSession }>("/api/portal/auth/me")
      .then((res) => {
        setSession(res.session);
      })
      .catch(() => {
        setSession(null);
        window.location.replace("/login");
      })
      .finally(() => setCheckingAuth(false));
  }, []);

  // Load tenant data and subscribe to dual-channel SSE approval updates when signed in.
  useEffect(() => {
    if (!session) return;
    void refreshAll();
    const es = new EventSource("/api/portal/approvals/stream", { withCredentials: true });
    es.addEventListener("approval", () => {
      void portalApi<{ approvals: PortalApprovalView[] }>("/api/portal/approvals").then((r) => setApprovals(r.approvals));
    });
    return () => es.close();
  }, [session, refreshAll]);

  const handleLogout = async () => {
    await portalApi("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    setSession(null);
    window.location.replace("/login");
  };

  const handleToggleBot = async (bot: PortalBotSummary) => {
    setErrorBanner(null);
    setStatusNote(null);
    try {
      await portalApi(`/api/portal/bots/${encodeURIComponent(bot.botId)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !bot.enabled }),
      });
      setStatusNote(`Bot ${bot.botId} 已${bot.enabled ? "关闭（不再接新任务，运行中工单不受影响）" : "开启"}，已记审计`);
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "操作失败");
    }
  };

  const handleDecideApproval = async (cardId: string, action: ApprovalButtonAction) => {
    setErrorBanner(null);
    setStatusNote(null);
    try {
      const res = await portalApi<{ card: PortalApprovalView }>(`/api/portal/approvals/${encodeURIComponent(cardId)}/decide`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      setStatusNote(res.card.statusBanner ?? "审批已处理");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "审批操作被拒绝");
    }
  };

  const handleSaveBudget = async () => {
    if (!budgetDraft) return;
    setErrorBanner(null);
    setStatusNote(null);
    try {
      await portalApi("/api/portal/budget", { method: "PUT", body: JSON.stringify(budgetDraft) });
      setStatusNote("双口径预算上限已生效并记入审计");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "更新预算失败");
    }
  };

  const handleSaveSchedule = async () => {
    if (!schedule) return;
    setErrorBanner(null);
    setStatusNote(null);
    try {
      const res = await portalApi<{ schedule: TenantScheduleConfig }>("/api/portal/schedule", {
        method: "PUT",
        body: JSON.stringify({
          patrolFrequencyPerDay: schedule.patrolFrequencyPerDay,
          dailyDigestTime: schedule.dailyDigestTime,
          patrolEnabled: schedule.patrolEnabled,
          digestEnabled: schedule.digestEnabled,
        }),
      });
      setSchedule(res.schedule);
      setStatusNote(res.schedule.effectiveNote);
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "保存定时任务失败");
    }
  };

  const handleSaveApprovers = async () => {
    setErrorBanner(null);
    setStatusNote(null);
    const list = approversText
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await portalApi("/api/portal/settings/approvers", {
        method: "PUT",
        body: JSON.stringify({ approverOpenIds: list }),
      });
      setStatusNote("审批人名单已更新并记入审计");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "更新审批人失败");
    }
  };

  const handleSubmitMemorySuggestion = async () => {
    if (!suggestionDraft) return;
    setErrorBanner(null);
    setStatusNote(null);
    try {
      await portalApi("/api/portal/memory/suggestions", {
        method: "POST",
        body: JSON.stringify(suggestionDraft),
      });
      setSuggestionDraft(null);
      setStatusNote("记忆修改建议已提交审核，已记入审计");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "提交建议失败");
    }
  };

  const handleExportSelf = async () => {
    try {
      const { export: data } = await portalApi<{ export: unknown }>("/api/portal/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tenant-${session?.tenantId ?? "self"}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusNote("已导出本租户数据（仅包含当前租户）");
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "导出失败");
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
        <span className="text-[13px] text-ink-secondary">正在核验控制面会话…</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
        <span className="text-[13px] text-ink-secondary">正在跳转到统一登录页…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app text-ink flex flex-col md:flex-row">
      <aside className="w-full md:w-64 shrink-0 border-b md:border-b-0 md:border-e border-edge bg-panel p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[17px] font-semibold tracking-[-0.01em] text-ink truncate">客户门户</div>
            <div className="text-[12px] text-ink-tertiary truncate">
              租户 {session.tenantId} · {session.role === "admin" ? "管理员" : "普通成员"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            aria-label="退出登录"
            title="退出登录"
            className="rounded-full p-2 text-ink-secondary hover:bg-ink/[0.06]"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <nav className="flex md:flex-col gap-1 overflow-x-auto pb-1 md:pb-0">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active ? "bg-raised text-ink" : "text-ink-secondary hover:bg-ink/[0.06]"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-6 max-w-5xl w-full mx-auto space-y-5">
        {errorBanner && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-2.5 text-[13px] text-danger">
            {errorBanner}
          </div>
        )}
        {statusNote && (
          <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-2.5 text-[13px] text-ink">
            {statusNote}
          </div>
        )}

        {activeTab === "bots" && (
          <section className="space-y-4">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">我的 Bot</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {bots.map((bot) => (
                <div key={bot.botId} className="rounded-xl border border-hairline bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-ink truncate">{bot.botId}</div>
                      <div className="text-[12px] text-ink-tertiary">角色：{bot.role}</div>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                        bot.enabled ? "bg-success/15 text-success" : "bg-inset text-ink-tertiary"
                      }`}
                    >
                      {bot.enabled ? "运行中" : "已关闭"}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-secondary tabular-nums">
                    运行中 Ticket：{bot.activeTicketCount}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleToggleBot(bot)}
                    className="w-full rounded-full border border-hairline bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.06]"
                  >
                    {bot.enabled ? "关闭 Bot" : "开启 Bot"}
                  </button>
                </div>
              ))}
              {bots.length === 0 && (
                <div className="rounded-xl border border-hairline bg-card p-6 text-[13px] text-ink-tertiary">
                  当前租户暂无已注册的 Bot。
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "approvals" && (
          <section className="space-y-5">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">Ticket 与双通道审批</h2>
            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold text-ink">审批记录</h3>
              {approvals.map((card) => (
                <div key={card.id} className="rounded-xl border border-hairline bg-card p-4 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[14px] font-medium text-ink">{card.actionSummary}</div>
                    <span className="rounded-full border border-hairline bg-inset px-2.5 py-0.5 text-[11px] text-ink-secondary">
                      {card.status === "pending" ? "待处理" : card.statusBanner ?? card.status}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-secondary tabular-nums">
                    工单 {card.ticketId} · 工具 {card.toolName} · 业务 {card.businessCost} {card.currency} · Token {card.tokenCost}
                  </div>
                  <div className="text-[12px] text-ink-tertiary">
                    指定审批人：{card.approverOpenId}
                    {card.decisionChannel ? ` · 通道：${card.decisionChannel === "web" ? "网页" : "飞书"}` : ""}
                  </div>
                  {card.status === "pending" && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        disabled={!card.canAct}
                        onClick={() => void handleDecideApproval(card.id, "allow_once")}
                        className="inline-flex items-center gap-1.5 rounded-full bg-ink text-app px-3.5 py-1.5 text-[13px] font-medium disabled:opacity-40"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        允许一次
                      </button>
                      <button
                        type="button"
                        disabled={!card.canAct}
                        onClick={() => void handleDecideApproval(card.id, "deny")}
                        className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 text-danger px-3.5 py-1.5 text-[13px] font-medium hover:bg-danger/10 disabled:opacity-40"
                      >
                        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                        拒绝
                      </button>
                      {!card.canAct && (
                        <span className="text-[12px] text-ink-tertiary self-center">仅指定审批人可操作</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {approvals.length === 0 && (
                <div className="rounded-xl border border-hairline bg-card p-5 text-[13px] text-ink-tertiary">暂无审批记录。</div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold text-ink">Ticket 列表</h3>
              <div className="space-y-2">
                {tickets.map((tk) => (
                  <div key={tk.id} className="rounded-xl border border-hairline bg-card p-3.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{tk.mandate.goal}</div>
                      <div className="text-[12px] text-ink-tertiary truncate">
                        {tk.id} · 发起人 {tk.initiator} · 来源 {tk.source}
                      </div>
                    </div>
                    <span className="rounded-full bg-inset px-2.5 py-0.5 text-[11px] text-ink-secondary shrink-0">
                      {tk.status}
                    </span>
                  </div>
                ))}
                {tickets.length === 0 && (
                  <div className="rounded-xl border border-hairline bg-card p-5 text-[13px] text-ink-tertiary">暂无 Ticket。</div>
                )}
              </div>
            </div>
          </section>
        )}

        {activeTab === "spend" && spend && budgetDraft && (
          <section className="space-y-5">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">双口径消耗账本</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-hairline bg-card p-4 space-y-2">
                <div className="text-[13px] font-medium text-ink-secondary">模型 Token 消耗</div>
                <div className="text-[20px] font-semibold tabular-nums text-ink">
                  本月 {spend.tokenSpend.month} / 上限 {spend.policy.tokenMonthly}
                </div>
                <div className="text-[12px] text-ink-tertiary tabular-nums">
                  今日 {spend.tokenSpend.day} / 日上限 {spend.policy.tokenDaily} · 巡检累计 {spend.tokenSpend.patrolTokens} tokens
                </div>
              </div>
              <div className="rounded-xl border border-hairline bg-card p-4 space-y-2">
                <div className="text-[13px] font-medium text-ink-secondary">业务消耗（{spend.currency}）</div>
                <div className="text-[20px] font-semibold tabular-nums text-ink">
                  本月 {spend.businessSpend.month} / 上限 {spend.policy.businessMonthly}
                </div>
                <div className="text-[12px] text-ink-tertiary tabular-nums">
                  今日 {spend.businessSpend.day} / 日上限 {spend.policy.businessDaily} · 单笔上限 {spend.policy.businessPerTx}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-hairline bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">预算上限设置</h3>
                {session.role !== "admin" && (
                  <span className="text-[12px] text-ink-tertiary">仅租户管理员可修改</span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-[12px] text-ink-secondary">
                  <span>Token 日上限</span>
                  <input
                    type="number"
                    disabled={session.role !== "admin"}
                    value={budgetDraft.tokenDaily}
                    onChange={(e) => setBudgetDraft({ ...budgetDraft, tokenDaily: Number(e.target.value) })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-[12px] text-ink-secondary">
                  <span>业务日上限</span>
                  <input
                    type="number"
                    disabled={session.role !== "admin"}
                    value={budgetDraft.businessDaily}
                    onChange={(e) => setBudgetDraft({ ...budgetDraft, businessDaily: Number(e.target.value) })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-[12px] text-ink-secondary">
                  <span>业务月上限</span>
                  <input
                    type="number"
                    disabled={session.role !== "admin"}
                    value={budgetDraft.businessMonthly}
                    onChange={(e) => setBudgetDraft({ ...budgetDraft, businessMonthly: Number(e.target.value) })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
                  />
                </label>
              </div>
              {session.role === "admin" && (
                <button
                  type="button"
                  onClick={() => void handleSaveBudget()}
                  className="rounded-full bg-ink text-app px-4 py-1.5 text-[13px] font-medium"
                >
                  保存预算上限
                </button>
              )}
            </div>
          </section>
        )}

        {activeTab === "schedule" && schedule && (
          <section className="space-y-4">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">定时任务与巡检</h2>
            <div className="rounded-xl border border-hairline bg-card p-5 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-[12px] text-ink-secondary">
                  <span>巡检频率（次 / 天）</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={schedule.patrolFrequencyPerDay}
                    onChange={(e) => setSchedule({ ...schedule, patrolFrequencyPerDay: Number(e.target.value) })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
                  />
                </label>
                <label className="space-y-1 text-[12px] text-ink-secondary">
                  <span>日报发送时间（HH:MM）</span>
                  <input
                    type="time"
                    value={schedule.dailyDigestTime}
                    onChange={(e) => setSchedule({ ...schedule, dailyDigestTime: e.target.value })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-6 text-[13px]">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={schedule.patrolEnabled}
                    onChange={(e) => setSchedule({ ...schedule, patrolEnabled: e.target.checked })}
                  />
                  <span>开启定时巡检</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={schedule.digestEnabled}
                    onChange={(e) => setSchedule({ ...schedule, digestEnabled: e.target.checked })}
                  />
                  <span>开启每日巡检日报</span>
                </label>
              </div>
              <div className="text-[12px] text-ink-tertiary">{schedule.effectiveNote}</div>
              <button
                type="button"
                onClick={() => void handleSaveSchedule()}
                className="rounded-full bg-ink text-app px-4 py-1.5 text-[13px] font-medium"
              >
                保存配置
              </button>
            </div>
          </section>
        )}

        {activeTab === "memory" && memorySkill && (
          <section className="space-y-5">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">记忆与技能（只读）</h2>

            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold">技能列表</h3>
              {memorySkill.skills.map((skill) => (
                <div key={skill.id} className="rounded-xl border border-hairline bg-card p-4 flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-ink">{skill.name}</span>
                      {skill.coreLocked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
                          <Lock className="w-3 h-3" aria-hidden="true" />
                          核心技能锁定
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-ink-secondary">{skill.description}</p>
                    <p className="text-[12px] text-ink-tertiary font-mono truncate">SHA-256: {skill.contentHash}</p>
                  </div>
                </div>
              ))}
              {memorySkill.skills.length === 0 && (
                <div className="rounded-xl border border-hairline bg-card p-5 text-[13px] text-ink-tertiary">暂无技能。</div>
              )}
            </div>

            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold">长期记忆</h3>
              {memorySkill.memories.map((mem) => (
                <div key={mem.id} className="rounded-xl border border-hairline bg-card p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink-secondary">{mem.category}</span>
                    <button
                      type="button"
                      onClick={() => setSuggestionDraft({ memoryId: mem.id, suggestedContent: mem.content, reason: "" })}
                      className="text-[12px] text-accent-text hover:underline"
                    >
                      提修改建议
                    </button>
                  </div>
                  <p className="text-[13px] text-ink">{mem.content}</p>
                </div>
              ))}
              {suggestionDraft && (
                <div className="rounded-xl border border-hairline bg-panel p-4 space-y-2.5">
                  <div className="text-[13px] font-medium">提交记忆修改建议（不直接写入）</div>
                  <textarea
                    value={suggestionDraft.suggestedContent}
                    onChange={(e) => setSuggestionDraft({ ...suggestionDraft, suggestedContent: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border border-hairline bg-inset p-2.5 text-[13px] text-ink"
                  />
                  <input
                    placeholder="修改原因"
                    value={suggestionDraft.reason}
                    onChange={(e) => setSuggestionDraft({ ...suggestionDraft, reason: e.target.value })}
                    className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSubmitMemorySuggestion()}
                      className="rounded-full bg-ink text-app px-3.5 py-1.5 text-[13px] font-medium"
                    >
                      提交建议
                    </button>
                    <button
                      type="button"
                      onClick={() => setSuggestionDraft(null)}
                      className="rounded-full border border-hairline px-3.5 py-1.5 text-[13px]"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "settings" && settings && (
          <section className="space-y-5">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em]">设置与本租户审计</h2>
            <div className="rounded-xl border border-hairline bg-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">审批人名单（飞书 open_id）</h3>
                {session.role !== "admin" && (
                  <span className="text-[12px] text-ink-tertiary">仅租户管理员可修改</span>
                )}
              </div>
              <input
                disabled={session.role !== "admin"}
                value={approversText}
                onChange={(e) => setApproversText(e.target.value)}
                placeholder="ou_xxx, ou_yyy"
                className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink font-mono"
              />
              <div className="flex flex-wrap gap-2">
                {session.role === "admin" && (
                  <button
                    type="button"
                    onClick={() => void handleSaveApprovers()}
                    className="rounded-full bg-ink text-app px-4 py-1.5 text-[13px] font-medium"
                  >
                    保存审批人名单
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleExportSelf()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-control px-4 py-1.5 text-[13px] font-medium hover:bg-ink/[0.06]"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  导出本租户数据
                </button>
              </div>
            </div>

            <div className="space-y-2.5">
              <h3 className="text-[15px] font-semibold">本租户审计记录</h3>
              {audit.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-hairline bg-card p-3.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">{entry.action}</span>
                    <span className="text-[12px] text-ink-tertiary tabular-nums">
                      {new Date(entry.at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-secondary">
                    操作人 {entry.actorId}（{entry.channel}）· {entry.reason}
                  </div>
                </div>
              ))}
              {audit.length === 0 && (
                <div className="rounded-xl border border-hairline bg-card p-5 text-[13px] text-ink-tertiary flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4" aria-hidden="true" />
                  暂无审计记录。
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "channels" && (
          <ChannelPlatformsTab
            bots={bots}
            onNotify={(msg) => {
              setErrorBanner(null);
              setStatusNote(msg);
            }}
            onError={(msg) => {
              setStatusNote(null);
              setErrorBanner(msg);
            }}
          />
        )}
      </main>
    </div>
  );
}
