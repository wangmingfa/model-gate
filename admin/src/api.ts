/** 与后端 /admin/api/* 的接口定义 */

export interface ProviderDraft {
  base_url: string;
  /** provider 原始 api_key（可能是 ${VAR} 引用或明文）；前端仅用于显示时掩码，回写原样保存；留空 = 保持磁盘原值 */
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

export function testConnection(
  provider: string,
  model: string,
  /** 前端当前草稿（未保存）的 base_url / api_key；为空则后端回退用服务端已保存的真实值 */
  draft?: { base_url?: string; api_key?: string },
): Promise<TestResult> {
  return request('/test', {
    method: 'POST',
    body: JSON.stringify({ provider, model, base_url: draft?.base_url ?? '', api_key: draft?.api_key ?? '' }),
  });
}

export interface FetchModelsResult {
  ok: boolean;
  ms?: number;
  status?: number | null;
  error?: string;
  /** 上游返回的模型 id 列表（ok 为 true 时存在） */
  models?: string[];
}

/** 拉取上游模型列表：GET {base_url}/models，解析 OpenAI 标准 data[].id。
 *  draft 为前端当前未保存的 base_url / api_key，为空则后端回退服务端已保存值。 */
export function fetchModels(
  provider: string,
  draft?: { base_url?: string; api_key?: string },
): Promise<FetchModelsResult> {
  return request('/fetch-models', {
    method: 'POST',
    body: JSON.stringify({ provider, base_url: draft?.base_url ?? '', api_key: draft?.api_key ?? '' }),
  });
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
