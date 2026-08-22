import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { loadConfig, validateConfig, checkConfig, interpolateEnv, ConfigError } from './config';

const base = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: true,
  keys: [
    { name: 'a', key: 'sk-a', created_at: '2026-01-01T00:00:00.000Z' },
    { name: 'b', key: 'sk-b', created_at: '2026-01-02T00:00:00.000Z' },
  ],
  providers: {
    deepseek: {
      base_url: 'https://api.deepseek.com/v1/',
      api_key: 'sk-ds',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
  },
  aliases: {
    fast: ['deepseek:deepseek-chat'],
    reason: ['deepseek:deepseek-reasoner'],
  },
};

function writeTmp(name: string, content: unknown): string {
  const path = `/tmp/mg-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('validateConfig', () => {
  test('合法配置通过，且 base_url 尾部斜杠被去掉', () => {
    const cfg = validateConfig(base);
    expect(cfg.port).toBe(8787);
    expect(cfg.providers.deepseek.base_url).toBe('https://api.deepseek.com/v1');
    expect(cfg.default_model).toBe('fast');
  });

  test('缺省字段取默认值', () => {
    const cfg = validateConfig({
      keys: [{ name: 'k', key: 'sk-k', created_at: '2026-01-01T00:00:00.000Z' }],
      providers: { p: { base_url: 'https://x.com', api_key: 'k', models: ['m'] } },
      aliases: { a: ['p:m'] },
    });
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.timeout_seconds).toBe(60);
    expect(cfg.access_log).toBe(true);
    expect(cfg.default_model).toBe('a');
  });

  test('keys 为空不抛错（允许分步配置）', () => {
    expect(() => validateConfig({ ...base, keys: [] })).not.toThrow();
  });

  test('alias 引用不存在 provider 不抛错（交由 checkConfig 报告）', () => {
    expect(() => validateConfig({ ...base, aliases: { fast: ['nope:m'] } })).not.toThrow();
  });

  test('alias 引用 provider 没有的模型不抛错（交由 checkConfig 报告）', () => {
    expect(() => validateConfig({ ...base, aliases: { fast: ['deepseek:no-such'] } })).not.toThrow();
  });

  test('default_model 不是别名不抛错（交由 checkConfig 报告）', () => {
    expect(() => validateConfig({ ...base, default_model: 'ghost' })).not.toThrow();
  });

  test('alias 项不是 provider:model 形式抛错', () => {
    expect(() => validateConfig({ ...base, aliases: { fast: ['deepseek-chat'] } })).toThrow(/provider:model/);
  });

  test('port 非法抛错', () => {
    expect(() => validateConfig({ ...base, port: 99999 })).toThrow(/port/);
  });

  test('base_url 缺少主机名部分（如 "/chat"）应拒绝', () => {
    expect(() => validateConfig({ ...base, providers: { p: { base_url: '/chat/completions', api_key: 'k', models: ['m'] } } })).toThrow(/base_url/);
  });

  test('base_url 只有协议部分（如 "http:/"）应拒绝', () => {
    expect(() => validateConfig({ ...base, providers: { p: { base_url: 'http:///', api_key: 'k', models: ['m'] } } })).toThrow(/base_url/);
  });

  test('providers 不是对象抛错', () => {
    expect(() => validateConfig({ ...base, providers: [] })).toThrow(/providers/);
  });
});

describe('interpolateEnv', () => {
  test('字面量原样返回', () => {
    expect(interpolateEnv('sk-literal')).toBe('sk-literal');
  });

  test('${VAR} 从环境变量读取', () => {
    process.env.MG_TEST_KEY = 'sk-from-env';
    expect(interpolateEnv('${MG_TEST_KEY}')).toBe('sk-from-env');
  });

  test('环境变量缺失抛错', () => {
    delete process.env.MG_TEST_MISSING;
    expect(() => interpolateEnv('${MG_TEST_MISSING}')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  test('读取文件并校验', () => {
    const path = writeTmp('ok', base);
    const cfg = loadConfig(path);
    expect(cfg.aliases.fast).toEqual(['deepseek:deepseek-chat']);
  });

  test('文件不存在抛错', () => {
    expect(() => loadConfig('/tmp/definitely-not-exists-mg.json')).toThrow(ConfigError);
  });

  test('非法 JSON 抛错', () => {
    const path = '/tmp/mg-bad-json.json';
    require('node:fs').writeFileSync(path, '{not json');
    expect(() => loadConfig(path)).toThrow(/不是合法 JSON/);
  });
});

describe('checkConfig', () => {
  test('合法配置无问题', () => {
    const cfg = validateConfig(base);
    expect(checkConfig(cfg)).toEqual([]);
  });

  test('alias 引用不存在 provider 报 error', () => {
    const cfg = validateConfig({ ...base, aliases: { fast: ['nope:m'] } });
    const issues = checkConfig(cfg);
    const err = issues.find((i) => i.level === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/不存在的 provider/);
    expect(err!.target).toBe('alias:fast');
  });

  test('alias 引用 provider 没有的模型报 error', () => {
    const cfg = validateConfig({ ...base, aliases: { fast: ['deepseek:no-such'] } });
    const issues = checkConfig(cfg);
    const err = issues.find((i) => i.level === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/不在 provider/);
    expect(err!.target).toBe('alias:fast');
  });

  test('default_model 不是别名报 error', () => {
    const cfg = validateConfig({ ...base, default_model: 'ghost' });
    const issues = checkConfig(cfg);
    const err = issues.find((i) => i.target === 'default_model');
    expect(err).toBeDefined();
    expect(err!.level).toBe('error');
    expect(err!.message).toMatch(/default_model/);
  });

  test('keys 为空报 warning', () => {
    const cfg = validateConfig({ ...base, keys: [] });
    const issues = checkConfig(cfg);
    const warn = issues.find((i) => i.target === 'keys');
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
  });

  test('providers 为空报 warning', () => {
    const cfg = validateConfig({ ...base, providers: {}, aliases: {} });
    const issues = checkConfig(cfg);
    const warn = issues.find((i) => i.target === 'providers');
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
  });

  test('aliases 为空报 warning', () => {
    const cfg = validateConfig({ ...base, aliases: {} });
    const issues = checkConfig(cfg);
    const warn = issues.find((i) => i.target === 'aliases');
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
  });

  test('多问题同时收集（不因首个错误而短路）', () => {
    const cfg = validateConfig({
      ...base,
      keys: [],
      providers: {},
      aliases: { fast: ['nope:m'], reason: ['deepseek:no-such'] },
      default_model: 'ghost',
    });
    const issues = checkConfig(cfg);
    const errors = issues.filter((i) => i.level === 'error');
    const warnings = issues.filter((i) => i.level === 'warning');
    expect(errors.length).toBeGreaterThanOrEqual(3); // 2 个 alias 引用错误 + 1 个 default_model 错误
    expect(warnings.length).toBeGreaterThanOrEqual(1); // keys/providers 为空告警
  });
});
