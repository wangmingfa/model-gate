/** 与后端 /admin/api/* 的接口定义 */

export interface ProviderDraft {
  base_url: string;
  /** 掩码形式（sk-****abc）或新密钥；留空 = 保持原值 */
  api_key: string;
  models: string[];
}

export interface ConfigDraft {
  port: number;
  host: string;
  default_model: string;
  timeout_seconds: number;
  access_log: boolean;
  keys: string[];
  providers: Record<string, ProviderDraft>;
  aliases: Record<string, string[]>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export function getConfig(): Promise<ConfigDraft> {
  return request('/config');
}

export function saveConfig(draft: ConfigDraft): Promise<{ ok: true }> {
  return request('/config', { method: 'PUT', body: JSON.stringify(draft) });
}

export interface TestResult {
  ok: boolean;
  ms?: number;
  status?: number | null;
  error?: string;
}

export function testConnection(provider: string, model: string): Promise<TestResult> {
  return request('/test', { method: 'POST', body: JSON.stringify({ provider, model }) });
}
