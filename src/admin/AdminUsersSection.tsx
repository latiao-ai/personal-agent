import { useState } from "react";
import { UserPlus, Users } from "lucide-react";

import type { PortalRole, PortalUserAccount, UnifiedAccountRole } from "../../shared/portal";

interface AdminUsersSectionProps {
  users: PortalUserAccount[];
  onRefresh: () => Promise<void>;
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
 * Admin-only unified account creation, password reset, and deactivation.
 * Supports automatic jump into newly created test accounts (e.g. tanghaonan) via HttpOnly cookie
 * without ever placing plaintext passwords in the URL.
 */
export function AdminUsersSection({ users, onRefresh, onNotify, onError }: AdminUsersSectionProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UnifiedAccountRole>("customer");
  const [tenantId, setTenantId] = useState("");
  const [tenantRole, setTenantRole] = useState<PortalRole>("admin");
  const [legacyLocalAccount, setLegacyLocalAccount] = useState(false);
  const [autoSwitchSession, setAutoSwitchSession] = useState(true);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{
        user: PortalUserAccount;
        autoRedirectTo: "/portal" | null;
        switchedToCustomerSession: boolean;
      }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim(),
          password,
          displayName: displayName.trim() || undefined,
          role,
          tenantId: role === "customer" ? tenantId.trim() || undefined : undefined,
          tenantRole,
          legacyLocalAccount,
          autoSwitchSession: role === "customer" && autoSwitchSession,
        }),
      });
      setUsername("");
      setPassword("");
      setDisplayName("");
      setTenantId("");
      if (res.autoRedirectTo && res.switchedToCustomerSession) {
        window.location.assign(res.autoRedirectTo);
        return;
      }
      onNotify(`账号 ${res.user.username} 已创建（密码已哈希存库）`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "创建账号失败");
    }
  };

  const handleResetPassword = async (userId: string) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password: resetPassword }),
      });
      setResetTarget(null);
      setResetPassword("");
      onNotify("密码已更新");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "修改密码失败");
    }
  };

  const handleDisable = async (userId: string) => {
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/disable`, {
        method: "POST",
        body: "{}",
      });
      onNotify("账号已停用，其会话已立即失效");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "停用失败");
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <UserPlus className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
        <h2 className="text-[17px] font-semibold">统一登录账号管理（仅后台创建，不开放自助注册）</h2>
      </div>

      <form onSubmit={(e) => void handleCreate(e)} className="rounded-xl border border-hairline bg-card p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>用户名</span>
            <input
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例如 tanghaonan"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>初始密码（至少 6 位）</span>
            <input
              required
              minLength={6}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="仅存 scrypt 哈希"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>显示名（可选）</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如 唐浩南"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>角色</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UnifiedAccountRole)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            >
              <option value="customer">客户账号（登录进 /portal）</option>
              <option value="ops_admin">管理员账号（登录进 /admin）</option>
            </select>
          </label>

          {role === "customer" && (
            <>
              <label className="space-y-1 text-[12px] text-ink-secondary">
                <span>所属租户 ID（留空自动生成）</span>
                <input
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="tenant_tanghaonan"
                  className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
                />
              </label>

              <label className="space-y-1 text-[12px] text-ink-secondary">
                <span>租户内权限</span>
                <select
                  value={tenantRole}
                  onChange={(e) => setTenantRole(e.target.value as PortalRole)}
                  className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
                >
                  <option value="admin">租户管理员</option>
                  <option value="member">普通成员</option>
                </select>
              </label>
            </>
          )}
        </div>

        {role === "customer" && (
          <div className="flex flex-wrap gap-4 text-[12px] text-ink-secondary">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={legacyLocalAccount}
                onChange={(e) => setLegacyLocalAccount(e.target.checked)}
              />
              老账号测试模式（不绑手机号）
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={autoSwitchSession}
                onChange={(e) => setAutoSwitchSession(e.target.checked)}
              />
              建完自动跳转到该测试账号的 /portal
            </label>
          </div>
        )}

        <button
          type="submit"
          className="rounded-full bg-accent text-accent-ink px-4 py-1.5 text-[13px] font-medium hover:opacity-90"
        >
          创建账号
        </button>
      </form>

      <div className="grid gap-2 sm:grid-cols-2">
        {users.map((u) => (
          <div key={u.id} className="rounded-xl border border-hairline bg-card p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-ink-secondary" aria-hidden="true" />
                  {u.displayName}（{u.username}）
                </div>
                <div className="text-[12px] text-ink-tertiary">
                  {u.role === "ops_admin" ? "管理员" : `客户 · 租户 ${u.tenantId ?? "-"}`}
                  {u.legacyLocalAccount ? " · 老账号测试" : ""} · {u.disabledAt ? "已停用" : "正常"}
                </div>
              </div>
              {!u.disabledAt && (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setResetTarget(resetTarget === u.id ? null : u.id)}
                    className="rounded-full border border-hairline bg-control px-2.5 py-1 text-[12px]"
                  >
                    改密码
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDisable(u.id)}
                    className="rounded-full border border-danger/40 text-danger px-2.5 py-1 text-[12px]"
                  >
                    停用
                  </button>
                </div>
              )}
            </div>
            {resetTarget === u.id && (
              <div className="flex gap-2 pt-1">
                <input
                  type="password"
                  minLength={6}
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="输入新密码（至少 6 位）"
                  className="flex-1 rounded-lg border border-hairline bg-inset px-2.5 py-1 text-[12px] text-ink"
                />
                <button
                  type="button"
                  onClick={() => void handleResetPassword(u.id)}
                  className="rounded-full bg-ink text-app px-3 py-1 text-[12px]"
                >
                  确认
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
