import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

interface UnifiedAuthMe {
  authenticated: boolean;
  kind?: "customer" | "admin";
  redirectTo?: "/portal" | "/admin";
}

interface UnifiedLoginResponse {
  kind: "customer" | "admin";
  redirectTo: "/portal" | "/admin";
  error?: string;
  message?: string;
}

/**
 * Unified username + password login entry (`/login`) for both customers and ops admins.
 * No phone login, no self-registration, and no Feishu QR login entry.
 */
export function UnifiedLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as UnifiedAuthMe;
      })
      .then((data) => {
        if (data?.authenticated && data.redirectTo) {
          window.location.replace(data.redirectTo);
        }
      })
      .catch(() => {
        // Stay on login page when unauthenticated.
      })
      .finally(() => setChecking(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, cookie: true }),
      });
      const data = (await res.json().catch(() => ({}))) as UnifiedLoginResponse;
      if (!res.ok) {
        throw new Error(data.message || data.error || `登录失败 (${res.status})`);
      }
      window.location.replace(data.redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请检查用户名和密码");
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
        <span className="text-sm text-ink-secondary">正在检查登录状态...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-card p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-ink">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-ink">OpenMausBot 统一登录</h1>
            <p className="text-xs text-ink-secondary">登录后将按账号角色自动进入客户门户或管理后台</p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-secondary">用户名</span>
            <input
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入账号名"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-focus"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-secondary">密码</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-focus"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" />
            {submitting ? "正在登录..." : "登录"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-tertiary">
          账号由管理员在后台统一开通，不开放自助注册
        </p>
      </div>
    </div>
  );
}
