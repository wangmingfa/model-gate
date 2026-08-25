import { describe, expect, test, afterEach } from 'bun:test';
import type { Config } from './config';
import { createApp } from './app';

const cfg: Config = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: false,
  keys: [{ name: 'valid', key: 'sk-valid', created_at: '2026-01-01T00:00:00.000Z' }],
  admin_password: '',
  providers: {
    deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds', api_key_raw: 'sk-ds', models: ['deepseek-chat'] },
  },
  aliases: { fast: ['deepseek:deepseek-chat'] },
};

const app = createApp(() => cfg);

// 缓存真实全局 fetch，防止 afterEach 在没注入 mock 时把 globalThis.fetch 置为 undefined
const __origFetch = globalThis.fetch;

async function req(path: string, opts: RequestInit = {}): Promise<Response> {
  return await app.request(path, opts);
}

afterEach(() => {
  globalThis.fetch = __origFetch;
});

describe('auth', () => {
  test('afterEach 不破坏全局 fetch', async () => {
    // 模拟一次异步操作后 afterEach 清理
    await new Promise((r) => setTimeout(r, 10));
    expect(typeof globalThis.fetch).toBe('function');
  });

  test('无 key 的 /v1/* 请求返回 401', async () => {
    const res = await req('/v1/models');
    expect(res.status).toBe(401);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('invalid_api_key');
  });

  test('错误 key 返回 401', async () => {
    const res = await req('/v1/models', { headers: { authorization: 'Bearer sk-wrong' } });
    expect(res.status).toBe(401);
  });

  test('合法 key 放行', async () => {
    const res = await req('/v1/models', { headers: { authorization: 'Bearer sk-valid' } });
    expect(res.status).toBe(200);
  });

  test('/health 不需要鉴权', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('ok');
  });
});

describe('routes', () => {
  test('GET /v1/models 返回别名列表', async () => {
    const res = await req('/v1/models', { headers: { authorization: 'Bearer sk-valid' } });
    const j = (await res.json()) as Record<string, any>;
    expect(j.object).toBe('list');
    expect(j.data.map((m: { id: string }) => m.id)).toEqual(['fast']);
  });

  test('未知模型返回 400 并列出可用别名', async () => {
    const res = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-valid', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ghost', messages: [] }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as Record<string, any>;
    expect(j.error.code).toBe('model_not_found');
    expect(j.error.message).toContain('fast');
  });

  test('未指定 model 时使用默认别名', async () => {
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('deepseek-chat');
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'deepseek-chat', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    // @ts-expect-error 测试注入 mock fetch
    globalThis.fetch = fetchImpl;
    const res = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-valid', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  test('chat/completions 全链路：mock 上游，返回别名改写后的响应', async () => {
    // @ts-expect-error 测试注入 mock fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ id: 'x', object: 'chat.completion', model: 'deepseek-chat', choices: [], usage: { total_tokens: 3 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const res = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-valid', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', messages: [] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.model).toBe('fast');
    expect(j.usage.total_tokens).toBe(3);
  });

  test('未实现的端点返回 501', async () => {
    const res = await req('/v1/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-valid', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
  });

  test('非法 JSON 请求体返回 400', async () => {
    const res = await req('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-valid', 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});
