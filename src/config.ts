import { readFileSync } from 'node:fs';

/** 单个上游 provider 的配置 */
export interface ProviderConfig {
  /** base_url，如 https://api.deepseek.com/v1（末尾斜杠会被去掉） */
  base_url: string;
  /** 上游密钥，支持 ${ENV_VAR} 环境变量插值 */
  api_key: string;
  /** 该 provider 可用的模型列表 */
  models: string[];
}

/** 完整配置文件结构 */
export interface Config {
  port: number;
  host: string;
  /** agent 未指定 model 时使用的别名 */
  default_model: string;
  /** 非流式请求的上游超时（秒）；流式请求的空闲超时（秒） */
  timeout_seconds: number;
  /** 是否写 access.log（JSONL 逐请求记录） */
  access_log: boolean;
  /** 下游鉴权密钥列表，agent 必须携带其中之一 */
  keys: string[];
  /**
   * 管理界面密码（非回环访问 /admin 时登录用），支持 ${ENV_VAR} 插值；
   * 留空 = 未配置（此时非回环访问登录页会提示去配置文件配置）
   */
  admin_password: string;
  providers: Record<string, ProviderConfig>;
  /** 别名 -> 有序的 "provider:model" 列表，顺序即 failover 顺序 */
  aliases: Record<string, string[]>;
}

/** 配置加载/校验失败 */
export class ConfigError extends Error {}

const ENV_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * api_key 插值：值为 `${VAR}` 时从环境变量读取，否则按字面量返回。
 * 环境变量未设置时抛 ConfigError。
 */
export function interpolateEnv(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('api_key 必须是非空字符串');
  }
  const m = ENV_PATTERN.exec(value);
  if (!m) return value;
  const env = process.env[m[1]];
  if (env === undefined || env.length === 0) {
    throw new ConfigError(`环境变量 ${m[1]} 未设置（api_key 引用了它）`);
  }
  return env;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从文件加载并校验配置；任何不合法之处抛 ConfigError */
export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${path}: ${(e as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`配置文件 ${path} 不是合法 JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw, path);
}

export function validateConfig(raw: unknown, path = '<config>'): Config {
  const fail = (msg: string): never => {
    throw new ConfigError(`配置错误 ${path}: ${msg}`);
  };
  if (!isPlainObject(raw)) fail('必须是 JSON 对象');
  // 不依赖 isPlainObject 的类型守卫收窄（TS 5.9 下对 unknown 参数收窄不可靠），显式断言
  const r = raw as Record<string, unknown>;

  const port = typeof r.port === 'number' ? r.port : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port 必须是 1-65535 的整数');

  const host = typeof r.host === 'string' ? r.host : '127.0.0.1';
  if (host.length === 0) fail('host 必须是非空字符串');

  const timeout_seconds = typeof r.timeout_seconds === 'number' ? r.timeout_seconds : 60;
  if (!Number.isFinite(timeout_seconds) || timeout_seconds <= 0) {
    fail('timeout_seconds 必须是大于 0 的数字');
  }

  const access_log = r.access_log !== false; // 默认开启

  const keysRaw = r.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length === 0) fail('keys 必须是非空数组（下游鉴权密钥）');
  const keys = keysRaw as string[];
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) fail('keys 的每一项必须是非空字符串');

  const providersRaw = r.providers;
  if (!isPlainObject(providersRaw)) fail('providers 必须是对象');
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, pRaw] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (!isPlainObject(pRaw)) fail(`providers.${name} 必须是对象`);
    const p = pRaw as Record<string, unknown>;
    const base_urlRaw = p.base_url;
    if (typeof base_urlRaw !== 'string' || !/^https?:\/\/[^/\s]+/.test(base_urlRaw)) {
      fail(`providers.${name}.base_url 必须是 http(s) URL`);
    }
    const base_url = base_urlRaw as string; // 运行时校验已保证是 string
    const api_key = ((): string => {
      try {
        return interpolateEnv(p.api_key);
      } catch (e) {
        return fail(`providers.${name}.api_key: ${(e as Error).message}`);
      }
    })();
    const modelsRaw = p.models;
    if (
      !Array.isArray(modelsRaw) ||
      modelsRaw.length === 0 ||
      !modelsRaw.every((m) => typeof m === 'string' && m.length > 0)
    ) {
      fail(`providers.${name}.models 必须是非空字符串数组`);
    }
    providers[name] = {
      base_url: base_url.replace(/\/+$/, ''),
      api_key,
      models: modelsRaw as string[],
    };
  }

  const aliasesRaw = r.aliases;
  if (!isPlainObject(aliasesRaw)) fail('aliases 必须是对象');
  const aliases: Record<string, string[]> = {};
  for (const [name, targetsRaw] of Object.entries(aliasesRaw as Record<string, unknown>)) {
    if (!Array.isArray(targetsRaw) || targetsRaw.length === 0 || !targetsRaw.every((t) => typeof t === 'string')) {
      fail(`aliases.${name} 必须是非空 "provider:model" 字符串数组`);
    }
    const targets = targetsRaw as string[];
    for (const t of targets) {
      const sep = t.indexOf(':');
      if (sep <= 0 || sep === t.length - 1) {
        fail(`aliases.${name} 中 "${t}" 必须是 "provider:model" 形式`);
      }
      const provName = t.slice(0, sep);
      const modelName = t.slice(sep + 1);
      const prov = providers[provName];
      if (!prov) fail(`aliases.${name} 中 "${t}" 引用了不存在的 provider "${provName}"`);
      if (!prov.models.includes(modelName)) {
        fail(`aliases.${name} 中 "${t}" 引用的模型 "${modelName}" 不在 provider "${provName}" 的 models 列表中`);
      }
    }
    aliases[name] = targets;
  }

  if (Object.keys(aliases).length === 0) fail('aliases 至少要定义一个别名');

  const default_model = typeof r.default_model === 'string' ? r.default_model : (Object.keys(aliases)[0] ?? '');
  if (!aliases[default_model]) {
    fail(`default_model "${default_model}" 不是已定义的别名（可用: ${Object.keys(aliases).join(', ')}）`);
  }

  // 管理界面密码：支持 ${ENV} 插值；缺省/空 = 未配置（非回环访问登录页时提示去配置文件配置）
  let admin_password = '';
  const adminPasswordRaw = r.admin_password;
  if (adminPasswordRaw !== undefined) {
    if (typeof adminPasswordRaw !== 'string') fail('admin_password 必须是字符串');
    const pwd = adminPasswordRaw as string; // TS 5.9 对 Record 索引的 typeof 收窄不可靠，显式断言
    if (pwd.length > 0) {
      try {
        admin_password = interpolateEnv(pwd);
      } catch (e) {
        fail(`admin_password: ${(e as Error).message}`);
      }
    }
  }

  return { port, host, default_model, timeout_seconds, access_log, keys, admin_password, providers, aliases };
}
