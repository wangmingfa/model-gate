import { describe, expect, test, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import type { Config } from './config';
import { validateConfig, loadConfig } from './config';
import { createApp } from './app';

const tmpPath = `/tmp/mg-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

const base: Config = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: false,
  keys: ['sk-agent-one', 'sk-agent-two'],
  providers: {
    deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-real-deepseek-key', models: ['deepseek-chat'] },
  },
  aliases: { fast: ['deepseek:deepseek-chat'] },
};

function writeConfig(cfg: Config): void {
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
}

const loopbackEnv = { requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 12345 }) };
const remoteEnv = { requestIP: () => ({ address: '192.168.1.10', family: 'IPv4', port: 12345 }) };

const app = createApp(() => loadConfig(tmpPath), { configPath: tmpPath });

async function adminReq(path: string, init: RequestInit = {}, env: unknown = loopbackEnv): Promise<Response> {
  return await app.request(
    `/admin${path}`,
    { ...init, headers: { 'content-type': 'application/json', ...init.headers } },
    env as never,
  );
}

afterEach(() => {
  try {
    unlinkSync(tmpPath);
  } catch {
    // 已删
  }
});

describe('回环访问控制', () => {
  test('本机回环访问放行', async () => {
    writeConfig(base);
    const res = await adminReq('/api/config');
    expect(res.status).toBe(200);
  });

  test('非回环访问 403', async () => {
    writeConfig(base);
    const res = await adminReq('/api/config', {}, remoteEnv);
    expect(res.status).toBe(403);
  });

  test('无 env（应用级请求/测试）放行', async () => {
    writeConfig(base);
    const res = await app.request('/admin/api/config');
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/api/config', () => {
  test('返回掩码后的配置，密钥不泄露', async () => {
    writeConfig(base);
    const res = await adminReq('/api/config');
    const j = (await res.json()) as Record<string, any>;
    expect(j.providers.deepseek.api_key).toBe('sk-****key');
    expect(j.keys).toEqual(['sk-****one', 'sk-****two']);
    expect(j.keys).not.toContain('sk-agent-one');
  });
});

describe('PUT /admin/api/config', () => {
  test('合法配置保存成功并写回文件', async () => {
    writeConfig(base);
    const draft = { ...base, default_model: 'fast', providers: { ...base.providers } };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.default_model).toBe('fast');
  });

  test('api_key 用 ${ENV} 引用时，保存后文件仍保留引用而不落明文', async () => {
    process.env.MG_ADMIN_TEST_KEY = 'sk-env-secret-123';
    const envCfg = {
      ...base,
      providers: {
        deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: '${MG_ADMIN_TEST_KEY}', models: ['deepseek-chat'] },
      },
    };
    writeConfig(envCfg);
    // 前端看到的是掩码后的值（maskKey('sk-env-secret-123') = 'sk-****123'），原样回写
    const draft = { ...envCfg, providers: { deepseek: { ...envCfg.providers.deepseek, api_key: 'sk-****123' } } };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    // 关键断言：config.json 里必须仍是 ${VAR} 引用，绝不能是解析后的明文
    const text = readFileSync(tmpPath, 'utf-8');
    expect(text).toContain('${MG_ADMIN_TEST_KEY}');
    expect(text).not.toContain('sk-env-secret-123');
    // 且重启后仍能正常加载
    expect(loadConfig(tmpPath).providers.deepseek.api_key).toBe('sk-env-secret-123');
  });

  test('非法配置返回 400 且不写文件', async () => {
    writeConfig(base);
    const bad = { ...base, aliases: { fast: ['ghost:model'] } };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(bad) });
    expect(res.status).toBe(400);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error).toBeDefined();
    // 文件保持原样
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.aliases.fast).toEqual(['deepseek:deepseek-chat']);
  });

  test('api_key 留空 = 保持原值', async () => {
    writeConfig(base);
    const draft = {
      ...base,
      providers: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: '', models: ['deepseek-chat'] } },
    };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.providers.deepseek.api_key).toBe('sk-real-deepseek-key');
  });

  test('api_key 填掩码形式 = 保持原值', async () => {
    writeConfig(base);
    const draft = {
      ...base,
      providers: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-****key', models: ['deepseek-chat'] } },
    };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.providers.deepseek.api_key).toBe('sk-real-deepseek-key');
  });

  test('keys 中掩码形式的条目保持原值，新增条目生效', async () => {
    writeConfig(base);
    const draft = { ...base, keys: ['sk-****one', 'sk-new-key'] };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.keys).toEqual(['sk-agent-one', 'sk-new-key']);
  });
});

describe('POST /admin/api/test', () => {
  test('上游可用：ok=true + 耗时', async () => {
    writeConfig(base);
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'deepseek-chat', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    // @ts-expect-error 注入 mock fetch
    globalThis.fetch = fetchImpl;
    const res = await adminReq('/api/test', { method: 'POST', body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }) });
    const j = (await res.json()) as Record<string, any>;
    expect(j.ok).toBe(true);
    expect(typeof j.ms).toBe('number');
  });

  test('上游不可用：ok=false + 错误信息', async () => {
    writeConfig(base);
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
    // @ts-expect-error 注入 mock fetch
    globalThis.fetch = fetchImpl;
    const res = await adminReq('/api/test', { method: 'POST', body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }) });
    const j = (await res.json()) as Record<string, any>;
    expect(j.ok).toBe(false);
    expect(j.status).toBe(401);
  });

  test('未知 provider 返回 400', async () => {
    writeConfig(base);
    const res = await adminReq('/api/test', { method: 'POST', body: JSON.stringify({ provider: 'nope', model: 'm' }) });
    expect(res.status).toBe(400);
  });
});
