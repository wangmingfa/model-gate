/** 与后端 /admin/api/* 的接口定义 */

export interface ProviderDraft {
  base_url: string;
  /** 掩码形式（sk-****abc）或新密钥；留空 = 保持原值 */
  api_key: string;
  models: string[];
}

/** 下游密钥：名称 + 密钥值（已有密钥后端返回掩码形式）+ 添加时间 */
export interface ClientKeyDraft {
  name: string;
  key: string;
  created_at: string;
}

export interface ConfigDraft {
  port: number;
  host: string;
  default_model: string;
  timeout_seconds: number;
  access_log: boolean;
  keys: ClientKeyDraft[];
  providers: Record<string, ProviderDraft>;
  aliases: Record<string, string[]>;
}

/** 生成新密钥：sk- + 32 位随机十六进制（浏览器 crypto 随机源） */
export function generateKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `sk-${hex}`;
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

/** 配置体检问题（与后端 ConfigIssue 对应） */
export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
  /** 定位：provider:<name> / alias:<name> / default_model / keys / providers / aliases / global */
  target?: string;
}

/** 检查配置正确性：对当前服务端配置做完整体检，返回全部错误/告警（不修改配置） */
export function checkConfig(): Promise<{ ok: true; issues: ConfigIssue[] }> {
  return request('/config/check', { method: 'POST' });
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

// ---- 登录 / 登出 / 登录状态 ----

export interface AuthStatus {
  passwordConfigured: boolean;
  configPath: string;
  loggedIn: boolean;
}

export function authStatus(): Promise<AuthStatus> {
  return request('/auth-status');
}

export function login(password: string): Promise<{ ok: true }> {
  return request('/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export function logout(): Promise<{ ok: true }> {
  return request('/logout', { method: 'POST' });
}
