// 端到端冒烟测试：真实起 mock 上游 + 网关，走真实 HTTP 验证各端点与 failover、热加载。
// 用法: bun scripts/smoke.ts   （需先有 config.json，且未被占用 8787/9999 端口）
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { createApp } from '../src/app';

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const encoder = new TextEncoder();
function sseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"id":"m","object":"chat.completion.chunk","model":"mock-model","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
      c.enqueue(encoder.encode('data: {"id":"m","object":"chat.completion.chunk","model":"mock-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'));
      c.enqueue(encoder.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

// —— 1. 起 mock 上游（OpenAI 兼容 /v1/chat/completions）——
let failMode = false; // 置位后 mock 对一切请求返回 503，用于实测 failover
const mock = Bun.serve({
  port: 9999,
  async fetch(req) {
    if (failMode) {
      return Response.json({ error: { message: 'mock 进入故障模式' } }, { status: 503 });
    }
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await req.json();
      if (body.stream === true) {
        return new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'm',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 });
  },
});

// —— 2. 起网关（config.json 复制到临时文件供 admin 保存用，避免污染仓库里的真实配置）——
const cfg = loadConfig('config.json');
const ADMIN_CFG = '/tmp/mg-smoke-admin.json';
writeFileSync(ADMIN_CFG, readFileSync('config.json', 'utf-8'));
const app = createApp(() => cfg, { configPath: ADMIN_CFG });
const gate = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch });
const BASE = `http://127.0.0.1:${cfg.port}`;
const AUTH = { authorization: `Bearer ${cfg.keys[0]}` };
await sleep(300);

// —— 3. 各端点 ——
let r = await fetch(`${BASE}/health`);
check('GET /health → 200', r.status === 200);

r = await fetch(`${BASE}/v1/models`);
check('GET /v1/models 无鉴权 → 401', r.status === 401);
r = await fetch(`${BASE}/v1/models`, { headers: AUTH });
const models = await r.json();
check('GET /v1/models 鉴权 → 200 且含别名 fast', r.status === 200 && models.data.some((m: { id: string }) => m.id === 'fast'));

r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }),
});
const j = await r.json();
check('chat 非流式 → 200', r.status === 200);
check('非流式响应 model 改写为别名 fast', j.model === 'fast');
check('usage 透传 total_tokens=5', j.usage?.total_tokens === 5);

r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'fast', messages: [], stream: true }),
});
const sse = await r.text();
check('chat 流式 → 200 + text/event-stream', r.status === 200 && r.headers.get('content-type')?.includes('text/event-stream'));
check('流式 chunk model 改写为别名', sse.includes('"model":"fast"') && !sse.includes('"model":"mock-model"'));
check('流式以 data: [DONE] 结束', sse.includes('data: [DONE]'));

r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'ghost', messages: [] }),
});
check('未知模型 → 400 model_not_found', r.status === 400 && (await r.json()).error.code === 'model_not_found');

r = await fetch(`${BASE}/v1/embeddings`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: '{}',
});
check('未实现端点 /v1/embeddings → 501', r.status === 501);

// —— 3.5 admin API（本机回环访问；Bun.serve 会把 server 作为 env 传入，回环守卫生效）——
const expectKey = cfg.providers.mock.api_key;

r = await fetch(`${BASE}/admin/api/config`);
const acfg = (await r.json()) as { providers: Record<string, { api_key: string }>; keys: string[] };
check('admin GET /api/config → 200 且密钥已掩码', r.status === 200 && acfg.providers?.mock?.api_key?.includes('****'));

// 非回环来源必须 403（admin 安全边界，依赖 env.requestIP 接线）
const remote403 = await app.request(
  '/admin/api/config',
  {},
  { requestIP: () => ({ address: '192.168.1.10', family: 'IPv4', port: 1 }) },
);
check('admin 非回环来源 → 403', remote403.status === 403);

r = await fetch(`${BASE}/admin/api/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'mock', model: 'mock-model' }),
});
const t = (await r.json()) as { ok: boolean; ms?: number };
check('admin 测试连接（mock 在线）→ ok:true', t.ok === true && typeof t.ms === 'number');

r = await fetch(`${BASE}/admin/api/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  // 把掩码后的配置原样写回，后端应还原真实密钥
  body: JSON.stringify(acfg),
});
const saved = await r.json();
check('admin PUT 保存（掩码回写）→ 200', r.status === 200 && (saved as { ok?: boolean }).ok === true);
// 断言写回的是临时文件（仓库 config.json 未被触碰），且全配置 round-trip 一致、字段不丢
const written = loadConfig(ADMIN_CFG);
check(
  '掩码回写后密钥还原 + 全配置 round-trip 一致',
  written.providers.mock.api_key === expectKey &&
    written.port === cfg.port &&
    written.host === cfg.host &&
    written.timeout_seconds === cfg.timeout_seconds &&
    JSON.stringify(written.keys) === JSON.stringify(cfg.keys) &&
    JSON.stringify(written.aliases) === JSON.stringify(cfg.aliases),
);

r = await fetch(`${BASE}/admin/api/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...acfg, aliases: { fast: ['ghost:model'] } }),
});
check('admin PUT 非法配置 → 400 且不写文件', r.status === 400);
check('非法保存后配置未被破坏', loadConfig(ADMIN_CFG).providers.mock.api_key === expectKey);

// —— 4. failover：mock 进入故障模式后请求应 502 聚合错误 ——
failMode = true;
await sleep(200);
r = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'fast', messages: [] }),
});
const fj = await r.json();
check('全部上游失败 → 502 upstream_failed（聚合错误）', r.status === 502 && fj.error?.code === 'upstream_failed');
await gate.stop();

// —— 5. 热加载：用 index.ts 子进程 + 临时配置实测轮询重载 ——
const tmpCfgPath = '/tmp/mg-smoke-reload.json';
const baseCfg = JSON.parse(readFileSync('config.json', 'utf-8')) as Record<string, unknown>;
writeFileSync(tmpCfgPath, JSON.stringify({ ...baseCfg, port: 8788, aliases: { fast: ['mock:mock-model'] } }));
const proc = Bun.spawn(['bun', 'src/index.ts', '-c', tmpCfg], { stdout: 'pipe', stderr: 'pipe' });
await sleep(1200);
let r2 = await fetch('http://127.0.0.1:8788/v1/models', { headers: AUTH });
const before = await r2.json();
writeFileSync(
  tmpCfgPath,
  JSON.stringify({ ...baseCfg, port: 8788, aliases: { fast: ['mock:mock-model'], extra: ['mock:mock-model'] } }),
);
await sleep(1800); // 轮询间隔 1s + 余量
r2 = await fetch('http://127.0.0.1:8788/v1/models', { headers: AUTH });
const after = await r2.json();
const has = (m: { id: string }[]) => m.map((x) => x.id);
check(
  '热加载: 新增别名 extra 生效（无需重启）',
  !has(before.data).includes('extra') && has(after.data).includes('extra'),
  `before=${has(before.data).join(',')} after=${has(after.data).join(',')}`,
);
proc.kill();
const gateLog = await new Response(proc.stdout).text();
if (gateLog) console.log('--- index.ts 子进程日志 ---\n' + gateLog.trim());

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
