import { readFileSync } from 'node:fs';

/** 单个模型的计费单价（每 1M tokens）；货币单位取决于你填写的价格，网关只做乘法汇总 */
export interface ModelPricing {
  /** 每 1M tokens 的提示(prompt/input)价格 */
  prompt: number;
  /** 每 1M tokens 的完成(completion/output)价格 */
  completion: number;
}

/** 单个上游 provider 的配置 */
export interface ProviderConfig {
  /** base_url，如 https://api.deepseek.com/v1（末尾斜杠会被去掉） */
  base_url: string;
  /** 上游密钥（解析后，运行时使用），支持 ${ENV_VAR} 插值 */
  api_key: string;
  /** 上游密钥原始字符串（未经插值，可能为 ${VAR} 引用或明文）；仅供管理界面原样回写，避免误落明文/破坏引用 */
  api_key_raw: string;
  /** 该 provider 可用的模型列表 */
  models: string[];
  /** 模型计费单价（每 1M tokens），可选；配置了才能在用量统计里估算成本 */
  pricing?: Record<string, ModelPricing>;
}

/** 下游密钥：带名称与添加时间的对象（密钥由管理界面自动生成，已有密钥不可编辑只能删除） */
export interface ClientKey {
  /** 密钥名称，如 "Claude"、"Cursor" */
  name: string;
  /** 密钥值，agent 连入网关时携带 */
  key: string;
  /** 添加时间（ISO 字符串），UI 展示用 */
  created_at: string;
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
  /** 下游鉴权密钥列表（带名称与添加时间），agent 必须携带其中一个 key 值 */
  keys: ClientKey[];
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

/** 配置体检问题：level 区分错误/告警；target 用于前端定位具体字段标红 */
export interface ConfigIssue {
  level: 'error' | 'warning';
  message: string;
  /**
   * 定位标识，供前端把具体出错处标红：
   * - provider:<name>  上游运营商卡片
   * - alias:<name>     模型别名卡片
   * - default_model    默认模型下拉
   * - keys / providers / aliases  对应区块（仅告警）
   * - global           结构性错误（保存已被拦截，无法定位到具体字段）
   */
  target?: string;
}

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
export function loadConfig(path: string, mode: 'strict' | 'boot' = 'boot'): Config {
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
  return validateConfig(raw, path, mode);
}

export function validateConfig(raw: unknown, path = '<config>', mode: 'strict' | 'boot' = 'strict'): Config {
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

  const keysRaw: unknown[] = Array.isArray(r.keys) ? r.keys : []; // TS 5.9 对 Record 索引的 Array.isArray 收窄不可靠
  // keys 允许为空（分步配置场景：用户可能先填 providers/aliases，稍后再加 key；空时 /v1 返回 503 引导去配置）
  const keys: ClientKey[] = [];
  for (const item of keysRaw) {
    if (typeof item !== 'object' || item === null) fail('keys 的每一项必须是对象 { name, key, created_at }');
    const k = item as Record<string, unknown>;
    if (typeof k.name !== 'string' || k.name.length === 0) fail('keys 每一项的 name 必须是非空字符串');
    if (typeof k.key !== 'string' || k.key.length === 0) fail(`keys 每一项的 key 必须是非空字符串（${k.name}）`);
    if (typeof k.created_at !== 'string' || !Number.isFinite(Date.parse(k.created_at))) {
      fail(`keys 每一项的 created_at 必须是合法 ISO 时间（${k.name}）`);
    }
    // TS 5.9 对 Record 索引的 typeof 收窄不可靠，显式断言
    const name = k.name as string;
    const key = k.key as string;
    const created_at = k.created_at as string;
    keys.push({ name, key, created_at });
  }
  // 名称与 key 值都不允许重复
  const names = new Set(keys.map((k) => k.name));
  if (names.size !== keys.length) fail('keys 的名称不允许重复');
  const values = new Set(keys.map((k) => k.key));
  if (values.size !== keys.length) fail('keys 的密钥值不允许重复');

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
    const apiKeyRaw = typeof p.api_key === 'string' ? p.api_key : '';
    const api_key = ((): string => {
      try {
        return interpolateEnv(apiKeyRaw);
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

    // pricing（可选）：模型单价表，用于用量统计估算成本。键为模型 id，值为 {prompt,completion}
    // （每 1M tokens 价格，>=0 的数字）。不配置则统计时该模型成本为 0。
    let pricing: Record<string, ModelPricing> | undefined;
    const pricingRaw = p.pricing;
    if (pricingRaw !== undefined) {
      if (!isPlainObject(pricingRaw)) fail(`providers.${name}.pricing 必须是对象`);
      pricing = {};
      for (const [m, pr] of Object.entries(pricingRaw as Record<string, unknown>)) {
        if (!isPlainObject(pr)) fail(`providers.${name}.pricing.${m} 必须是对象 { prompt, completion }`);
        const prObj = pr as Record<string, unknown>;
        const prompt = prObj.prompt;
        const completion = prObj.completion;
        if (typeof prompt !== 'number' || !Number.isFinite(prompt) || prompt < 0) {
          fail(`providers.${name}.pricing.${m}.prompt 必须是 >=0 的数字`);
        }
        if (typeof completion !== 'number' || !Number.isFinite(completion) || completion < 0) {
          fail(`providers.${name}.pricing.${m}.completion 必须是 >=0 的数字`);
        }
        pricing[m] = { prompt: prompt as number, completion: completion as number };
      }
    }

    providers[name] = {
      base_url: base_url.replace(/\/+$/, ''),
      api_key,
      api_key_raw: apiKeyRaw,
      models: modelsRaw as string[],
      pricing,
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
        // 引用完整性（provider 是否存在、模型是否在 provider 的 models 中）交由 checkConfig 收集报告，
        // 不在校验阶段拦截，以支持分步配置（先配 alias 再补 provider）并由"检查配置正确性"按钮标红。
    }
    aliases[name] = targets;
  }

  const default_model = typeof r.default_model === 'string' ? r.default_model : (Object.keys(aliases)[0] ?? '');
  // default_model 是否为已定义别名的校验，交由 checkConfig 收集报告，不在校验阶段拦截

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

/**
 * 配置正确性体检：对一份已通过结构校验的配置，收集所有语义问题（错误 + 告警），不抛错。
 * 与 validateConfig 的区别：validateConfig 只做结构合法性校验并在首个问题抛错；
 * 这里聚焦引用完整性等语义问题，汇总全部问题，供「检查配置正确性」按钮做完整报告，
 * 并通过 target 定位到具体字段（provider/alias/default_model）在页面标红。
 */
export function checkConfig(cfg: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  // 引用完整性：alias -> provider -> model
  for (const [aliasName, targets] of Object.entries(cfg.aliases)) {
    for (const t of targets) {
      const sep = t.indexOf(':');
      const provName = t.slice(0, sep);
      const modelName = t.slice(sep + 1);
      const prov = cfg.providers[provName];
      if (!prov) {
        issues.push({
          level: 'error',
          message: `别名「${aliasName}」引用了不存在的 provider「${provName}」（${t}）`,
          target: `alias:${aliasName}`,
        });
      } else if (!prov.models.includes(modelName)) {
        issues.push({
          level: 'error',
          message: `别名「${aliasName}」引用的模型「${modelName}」不在 provider「${provName}」的 models 列表中（${t}）`,
          target: `alias:${aliasName}`,
        });
      }
    }
  }

  // default_model 有效性
  if (cfg.default_model && !cfg.aliases[cfg.default_model]) {
    issues.push({
      level: 'error',
      message: `default_model「${cfg.default_model}」不是已定义的别名`,
      target: 'default_model',
    });
  }

  // 信息性告警（不影响运行，但提示用户预期行为）
  if (cfg.keys.length === 0) {
    issues.push({
      level: 'warning',
      message: '尚未配置任何下游密钥（keys 为空），/v1/* 接口将返回 503 引导去 /admin 配置',
      target: 'keys',
    });
  }
  if (Object.keys(cfg.providers).length === 0) {
    issues.push({ level: 'warning', message: '尚未配置任何上游 provider', target: 'providers' });
  }
  if (Object.keys(cfg.aliases).length === 0) {
    issues.push({ level: 'warning', message: '尚未定义任何别名（aliases 为空），agent 无法通过 /v1/models 获取可用模型', target: 'aliases' });
  }

  return issues;
}
