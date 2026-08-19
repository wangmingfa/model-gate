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

  const port = raw.port ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('port 必须是 1-65535 的整数');

  const host = raw.host ?? '127.0.0.1';
  if (typeof host !== 'string' || host.length === 0) fail('host 必须是非空字符串');

  const timeout_seconds = raw.timeout_seconds ?? 60;
  if (typeof timeout_seconds !== 'number' || !Number.isFinite(timeout_seconds) || timeout_seconds <= 0) {
    fail('timeout_seconds 必须是大于 0 的数字');
  }

  const access_log = raw.access_log !== false; // 默认开启

  const keys = raw.keys;
  if (!Array.isArray(keys) || keys.length === 0) fail('keys 必须是非空数组（下游鉴权密钥）');
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) fail('keys 的每一项必须是非空字符串');

  const providersRaw = raw.providers;
  if (!isPlainObject(providersRaw)) fail('providers 必须是对象');
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, p] of Object.entries(providersRaw)) {
    if (!isPlainObject(p)) fail(`providers.${name} 必须是对象`);
    const base_url = p.base_url;
    if (typeof base_url !== 'string' || !/^https?:\/\/.+/.test(base_url)) {
      fail(`providers.${name}.base_url 必须是 http(s) URL`);
    }
    let api_key: string;
    try {
      api_key = interpolateEnv(p.api_key);
    } catch (e) {
      fail(`providers.${name}.api_key: ${(e as Error).message}`);
    }
    const models = p.models;
    if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === 'string' && m.length > 0)) {
      fail(`providers.${name}.models 必须是非空字符串数组`);
    }
    providers[name] = {
      base_url: base_url.replace(/\/+$/, ''),
      api_key,
      models: models as string[],
    };
  }

  const aliasesRaw = raw.aliases;
  if (!isPlainObject(aliasesRaw)) fail('aliases 必须是对象');
  const aliases: Record<string, string[]> = {};
  for (const [name, targets] of Object.entries(aliasesRaw)) {
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string')) {
      fail(`aliases.${name} 必须是非空 "provider:model" 字符串数组`);
    }
    for (const t of targets as string[]) {
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
    aliases[name] = targets as string[];
  }

  if (Object.keys(aliases).length === 0) fail('aliases 至少要定义一个别名');

  const default_model = raw.default_model ?? Object.keys(aliases)[0];
  if (typeof default_model !== 'string' || !aliases[default_model]) {
    fail(`default_model "${String(default_model)}" 不是已定义的别名（可用: ${Object.keys(aliases).join(', ')}）`);
  }

  return { port, host, default_model, timeout_seconds, access_log, keys: keys as string[], providers, aliases };
}
