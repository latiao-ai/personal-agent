import { useEffect, useState } from "react";
import { Activity, Cpu, KeyRound, RefreshCw } from "lucide-react";

import type { AdminLlmProviderView, LlmPricing } from "../../shared/llm-proxy";

interface AdminLlmSectionProps {
  providers: AdminLlmProviderView[];
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

export function AdminLlmSection({ providers, onRefresh, onNotify, onError }: AdminLlmSectionProps) {
  const [editingId, setEditingId] = useState<string>("");
  const [name, setName] = useState("DeepSeek 中转站");
  const [baseUrl, setBaseUrl] = useState("https://");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("deepseek-chat");
  const [fastModel, setFastModel] = useState("deepseek-chat");
  const [enabled, setEnabled] = useState(true);
  const [costInput, setCostInput] = useState("1");
  const [costOutput, setCostOutput] = useState("2");
  const [priceInput, setPriceInput] = useState("2");
  const [priceOutput, setPriceOutput] = useState("4");

  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; latencyMs: number; error?: string } | null>(
    null,
  );

  // Secondary confirmation state for API key rotation
  const [rotateTargetId, setRotateTargetId] = useState<string | null>(null);
  const [rotateKeyValue, setRotateKeyValue] = useState("");
  const [rotating, setRotating] = useState(false);

  const selectedProvider = providers.find((p) => p.id === editingId) ?? null;

  const selectProvider = async (provider: AdminLlmProviderView) => {
    setEditingId(provider.id);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setDefaultModel(provider.defaultModel);
    setFastModel(provider.fastModel);
    setEnabled(provider.enabled);
    setTestResult(null);
    try {
      const res = await api<{ pricing: LlmPricing }>(`/api/admin/llm/pricing/${encodeURIComponent(provider.id)}`);
      setCostInput(String(res.pricing.costPer1MInputTokens));
      setCostOutput(String(res.pricing.costPer1MOutputTokens));
      setPriceInput(String(res.pricing.pricePer1MInputTokens));
      setPriceOutput(String(res.pricing.pricePer1MOutputTokens));
    } catch {
      // Keep current draft values if pricing has not been configured yet.
    }
  };

  useEffect(() => {
    if (!editingId && providers.length > 0) {
      const first = providers[0]!;
      void selectProvider(first);
    }
  }, [editingId, providers]);

  const handleResetNew = () => {
    setEditingId("");
    setName("");
    setBaseUrl("https://");
    setApiKey("");
    setDefaultModel("deepseek-chat");
    setFastModel("deepseek-chat");
    setEnabled(true);
    setCostInput("1");
    setCostOutput("2");
    setPriceInput("2");
    setPriceOutput("4");
    setTestResult(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setTestResult(null);
    try {
      const cIn = Number(costInput);
      const cOut = Number(costOutput);
      const pIn = Number(priceInput);
      const pOut = Number(priceOutput);
      if (Number.isNaN(cIn) || Number.isNaN(cOut) || Number.isNaN(pIn) || Number.isNaN(pOut)) {
        throw new Error("成本价与售价必须为有效数字");
      }
      if (pIn < cIn || pOut < cOut) {
        throw new Error("售价必须大于或等于成本价");
      }

      const endpoint = editingId
        ? `/api/admin/llm/providers/${encodeURIComponent(editingId)}`
        : "/api/admin/llm/providers";
      const method = editingId ? "PUT" : "POST";

      const savedRes = await api<{ provider: AdminLlmProviderView }>(endpoint, {
        method,
        body: JSON.stringify({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          defaultModel: defaultModel.trim(),
          fastModel: fastModel.trim() || undefined,
          enabled,
        }),
      });

      await api(`/api/admin/llm/pricing/${encodeURIComponent(savedRes.provider.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          costPer1MInputTokens: cIn,
          costPer1MOutputTokens: cOut,
          pricePer1MInputTokens: pIn,
          pricePer1MOutputTokens: pOut,
        }),
      });

      setEditingId(savedRes.provider.id);
      setApiKey("");
      onNotify(
        `模型供应商「${savedRes.provider.name}」已保存（Key ${
          savedRes.provider.apiKeyConfigured ? savedRes.provider.apiKeyLast4 : "未配置"
        }）并记入审计`,
      );
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "保存模型配置失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (providerId: string) => {
    setTestingId(providerId);
    setTestResult(null);
    try {
      const res = await api<{ ok: boolean; latencyMs: number; error?: string }>(
        `/api/admin/llm/providers/${encodeURIComponent(providerId)}/test`,
        { method: "POST", body: "{}" },
      );
      setTestResult({ id: providerId, ...res });
      if (res.ok) {
        onNotify(`连通性测试通过（${res.latencyMs} ms）`);
      } else {
        onError(`连通性测试失败：${res.error ?? "未知错误"}（当前生效配置未改变）`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "连通性测试失败";
      setTestResult({ id: providerId, ok: false, latencyMs: 0, error: msg });
      onError(`${msg}（当前生效配置未改变）`);
    } finally {
      setTestingId(null);
    }
  };

  const handleConfirmRotate = async (providerId: string) => {
    if (!rotateKeyValue.trim()) {
      onError("请输入新的 API Key");
      return;
    }
    setRotating(true);
    try {
      const res = await api<{ provider: AdminLlmProviderView }>(
        `/api/admin/llm/providers/${encodeURIComponent(providerId)}/rotate`,
        {
          method: "POST",
          body: JSON.stringify({ apiKey: rotateKeyValue.trim(), confirm: true }),
        },
      );
      setRotateTargetId(null);
      setRotateKeyValue("");
      onNotify(`API Key 已轮换（新 Key ${res.provider.apiKeyLast4}），旧 Key 已立即失效并记入审计`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "轮换 Key 失败");
    } finally {
      setRotating(false);
    }
  };

  const keyPlaceholder =
    selectedProvider && selectedProvider.apiKeyConfigured
      ? `已配置 ${selectedProvider.apiKeyLast4}，留空不改`
      : "输入 API Key（仅存控制面 Vault）";

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-ink-secondary" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">模型配置与定价</h2>
        </div>
        <button
          type="button"
          onClick={handleResetNew}
          className="rounded-full border border-hairline bg-control px-3 py-1 text-[12px] font-medium hover:bg-ink/[0.06]"
        >
          新建供应商
        </button>
      </div>

      {/* Existing providers list */}
      {providers.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {providers.map((item) => (
            <div key={item.id} className="rounded-xl border border-hairline bg-card p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => void selectProvider(item)}
                  className="text-start text-[14px] font-medium text-ink hover:underline truncate"
                >
                  {item.name}
                </button>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium shrink-0 ${
                    item.enabled ? "bg-success/15 text-success" : "bg-inset text-ink-tertiary"
                  }`}
                >
                  {item.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <div className="text-[12px] text-ink-secondary font-mono truncate">{item.baseUrl}</div>
              <div className="text-[12px] text-ink-secondary">
                默认模型：{item.defaultModel} · 分流小模型：{item.fastModel}
              </div>
              <div className="text-[12px] text-ink-tertiary tabular-nums">
                Key：{item.apiKeyConfigured ? `已配置 ${item.apiKeyLast4}` : "未配置"} · 更新人：{item.updatedBy} ·{" "}
                {new Date(item.updatedAt).toLocaleString()}
              </div>

              {testResult && testResult.id === item.id && (
                <div
                  role="status"
                  className={`rounded-lg px-3 py-1.5 text-[12px] tabular-nums ${
                    testResult.ok ? "bg-success/15 text-success" : "bg-danger/10 text-danger"
                  }`}
                >
                  {testResult.ok
                    ? `连通性正常（${testResult.latencyMs} ms）`
                    : `测试失败：${testResult.error ?? "不可达"}`}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void selectProvider(item)}
                  className="rounded-full border border-hairline bg-control px-3 py-1 text-[12px] font-medium hover:bg-ink/[0.06]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  disabled={testingId === item.id}
                  onClick={() => void handleTest(item.id)}
                  className="inline-flex items-center gap-1 rounded-full border border-hairline bg-control px-3 py-1 text-[12px] font-medium hover:bg-ink/[0.06] disabled:opacity-50"
                >
                  <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                  {testingId === item.id ? "测试中…" : "测试连通性"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRotateTargetId(rotateTargetId === item.id ? null : item.id);
                    setRotateKeyValue("");
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-danger/40 text-danger px-3 py-1 text-[12px] font-medium hover:bg-danger/10"
                >
                  <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                  轮换 Key
                </button>
              </div>

              {rotateTargetId === item.id && (
                <div className="rounded-lg border border-hairline bg-panel p-3 space-y-2">
                  <div className="text-[12px] text-ink-secondary">
                    轮换后旧 Key 立即失效，请输入新 Key 并二次确认：
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="password"
                      value={rotateKeyValue}
                      onChange={(e) => setRotateKeyValue(e.target.value)}
                      placeholder="输入新 API Key"
                      className="flex-1 min-w-44 rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[12px] text-ink"
                    />
                    <button
                      type="button"
                      disabled={rotating}
                      onClick={() => void handleConfirmRotate(item.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-danger text-danger-ink px-3 py-1 text-[12px] font-medium disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      {rotating ? "轮换中…" : "二次确认轮换"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRotateTargetId(null);
                        setRotateKeyValue("");
                      }}
                      className="rounded-full border border-hairline px-3 py-1 text-[12px]"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Provider & pricing editor form */}
      <form onSubmit={(e) => void handleSave(e)} className="rounded-xl border border-hairline bg-card p-4 space-y-3">
        <div className="text-[13px] font-medium text-ink">
          {editingId ? `编辑供应商（${editingId}）` : "新增模型供应商"}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>供应商名称</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="DeepSeek 中转站"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>中转站地址（必须 https:// 开头）</span>
            <input
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink font-mono"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyPlaceholder}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>默认模型</span>
            <input
              required
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder="deepseek-chat"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink font-mono"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>分流小模型（留空同默认模型）</span>
            <input
              value={fastModel}
              onChange={(e) => setFastModel(e.target.value)}
              placeholder="deepseek-chat"
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink font-mono"
            />
          </label>

          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2 text-[13px] text-ink cursor-pointer">
              <input
                type="checkbox"
                role="switch"
                aria-checked={enabled}
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>启用该供应商</span>
            </label>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>输入成本（元 / 1M token）</span>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={costInput}
              onChange={(e) => setCostInput(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>输出成本（元 / 1M token）</span>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={costOutput}
              onChange={(e) => setCostOutput(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>输入售价（元 / 1M token）</span>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
            />
          </label>

          <label className="space-y-1 text-[12px] text-ink-secondary">
            <span>输出售价（元 / 1M token）</span>
            <input
              type="number"
              step="0.01"
              min="0"
              required
              value={priceOutput}
              onChange={(e) => setPriceOutput(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 text-[13px] text-ink tabular-nums"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded-full bg-ink text-app px-4 py-1.5 text-[13px] font-medium disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
          {editingId && (
            <button
              type="button"
              disabled={testingId === editingId}
              onClick={() => void handleTest(editingId)}
              className="rounded-full border border-hairline bg-control px-4 py-1.5 text-[13px] font-medium hover:bg-ink/[0.06] disabled:opacity-50"
            >
              {testingId === editingId ? "测试中…" : "测试连通性"}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
