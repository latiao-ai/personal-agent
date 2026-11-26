import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogOut, Plus, Server, ShieldCheck, Trash2, Users } from "lucide-react";

import type {
  AdminAccount,
  AdminOffboardResult,
  AdminSession,
  AdminTenantOverview,
  CoreSkillHashChangeRequest,
  PortalAuditEntry,
} from "../../shared/portal";

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
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

export function AdminConsoleApp() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const [tenants, setTenants] = useState<AdminTenantOverview[]>([]);
  const [coreRequests, setCoreRequests] = useState<CoreSkillHashChangeRequest[]>([]);
  const [audit, setAudit] = useState<PortalAuditEntry[]>([]);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);

  // Provision form
  const [newTenantId, setNewTenantId] = useState("");
  const [newOpenIds, setNewOpenIds] = useState("");

  // Secondary confirmation state for offboarding
  const [offboardTarget, setOffboardTarget] = useState<string | null>(null);
  const [lastOffboard, setLastOffboard] = useState<AdminOffboardResult | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [tRes, reqRes, audRes, accRes] = await Promise.all([
        adminApi<{ tenants: AdminTenantOverview[] }>("/api/admin/tenants"),
        adminApi<{ requests: CoreSkillHashChangeRequest[] }>("/api/admin/core-skills/requests"),
        adminApi<{ audit: PortalAuditEntry[] }>("/api/admin/audit?limit=100"),
        adminApi<{ accounts: AdminAccount[] }>("/api/admin/accounts"),
      ]);
      setTenants(tRes.tenants);
      setCoreRequests(reqRes.requests);
      setAudit(audRes.audit);
      setAccounts(accRes.accounts);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "加载管理后台数据失败");
    }
  }, []);

  useEffect(() => {
    void adminApi<{ session: AdminSession }>("/api/admin/auth/me")
      .then((res) => setSession(res.session))
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (session) void refreshAll();
  }, [session, refreshAll]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    try {
      const res = await adminApi<{ session: AdminSession }>("/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password, cookie: true }),
      });
      setSession(res.session);
      setPassword("");
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "登录失败");
    }
  };

  const handleLogout = async () => {
    await adminApi("/api/admin/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    setSession(null);
  };

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setStatusNote(null);
    const openIds = newOpenIds
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!newTenantId.trim() || openIds.length === 0) return;
    try {
      await adminApi("/api/admin/tenants/provision", {
        method: "POST",
        body: JSON.stringify({ tenantId: newTenantId.trim(), openIds }),
      });
      setNewTenantId("");
      setNewOpenIds("");
      setStatusNote("新租户与 microVM 已开通并记入审计");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "开通租户失败");
    }
  };

  const handleConfirmOffboard = async (tenantId: string) => {
    setErrorBanner(null);
    setStatusNote(null);
    try {
      const result = await adminApi<AdminOffboardResult>(
        `/api/admin/tenants/${encodeURIComponent(tenantId)}/offboard`,
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
      setOffboardTarget(null);
      setLastOffboard(result);
      setStatusNote(`租户 ${tenantId} 已完成先导出（SHA-256 ${result.exportBundle.sha256.slice(0, 12)}）再彻底删除`);
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "销户失败");
    }
  };

  const handleApproveCoreSkill = async (requestId: string) => {
    setErrorBanner(null);
    setStatusNote(null);
    try {
      const res = await adminApi<{ newHash: string }>(
        `/api/admin/core-skills/requests/${encodeURIComponent(requestId)}/approve`,
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
      setStatusNote(`核心技能哈希已审批生效：${res.newHash.slice(0, 16)}…`);
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "审批核心技能变更失败");
    }
  };

  const handleRevokeAdmin = async (adminId: string) => {
    setErrorBanner(null);
    try {
      await adminApi(`/api/admin/accounts/${encodeURIComponent(adminId)}/revoke`, {
        method: "POST",
        body: "{}",
      });
      setStatusNote("管理员账号已吊销");
      await refreshAll();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "吊销失败");
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
        <span className="text-[13px] text-ink-secondary">正在核验管理员会话…</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
        <form onSubmit={(e) => void handleLogin(e)} className="w-full max-w-sm rounded-xl border border-hairline bg-card p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-ink" aria-hidden="true" />
            <div>
              <h1 className="text-[20px] font-semibold tracking-[-0.01em]">运营管理后台</h1>
              <p className="text-[12px] text-ink-tertiary">独立管理员账号登录（与客户飞书扫码隔离）</p>
            </div>
          </div>
          {errorBanner && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {errorBanner}
            </div>
          )}
          <label className="block space-y-1 text-[12px] text-ink-secondary">
            <span>管理员用户名</span>
            <input
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>
          <label className="block space-y-1 text-[12px] text-ink-secondary">
            <span>密码</span>
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-full bg-ink text-app py-2 text-[13px] font-medium"
          >
            登录管理后台
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app text-ink p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">控制面管理后台</h1>
          <p className="text-[12px] text-ink-tertiary">
            当前管理员：{session.displayName}（{session.username}）· 跨租户视图（不可查看客户真实凭证）
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-control px-3.5 py-1.5 text-[13px] font-medium hover:bg-ink/[0.06]"
        >
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
          退出
        </button>
      </header>

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

      {/* Tenants & VM status */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold">所有租户与云桌面状态</h2>
        </div>

        <form onSubmit={(e) => void handleProvision(e)} className="rounded-xl border border-hairline bg-card p-4 flex flex-wrap gap-3 items-end">
          <label className="space-y-1 text-[12px] text-ink-secondary flex-1 min-w-40">
            <span>新租户 ID</span>
            <input
              value={newTenantId}
              onChange={(e) => setNewTenantId(e.target.value)}
              placeholder="tenant_acme"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="space-y-1 text-[12px] text-ink-secondary flex-1 min-w-52">
            <span>绑定飞书 open_id（逗号分隔，首位为管理员）</span>
            <input
              value={newOpenIds}
              onChange={(e) => setNewOpenIds(e.target.value)}
              placeholder="ou_boss, ou_ops"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink font-mono"
            />
          </label>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-full bg-ink text-app px-4 py-1.5 text-[13px] font-medium"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            开通租户
          </button>
        </form>

        <div className="grid gap-3 md:grid-cols-2">
          {tenants.map((item) => (
            <div key={item.tenantId} className="rounded-xl border border-hairline bg-card p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] font-medium text-ink">{item.tenantId}</div>
                <span className="rounded-full bg-inset px-2.5 py-0.5 text-[11px] text-ink-secondary">
                  {item.vm ? item.vm.state : "无 VM"}
                </span>
              </div>
              {item.vm && (
                <div className="text-[12px] text-ink-secondary tabular-nums">
                  节点 {item.vm.hostNodeId} · {item.vm.quota.vcpu} vCPU / {item.vm.quota.memoryGb} GB / {item.vm.quota.diskGb} GB
                </div>
              )}
              <div className="text-[12px] text-ink-secondary tabular-nums">
                本月 Token {item.tokenSpendMonth} · 业务 {item.businessSpendMonth} {item.currency} · 待审批 {item.pendingApprovalCount}
              </div>
              <div className="text-[12px] text-ink-tertiary">
                凭据连接：{item.vaultConnections.length > 0 ? item.vaultConnections.map((v) => `${v.name}(正常)`).join(", ") : "无"}
              </div>
              <div className="pt-1 flex gap-2">
                {offboardTarget === item.tenantId ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleConfirmOffboard(item.tenantId)}
                      className="rounded-full bg-danger text-danger-ink px-3 py-1 text-[12px] font-medium"
                    >
                      二次确认：先导出再彻底删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setOffboardTarget(null)}
                      className="rounded-full border border-hairline px-3 py-1 text-[12px]"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOffboardTarget(item.tenantId)}
                    className="inline-flex items-center gap-1 rounded-full border border-danger/40 text-danger px-3 py-1 text-[12px] font-medium hover:bg-danger/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    销户（导出并删除）
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {lastOffboard && (
          <div className="rounded-xl border border-hairline bg-panel p-4 text-[12px] text-ink-secondary font-mono">
            最近销户回执：{lastOffboard.deletionReceipt.receiptId} · 租户 {lastOffboard.tenantId} · 导出 SHA-256{" "}
            {lastOffboard.exportBundle.sha256}
          </div>
        )}
      </section>

      {/* Core Skill Hash Approval Queue */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold">核心技能哈希变更审批</h2>
        </div>
        {coreRequests.map((req) => (
          <div key={req.id} className="rounded-xl border border-hairline bg-card p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="text-[14px] font-medium">
                {req.tenantId} / {req.skillName}（{req.status}）
              </div>
              <div className="text-[12px] text-ink-secondary">原因：{req.reason} · 申请人：{req.requestedBy}</div>
              <div className="text-[11px] font-mono text-ink-tertiary truncate">原哈希：{req.previousHash}</div>
            </div>
            {req.status === "pending" && (
              <button
                type="button"
                onClick={() => void handleApproveCoreSkill(req.id)}
                className="rounded-full bg-ink text-app px-3.5 py-1.5 text-[12px] font-medium"
              >
                二次确认并批准更新哈希
              </button>
            )}
          </div>
        ))}
        {coreRequests.length === 0 && (
          <div className="rounded-xl border border-hairline bg-card p-4 text-[13px] text-ink-tertiary">
            暂无核心技能哈希变更申请。
          </div>
        )}
      </section>

      {/* Admin Accounts */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold">管理员账号</h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {accounts.map((acc) => (
            <div key={acc.id} className="rounded-xl border border-hairline bg-card p-3.5 flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium">{acc.displayName}（{acc.username}）</div>
                <div className="text-[12px] text-ink-tertiary">{acc.revokedAt ? "已吊销" : "有效"}</div>
              </div>
              {!acc.revokedAt && acc.id !== session.adminId && (
                <button
                  type="button"
                  onClick={() => void handleRevokeAdmin(acc.id)}
                  className="rounded-full border border-danger/40 text-danger px-3 py-1 text-[12px]"
                >
                  吊销
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Global Audit */}
      <section className="space-y-2.5">
        <h2 className="text-[17px] font-semibold">全局审计日志</h2>
        {audit.slice(0, 20).map((entry) => (
          <div key={entry.id} className="rounded-xl border border-hairline bg-card p-3 flex flex-wrap justify-between gap-2 text-[12px]">
            <span className="text-ink">
              [{entry.tenantId}] {entry.action} · {entry.actorId} · {entry.reason}
            </span>
            <span className="text-ink-tertiary tabular-nums">{new Date(entry.at).toLocaleString()}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
