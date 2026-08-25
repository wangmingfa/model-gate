/** 与后端 /admin/api/* 的接口定义 */

export interface ProviderDraft {
  base_url: string;
  /** provider 原始 api_key（可能是 ${VAR} 引用或明文）；前端仅用于显示时掩码，回写原样保存；留空 = 保持磁盘原值 */
  api_key: string;
  models: string[];
  /** 模型计费单价（每 1M tokens），可选；键为模型 id，值为 { prompt, completion } */
  pricing?: Record<string, { prompt: number; completion: number }>;
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

/** 别名实际生效模型状态：每个别名最近一次成功请求用到的真实模型 */
export interface AliasStatus {
  name: string;
  /** 最近一次成功请求实际生效的 "provider:model" */
  activeModel: string;
  /** 该次请求的时间戳（ISO） */
  lastSuccessTs: string;
}

/** 拉取每个别名「当前实际生效」的模型（来自 access.log 最近一次成功请求） */
export function getAliasStatus(): Promise<{ generatedAt: string; aliases: AliasStatus[] }> {
  return request('/alias-status');
}

export function saveConfig(draft: ConfigDraft): Promise<{ ok: true }> {
  return request('/config', { method: 'PUT', body: JSON.stringify(draft) });
}

/** 导出当前配置（原始 JSON，含 ${VAR} 引用与 admin_password），用于备份/迁移 */
export function exportConfig(): Promise<Record<string, unknown>> {
  return request('/config/export');
}

/** 导入完整配置对象，校验后原子写回（与保存共用后端逻辑） */
export function importConfig(draft: ConfigDraft): Promise<{ ok: true }> {
  return request('/config/import', { method: 'POST', body: JSON.stringify(draft) });
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

/** 单个提供商的延迟探测结果（一键测试所有提供商时返回） */
export interface ProviderLatency {
  /** provider 名称 */
  provider: string;
  /** 实际探测用的模型（取该 provider 的 models[0]） */
  model: string;
  /** 探测是否成功（HTTP 2xx 且拿到响应） */
  ok: boolean;
  /** 耗时（毫秒）；失败时为超时/异常前的耗时 */
  ms?: number;
  /** HTTP 状态码；网络/超时异常时为 null */
  status?: number | null;
  /** 失败原因（HTTP 非 2xx 的响应体摘要，或异常信息） */
  error?: string;
}

/** 一键测试所有提供商的延迟：后端并发探测每个 provider 的第一个模型，返回各 provider 耗时与成败 */
export function testAllProviders(): Promise<{ results: ProviderLatency[] }> {
  return request('/providers/latency', { method: 'POST' });
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

// ---- 用量统计 ----

export interface StatsOverview {
  requests: number;
  success: number;
  failures: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 估算成本（按各 provider 配置的单价 × token 用量汇总；未配置单价的模型记为 0） */
  cost: number;
  p95Ms: number;
}

export interface StatsRow {
  key: string;
  requests: number;
  failures: number;
  successRate: number;
  tokens: number;
  /** 估算成本（该维度下汇总） */
  cost: number;
  p95Ms: number;
}

export interface StatsResponse {
  rangeDays: number;
  generatedAt: string;
  overview: StatsOverview;
  byAlias: StatsRow[];
  byKey: StatsRow[];
  byDay: StatsRow[];
}

/** 拉取用量统计：仅聚合 /v1/chat/completions 真实流量 */
export function getStats(days = 30): Promise<StatsResponse> {
  return request(`/stats?days=${days}`);
}
