import { describe, expect, test } from 'bun:test';
import type { Config } from './config';
import { chatWithFailover, extractErrorMessage, wrapSSEStream, UpstreamError } from './providers';

const cfg: Config = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: true,
  keys: ['sk-a'],
  providers: {
    deepseek: { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds', models: ['deepseek-chat'] },
    kimi: { base_url: 'https://api.moonshot.cn/v1', api_key: 'sk-kimi', models: ['moonshot-v1-8k'] },
  },
  aliases: {
    fast: ['deepseek:deepseek-chat', 'kimi:moonshot-v1-8k'],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('chatWithFailover', () => {
  test('成功转发：model 改写成别名、usage 被捕获', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(url);
      expect(JSON.parse(String(init.body)).model).toBe('deepseek-chat');
      return jsonResponse({
        id: 'x',
        object: 'chat.completion',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    };
    const r = await chatWithFailover(cfg, 'fast', { model: 'fast', messages: [] }, fetchImpl as typeof fetch);
    expect(r.realModel).toBe('deepseek:deepseek-chat');
    expect(r.usageBox.usage?.total_tokens).toBe(7);
    expect(calls.length).toBe(1);
    const j = await r.res.json();
    expect(j.model).toBe('fast');
  });

  test('第一个失败（网络错误）自动切第二个', async () => {
    let call = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      call++;
      if (call === 1) throw new Error('connection refused');
      return jsonResponse({ id: 'y', object: 'chat.completion', model: 'moonshot-v1-8k', choices: [] });
    };
    const r = await chatWithFailover(cfg, 'fast', { messages: [] }, fetchImpl as typeof fetch);
    expect(r.realModel).toBe('kimi:moonshot-v1-8k');
    expect(r.errors.length).toBe(1);
    expect(call).toBe(2);
  });

  test('4xx 也参与 failover', async () => {
    let call = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      call++;
      if (call === 1) return jsonResponse({ error: { message: 'context length exceeded' } }, 400);
      return jsonResponse({ id: 'z', object: 'chat.completion', model: 'moonshot-v1-8k', choices: [] });
    };
    const r = await chatWithFailover(cfg, 'fast', { messages: [] }, fetchImpl as typeof fetch);
    expect(r.realModel).toBe('kimi:moonshot-v1-8k');
  });

  test('全部失败：返回聚合错误，最后一个 4xx 沿用其状态码', async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      const status = url.includes('deepseek') ? 429 : 400;
      return jsonResponse({ error: { message: 'rate limited' } }, status);
    };
    const r = await chatWithFailover(cfg, 'fast', { messages: [] }, fetchImpl as typeof fetch);
    expect(r.res.status).toBe(400); // 最后一个（kimi）是 400
    const j = await r.res.json();
    expect(j.error.code).toBe('upstream_failed');
    expect(j.error.message).toContain('deepseek:deepseek-chat');
    expect(j.error.message).toContain('kimi:moonshot-v1-8k');
    expect(r.errors.length).toBe(2);
  });

  test('全部网络失败：502', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('boom');
    };
    const r = await chatWithFailover(cfg, 'fast', { messages: [] }, fetchImpl as typeof fetch);
    expect(r.res.status).toBe(502);
  });

  test('流式：转发 SSE 并改写 model、捕获 usage', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"s1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"id":"s1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"id":"s1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const fetchImpl = async (): Promise<Response> => new Response(body, { status: 200 });
    const r = await chatWithFailover(cfg, 'fast', { stream: true, messages: [] }, fetchImpl as typeof fetch);
    expect(r.realModel).toBe('deepseek:deepseek-chat');
    const text = await r.res.text(); // 消费完流后 usageBox 才被填充
    expect(text).not.toContain('"model":"deepseek-chat"');
    expect(text).toContain('"model":"fast"');
    expect(text).toContain('data: [DONE]');
    expect(r.usageBox.usage?.total_tokens).toBe(5);
  });
});

describe('extractErrorMessage', () => {
  test('OpenAI 风格错误体', () => {
    expect(extractErrorMessage('{"error":{"message":"m1","type":"t"}}')).toBe('m1');
  });
  test('纯文本', () => {
    expect(extractErrorMessage('bad gateway')).toBe('bad gateway');
  });
});

describe('wrapSSEStream', () => {
  test('空闲超时断开下游', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"model":"m"}\n\n'));
        // 之后不再推数据，触发空闲超时
      },
    });
    const { stream, usageBox } = wrapSSEStream(body, 'alias', 800);
    const reader = stream.getReader();
    let text = '';
    let errored = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      errored = true; // 空闲超时以 error 方式关闭下游流，属预期
    }
    expect(text).toContain('"model":"alias"');
    expect(errored).toBe(true);
    expect(usageBox.usage).toBeNull();
  });
});
