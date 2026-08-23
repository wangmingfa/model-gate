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
  keys: [
    { name: 'agent-one', key: 'sk-agent-one', created_at: '2026-01-01T00:00:00.000Z' },
    { name: 'agent-two', key: 'sk-agent-two', created_at: '2026-01-02T00:00:00.000Z' },
  ],
  admin_password: '',
  providers: {
    deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-real-deepseek-key', api_key_raw: 'sk-real-deepseek-key', models: ['deepseek-chat'] },
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

  test('非回环未登录访问受保护端点 → 401 auth_required', async () => {
    writeConfig(base);
    const res = await adminReq('/api/config', {}, remoteEnv);
    expect(res.status).toBe(401);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('auth_required');
  });

  test('非回环访问公开端点（auth-status）放行', async () => {
    writeConfig(base);
    const res = await adminReq('/api/auth-status', {}, remoteEnv);
    expect(res.status).toBe(200);
  });

  test('无 env（应用级请求/测试）放行', async () => {
    writeConfig(base);
    const res = await app.request('/admin/api/config');
    expect(res.status).toBe(200);
  });
});

describe('Web UI 密码登录', () => {
  const remoteIp = (n: number) => ({ requestIP: () => ({ address: `192.168.1.${n}`, family: 'IPv4', port: 1 }) });

  test('未配密码：auth-status 提示去配置文件，configPath 指向实际文件', async () => {
    writeConfig({ ...base, admin_password: '' });
    const res = await adminReq('/api/auth-status', {}, remoteIp(1));
    const j = (await res.json()) as Record<string, any>;
    expect(j.passwordConfigured).toBe(false);
    expect(j.configPath).toBe(tmpPath);
    expect(j.loggedIn).toBe(false);
  });

  test('未配密码时登录 → 400 no_admin_password', async () => {
    writeConfig({ ...base, admin_password: '' });
    const res = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'x' }) }, remoteIp(2));
    expect(res.status).toBe(400);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('no_admin_password');
  });

  test('登录成功：正确密码 → 200 + set-cookie，携带 cookie 可访问受保护端点', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    const res = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(3));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mg_admin_session=');
    const cookie = setCookie.split(';')[0];
    const cfgRes = await adminReq('/api/config', { headers: { cookie } }, remoteIp(3));
    expect(cfgRes.status).toBe(200);
  });

  test('登录失败：错误密码 → 401 invalid_password', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    const res = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) }, remoteIp(4));
    expect(res.status).toBe(401);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('invalid_password');
  });

  test('登录限流：连续 5 次失败后锁定 → 429 login_locked', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    for (let i = 0; i < 5; i++) {
      const res = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) }, remoteIp(5));
      expect(res.status).toBe(401);
    }
    // 第 6 次即使密码正确也被锁
    const res = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(5));
    expect(res.status).toBe(429);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('login_locked');
  });

  test('登出：清 cookie 后无凭证访问受保护端点 → 401（无状态，后端不记录）', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    const loginRes = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(6));
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    const logoutRes = await adminReq('/api/logout', { method: 'POST', headers: { cookie } }, remoteIp(6));
    expect(logoutRes.status).toBe(200);
    // 登出后浏览器不再携带 cookie，受保护端点要求重新登录
    const cfgRes = await adminReq('/api/config', {}, remoteIp(6));
    expect(cfgRes.status).toBe(401);
  });

  test('签名 cookie：篡改签名 → 401（防伪造）', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    const loginRes = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(8));
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    const tampered = `${cookie.slice(0, -2)}xx`; // 改签名末两位
    const cfgRes = await adminReq('/api/config', { headers: { cookie: tampered } }, remoteIp(8));
    expect(cfgRes.status).toBe(401);
  });

  test('签名 cookie：用不同密码签发的 token 在本机不通过（轮换密码即失效）', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    const loginRes = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(9));
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    // 改密码后（模拟密码轮换/重启后配置变更），旧 cookie 应失效
    writeConfig({ ...base, admin_password: 'new-secret' });
    const cfgRes = await adminReq('/api/config', { headers: { cookie } }, remoteIp(9));
    expect(cfgRes.status).toBe(401);
  });

  test('PUT 保存后 admin_password 保留（不被空串覆盖）', async () => {
    writeConfig({ ...base, admin_password: 'secret' });
    // 非回环访问受保护端点需先登录
    const loginRes = await adminReq('/api/login', { method: 'POST', body: JSON.stringify({ password: 'secret' }) }, remoteIp(7));
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
    const draft = { ...base, default_model: 'fast' };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft), headers: { cookie } }, remoteIp(7));
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.admin_password).toBe('secret');
  });
});

describe('GET /admin/api/config', () => {
  test('返回完整配置：keys 为原始值（前端负责掩码显示），provider 密钥为真实值（前端 password 框遮挡）', async () => {
    writeConfig(base);
    const res = await adminReq('/api/config');
    const j = (await res.json()) as Record<string, any>;
    expect(j.providers.deepseek.api_key).toBe('sk-real-deepseek-key');
    expect(j.keys).toEqual([
      { name: 'agent-one', key: 'sk-agent-one', created_at: '2026-01-01T00:00:00.000Z' },
      { name: 'agent-two', key: 'sk-agent-two', created_at: '2026-01-02T00:00:00.000Z' },
    ]);
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

  test('api_key 用 ${ENV} 引用时，前端原样回写引用，保存后文件仍保留引用而不落明文', async () => {
    process.env.MG_ADMIN_TEST_KEY = 'sk-env-secret-123';
    const envCfg = {
      ...base,
      providers: {
        deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-env-secret-123', api_key_raw: '${MG_ADMIN_TEST_KEY}', models: ['deepseek-chat'] },
      },
    };
    writeConfig(envCfg);
    // GET 返回 api_key_raw（即 ${VAR} 引用本身），前端原样回写（掩码只在前端显示，不进请求体）
    const draft = { ...envCfg, providers: { deepseek: { ...envCfg.providers.deepseek } } };
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
    // 结构性错误（port 非法）才会在 validateConfig 阶段被拒绝；
    // 引用完整性（如 alias 引用不存在的 provider）已移至 checkConfig，不再阻止保存
    const bad = { ...base, port: 99999 };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(bad) });
    expect(res.status).toBe(400);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error).toBeDefined();
    // 文件保持原样
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.aliases.fast).toEqual(['deepseek:deepseek-chat']);
  });

  test('api_key 留空 = 保持原值（保留磁盘上的 ${VAR} 引用或明文）', async () => {
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

  test('api_key 原样回写（含 ${VAR} 引用或明文，掩码只在前端做）', async () => {
    writeConfig(base);
    const draft = {
      ...base,
      providers: { deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-brand-new-key', models: ['deepseek-chat'] } },
    };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.providers.deepseek.api_key).toBe('sk-brand-new-key');
  });

  test('keys 原样保存（前端回传完整 key，新增条目生效）', async () => {
    writeConfig(base);
    const draft = {
      ...base,
      keys: [
        { name: 'agent-one', key: 'sk-agent-one', created_at: '2026-01-01T00:00:00.000Z' },
        { name: 'new-key', key: 'sk-new-key', created_at: '2026-02-01T00:00:00.000Z' },
      ],
    };
    const res = await adminReq('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    expect(res.status).toBe(200);
    const onDisk = loadConfig(tmpPath);
    expect(onDisk.keys).toEqual([
      { name: 'agent-one', key: 'sk-agent-one', created_at: '2026-01-01T00:00:00.000Z' },
      { name: 'new-key', key: 'sk-new-key', created_at: '2026-02-01T00:00:00.000Z' },
    ]);
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

describe('dev 模式（includeAdminStatic: false）', () => {
  // 开发模式 app：托管 API，不托管 SPA 静态页（页面由 Vite 5173 提供）
  const devApp = createApp(() => loadConfig(tmpPath), { configPath: tmpPath, includeAdminStatic: false });

  async function devReq(path: string, init: RequestInit = {}, env: unknown = loopbackEnv): Promise<Response> {
    return await devApp.request(
      path.startsWith('/') ? path : `/admin${path}`,
      { ...init, headers: { 'content-type': 'application/json', ...init.headers } },
      env as never,
    );
  }

  test('API 路由仍正常（auth-status）', async () => {
    writeConfig(base);
    const res = await devReq('/admin/api/auth-status');
    expect(res.status).toBe(200);
  });

  test('不托管 SPA 静态页：/admin 返回 404 而非 HTML 200', async () => {
    writeConfig(base);
    const res = await devReq('/admin');
    expect(res.status).toBe(404);
  });

  test('不托管静态资源：/admin/assets 返回 404', async () => {
    writeConfig(base);
    const res = await devReq('/admin/assets/index.js');
    expect(res.status).toBe(404);
  });

  test('生产模式（默认）仍托管 SPA 静态页：/admin 返回 HTML 200', async () => {
    writeConfig(base);
    const res = await app.request('/admin', {}, loopbackEnv as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
  });
});
