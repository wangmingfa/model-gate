import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import { validateConfig, checkConfig } from './config';
import { adminAssets } from './admin-assets.generated';
import { getAccessLogPath } from './logger';

/** 回环检查所需的 Bun server 形态（app.fetch(req, server) 时 c.env = server） */
export interface LoopbackEnv {
  requestIP?: (req: Request) => { address: string; family: string; port: number } | null;
}

const SESSION_COOKIE = 'mg_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000; // 5 次失败锁 60s

/** 登录限流：ip -> { 失败次数, 锁定截止时间戳 } */
const loginFails = new Map<string, { fails: number; lockedUntil: number }>();

function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  return a === '127.0.0.1' || a === '::1';
}

/**
 * 签名 cookie（无状态登录）：
 * - token = base64url(payload) + "." + base64url(HMAC_SHA256(secret, payload))
 * - payload = { exp }（毫秒时间戳），密钥由 admin_password 派生，故轮换密码即令旧 token 失效
 * - 后端不存储任何会话：校验只看签名与 exp，重启不失效
 */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function sessionSecret(password: string): string {
  // 派生固定长度密钥：HMAC(admin_password, 固定上下文)。空密码不会走到这里（回环/未配置不校验）。
  return createHmac('sha256', 'mg-admin-session-v1').update(password).digest('hex');
}
function signSession(exp: number, password: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({ exp })));
  const sig = b64url(createHmac('sha256', sessionSecret(password)).update(payload).digest());
  return `${payload}.${sig}`;
}
/** 校验 token：格式/签名/exp 任一不对返回 null */
function verifySession(token: string | undefined, password: string): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', sessionSecret(password)).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(b64urlDecode(payload).toString('utf-8')) as { exp?: number };
    return typeof obj.exp === 'number' && obj.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 恒时密码比较（长度不同直接 false，本机工具够用） */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function clientIp(c: Context): string | null {
  const server = c.env as LoopbackEnv | undefined;
  return server?.requestIP ? (server.requestIP(c.req.raw)?.address ?? null) : null;
}

/**
 * /admin 鉴权守卫：
 * - 回环（或测试无 env）→ 放行（本机免登录）
 * - 非回环 + 公开端点（SPA 静态、auth-status/login/logout）→ 放行
 * - 非回环 + 其余端点 → 必须携带有效会话 cookie，否则 401 auth_required
 */
async function authGuard(getConfig: () => Config, c: Context, next: Next): Promise<Response | void> {
  const ip = clientIp(c);
  if (!ip || isLoopbackAddress(ip)) return next();

  const path = c.req.path; // 形如 /admin/api/config
  const isPublic =
    path === '/admin' ||
    path.startsWith('/admin/assets/') ||
    /^\/admin\/api\/(auth-status|login|logout)$/.test(path);
  if (isPublic) return next();

  const cfg = getConfig();
  const token = parseCookies(c.req.header('cookie') ?? '')[SESSION_COOKIE];
  if (verifySession(token, cfg.admin_password)) return next();
  return c.json(
    { error: { message: '需要登录', type: 'unauthorized', code: 'auth_required' } },
    401,
  );
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`;
}

/** 读取磁盘上原始配置（api_key 可能为 ${VAR} 引用），用于 PUT 时「留空保持原值」回退 */
function readRaw(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * PUT 时解析 provider 的 api_key（掩码只在前端做，后端不解析）：
 * - 留空 → 保持磁盘原始值（保留 ${VAR} 引用或已有明文，不误删）
 * - 其他（含 ${VAR} 引用、明文、新值）→ 原样保存
 * 注意：前端从 GET 拿到的是 api_key_raw，回写时也发 raw，因此 ${VAR} 引用不会被破坏。
 */
function resolveApiKey(draftVal: unknown, rawCur: unknown): unknown {
  if (draftVal === '' && typeof rawCur === 'string') return rawCur;
  return draftVal;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path); // POSIX 原子替换，热加载轮询随之感知 mtime 变化
}

/** 内容类型映射（静态托管用） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveSpa(c: Context, dist: string, rel: string): Promise<Response> {
  const safe = rel
    .split('/')
    .filter((s) => s && s !== '..')
    .join('/');
  const key = safe || 'index.html';
  // 优先读内嵌产物（单文件打包 bun xxx.js 时无磁盘 dist）
  const embedded = adminAssets[key];
  if (embedded !== undefined) {
    const ext = key.slice(key.lastIndexOf('.'));
    return new Response(embedded, { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } });
  }
  // 回退：磁盘 dist（开发/未重新生成内嵌时）
  const filePath = safe ? resolve(dist, safe) : resolve(dist, 'index.html');
  if (!filePath.startsWith(`${dist}/`)) return c.text('forbidden', 403);
  let f = Bun.file(filePath);
  if (await f.exists()) return new Response(f);
  // SPA fallback（内嵌与磁盘都试试 index.html）
  const fallback = adminAssets['index.html'];
  if (fallback !== undefined) return new Response(fallback, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  f = Bun.file(resolve(dist, 'index.html'));
  if (await f.exists()) return new Response(f, { headers: { 'content-type': 'text/html' } });
  return c.text('admin UI 未构建：先运行 bun run build:admin 或 bun run embed:admin', 404);
}

/**
 * 单次连通性探测：对 {baseUrl}/chat/completions 发 1-token 请求，返回耗时与成败。
 * 供「测试连接」（单 provider）与「一键测试所有提供商延迟」共用。
 */
async function pingOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<{ ok: boolean; ms: number; status?: number | null; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey ? `Bearer ${apiKey}` : '' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, ms, status: res.status, error: text.slice(0, 500) };
    }
    return { ok: true, ms };
  } catch (e) {
    const ms = Date.now() - start;
    const raw = (e as Error).message;
    let error: string;
    if (/timed out|timeout/i.test(raw)) {
      // AbortSignal.timeout 触发：等待超过阈值仍无响应
      error = `连接超时（等待超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`;
    } else if (/fetch failed|econnrefused|enotfound|econnreset|etimedout|network|getaddrinfo/i.test(raw)) {
      // 网络层不可达：地址错误 / DNS 解析失败 / 被拒绝
      error = `无法连接：${raw}`;
    } else {
      error = raw;
    }
    return { ok: false, ms, error };
  }
}

/** 构建管理界面应用（挂载到 /admin 下） */
export function createAdminApp(
  getConfig: () => Config,
  configPath: string | undefined,
  opts?: { includeStatic?: boolean },
): Hono {
  const admin = new Hono();
  admin.use('*', (c, next) => authGuard(getConfig, c, next));

  // 登录状态：未配密码时登录页提示去配置文件配置；登录后供前端三态渲染
  admin.get('/api/auth-status', (c) => {
    const cfg = getConfig();
    const token = parseCookies(c.req.header('cookie') ?? '')[SESSION_COOKIE];
    const loggedIn = verifySession(token, cfg.admin_password);
    return c.json({
      passwordConfigured: cfg.admin_password !== '',
      configPath: configPath ?? 'config.json',
      loggedIn,
    });
  });

  // 密码登录：成功签发内存会话 cookie（24h），失败 401；按来源 IP 限流（5 次失败锁 60s）
  admin.post('/api/login', async (c) => {
    const cfg = getConfig();
    if (!cfg.admin_password) {
      return c.json(
        { error: { message: '未配置 admin_password，请先在配置文件中设置', type: 'invalid_request_error', code: 'no_admin_password' } },
        400,
      );
    }
    const ip = clientIp(c);
    if (ip) {
      const rec = loginFails.get(ip);
      if (rec && rec.lockedUntil > Date.now()) {
        return c.json(
          { error: { message: '登录失败次数过多，请稍后再试', type: 'rate_limited', code: 'login_locked' } },
          429,
        );
      }
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    const { password } = (body ?? {}) as { password?: string };
    if (typeof password !== 'string' || !safeEqual(password, cfg.admin_password)) {
      if (ip) {
        const cur = loginFails.get(ip) ?? { fails: 0, lockedUntil: 0 };
        const fails = cur.fails + 1;
        loginFails.set(ip, { fails, lockedUntil: fails >= MAX_LOGIN_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 });
      }
      return c.json({ error: { message: '密码错误', type: 'unauthorized', code: 'invalid_password' } }, 401);
    }
    if (ip) loginFails.delete(ip); // 成功即清失败计数
    // 签发无状态签名 cookie：payload 仅含 exp，密钥派生自 admin_password，后端不存储
    const token = signSession(Date.now() + SESSION_TTL_MS, cfg.admin_password);
    return c.json(
      { ok: true },
      {
        status: 200,
        headers: {
          'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}`,
        },
      },
    );
  });

  // 登出：无状态，后端不记录；清 cookie 即可（旧 token 仍可校验，但浏览器不再携带）
  admin.post('/api/logout', (c) => {
    return c.json({ ok: true }, { status: 200, headers: { 'set-cookie': clearSessionCookie() } });
  });

  // 返回完整配置（前端编辑底稿；keys 返回完整值，前端负责掩码显示；
  // provider 的 api_key 返回「原始字符串」（可能为 ${VAR} 引用或明文），前端原样回写，
  // 掩码只在前端做，后端不参与。PUT 时前端原样回传即原样保存。）
  admin.get('/api/config', (c) => {
    const cfg = getConfig();
    const { admin_password, ...rest } = cfg; // admin_password 不进编辑范围
    return c.json({
      ...rest,
      keys: cfg.keys,
      providers: Object.fromEntries(
        Object.entries(cfg.providers).map(([name, p]) => [name, { ...p, api_key: p.api_key_raw }]),
      ),
    });
  });

  // 校验 + 原子写回 config.json（触发热加载）
  admin.put('/api/config', async (c) => {
    if (!configPath) {
      return c.json(
        { error: { message: '未配置 config 文件路径，无法保存', type: 'server_error', code: 'no_config_path' } },
        500,
      );
    }
    let draft: unknown;
    try {
      draft = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error', code: 'invalid_json' } }, 400);
    }
    if (typeof draft !== 'object' || draft === null) {
      return c.json({ error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error', code: 'invalid_json' } }, 400);
    }
    const d = draft as Record<string, unknown>;
    const raw = readRaw(configPath);

    // keys：掩码只在前端做，前端始终回传完整 key，后端原样保存（不再按掩码还原）
    // providers：api_key 留空 → 保持磁盘原始值（保留 ${VAR} 引用），否则原样保存
    if (typeof d.providers === 'object' && d.providers !== null) {
      const providers = { ...(d.providers as Record<string, unknown>) };
      for (const [name, p] of Object.entries(providers)) {
        if (typeof p === 'object' && p !== null) {
          const rawCur = (raw?.providers as Record<string, unknown> | undefined)?.[name] &&
            ((raw?.providers as Record<string, unknown>)[name] as Record<string, unknown>).api_key;
          providers[name] = {
            ...(p as Record<string, unknown>),
            api_key: resolveApiKey((p as Record<string, unknown>).api_key, rawCur),
          };
        }
      }
      d.providers = providers;
    }

    let validated: Config;
    try {
      validated = validateConfig(d);
    } catch (e) {
      return c.json(
        { error: { message: (e as Error).message, type: 'invalid_request_error', code: 'config_invalid' } },
        400,
      );
    }
    // validateConfig 会对 api_key 做 ${VAR} 插值（返回解析后的明文）；写回文件前把
    // providers 的 api_key 恢复为 draft 中 resolveApiKey 之后的原始形式，保留 ${VAR} 引用
    const providersForWrite: Record<string, unknown> = {};
    for (const name of Object.keys(validated.providers)) {
      const draftProvider = (d.providers as Record<string, unknown> | undefined)?.[name];
      const draftApiKey =
        typeof draftProvider === 'object' && draftProvider !== null
          ? (draftProvider as Record<string, unknown>).api_key
          : undefined;
      providersForWrite[name] =
        typeof draftApiKey === 'string' ? { ...validated.providers[name], api_key: draftApiKey } : validated.providers[name];
    }
    const configForWrite: Config = {
      ...validated,
      providers: providersForWrite as Config['providers'],
      // admin_password 不在编辑范围：写回时保留配置文件中的原始值（含 ${VAR} 引用），避免被空串覆盖
      admin_password: (typeof raw?.admin_password === 'string' ? raw.admin_password : validated.admin_password),
    };
    try {
      atomicWrite(configPath, `${JSON.stringify(configForWrite, null, 2)}\n`);
    } catch (e) {
      return c.json(
        { error: { message: `写入配置失败: ${(e as Error).message}`, type: 'server_error', code: 'write_failed' } },
        500,
      );
    }
    return c.json({ ok: true });
  });

  // 检查配置正确性：对当前运行中的配置做完整体检，汇总全部错误/告警（不修改配置）
  admin.post('/api/config/check', (c) => {
    const cfg = getConfig();
    const issues = checkConfig(cfg);
    return c.json({ ok: true, issues });
  });

  // 测试连接：用「前端草稿优先、服务端配置回退」的 base_url / api_key 发 1-token 请求。
  // 这样未保存的新增/修改也能先验证，不必先落盘；api_key 仅在本次请求使用，不持久化。
  admin.post('/api/test', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    const { provider, model, base_url: draftBaseUrl, api_key: draftApiKey } = (body ?? {}) as {
      provider?: string;
      model?: string;
      base_url?: string;
      api_key?: string;
    };
    if (typeof provider !== 'string' || !provider) {
      return c.json({ error: { message: 'provider 必填', type: 'invalid_request_error' } }, 400);
    }
    if (typeof model !== 'string' || !model) {
      return c.json({ error: { message: 'model 必填', type: 'invalid_request_error' } }, 400);
    }
    const cfg = getConfig();
    const saved = cfg.providers[provider];

    // base_url：前端草稿非空用草稿，否则回退服务端已保存值
    const baseUrl = (typeof draftBaseUrl === 'string' && draftBaseUrl.trim()) ? draftBaseUrl.trim() : saved?.base_url;
    if (!baseUrl) {
      return c.json(
        { error: { message: saved ? `provider ${provider} 未配置 base_url` : `未知 provider: ${provider}（未保存则需在表单中填写 base_url）`, type: 'invalid_request_error' } },
        400,
      );
    }

    // api_key：前端填了非空用前端草稿值（本次测试用，不持久化），否则回退服务端真实 key；
    // 空串/未填表示「保持原值」，必须用服务端已保存的 key，避免用空串去打上游
    const apiKey = (typeof draftApiKey === 'string' && draftApiKey.trim()) ? draftApiKey.trim() : saved?.api_key ?? '';

    const r = await pingOnce(baseUrl, apiKey, model, 15000);
    return c.json(r);
  });

  // 拉取上游模型列表：给定 provider 的 base_url / api_key（草稿优先、服务端回退），
  // GET {base_url}/models，解析 OpenAI 标准 {object:'list', data:[{id,...}]}，返回 id 数组。
  // 用于管理面板「一键把模型查出来回填」——避免手填模型 id。
  admin.post('/api/fetch-models', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    const { provider, base_url: draftBaseUrl, api_key: draftApiKey } = (body ?? {}) as {
      provider?: string;
      base_url?: string;
      api_key?: string;
    };
    if (typeof provider !== 'string' || !provider) {
      return c.json({ error: { message: 'provider 必填', type: 'invalid_request_error' } }, 400);
    }
    const cfg = getConfig();
    const saved = cfg.providers[provider];

    const baseUrl = (typeof draftBaseUrl === 'string' && draftBaseUrl.trim()) ? draftBaseUrl.trim() : saved?.base_url;
    if (!baseUrl) {
      return c.json(
        { error: { message: saved ? `provider ${provider} 未配置 base_url` : `未知 provider: ${provider}（未保存则需在表单中填写 base_url）`, type: 'invalid_request_error' } },
        400,
      );
    }
    const apiKey = (typeof draftApiKey === 'string' && draftApiKey.trim()) ? draftApiKey.trim() : saved?.api_key ?? '';

    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(15000),
      });
      const ms = Date.now() - start;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return c.json({ ok: false, status: res.status, error: text.slice(0, 500), ms });
      }
      const j = (await res.json().catch(() => null)) as { object?: string; data?: unknown[] } | null;
      const arr = j?.data;
      if (!Array.isArray(arr)) {
        return c.json({ ok: false, status: res.status, error: '上游 /models 响应缺少 data 数组（非 OpenAI 兼容格式）', ms });
      }
      // 兼容三种写法：{id}, {id:..}, 纯字符串
      const models = arr
        .map((m) => (typeof m === 'string' ? m : (m as Record<string, unknown>)?.id))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (models.length === 0) {
        return c.json({ ok: false, status: res.status, error: '上游 /models 未返回任何模型 id', ms });
      }
      return c.json({ ok: true, ms, models });
    } catch (e) {
      return c.json({ ok: false, status: null, error: (e as Error).message, ms: Date.now() - start });
    }
  });

  // 一键测试所有提供商的延迟：用各 provider 第一个模型发 1-token 探测，并发执行。
  // 返回每个 provider 的延迟与成败，供前端一键对比各上游响应速度。
  admin.post('/api/providers/latency', async (c) => {
    const cfg = getConfig();
    // 延迟探测单次超时封顶 60s（1 分钟）：足够识别慢/不可达的上游，
    // 又远低于服务器 idleTimeout（180s），并发整批不会触发服务端超时
    const timeoutMs = Math.min(
      (typeof cfg.timeout_seconds === 'number' && cfg.timeout_seconds > 0 ? cfg.timeout_seconds : 60) * 1000,
      60000,
    );
    // 用 allSettled 而非 all：即使个别 provider 探测意外抛错（理论上 pingOnce 已全 catch），
    // 也不会让整个接口 500，而是把该 provider 记为失败行，保证汇总结果始终完整
    const settled = await Promise.allSettled(
      Object.entries(cfg.providers).map(async ([name, p]) => {
        const model = p.models[0];
        if (!model) {
          return { provider: name, model: '', ok: false, error: '未配置模型' };
        }
        const r = await pingOnce(p.base_url, p.api_key, model, timeoutMs);
        return { provider: name, model, ...r };
      }),
    );
    const results = settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : { provider: '(未知)', model: '', ok: false, error: `探测异常：${String(s.reason)}` },
    );
    return c.json({ results });
  });

  // 用量统计：读取 access.log 聚合（仅统计 /v1/chat/completions 真实流量）
  interface Agg {
    req: number;
    fail: number;
    tokens: number;
    latencies: number[];
  }
  function bump(m: Map<string, Agg>, k: string, d: { req: number; fail: number; tokens: number; ms: number }): void {
    const cur = m.get(k) ?? { req: 0, fail: 0, tokens: 0, latencies: [] as number[] };
    cur.req += d.req;
    cur.fail += d.fail;
    cur.tokens += d.tokens;
    if (d.ms >= 0) cur.latencies.push(d.ms);
    m.set(k, cur);
  }
  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }

  admin.get('/api/stats', (c) => {
    const days = Number(c.req.query('days') ?? '30');
    const rangeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;
    const sinceMs = Date.now() - rangeDays * 24 * 60 * 60 * 1000;

    const path = getAccessLogPath();
    let lines: string[] = [];
    try {
      if (existsSync(path)) lines = readFileSync(path, 'utf-8').split('\n');
    } catch {
      lines = [];
    }

    // 聚合容器
    let totalReq = 0;
    let successReq = 0;
    let failReq = 0;
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalTokens = 0;
    const latencies: number[] = [];
    const byAlias = new Map<string, Agg>();
    const byKey = new Map<string, Agg>();
    const byDay = new Map<string, Agg>();

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // 只统计真实的 chat 流量（token 字段只在这里有意义）
      if (r.path !== '/v1/chat/completions') continue;
      const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;

      const status = Number(r.status ?? 0);
      const ms = Number(r.ms ?? 0);
      const isFail = status === 0 || status >= 400;
      totalReq++;
      if (isFail) failReq++;
      else successReq++;
      latencies.push(ms);

      const pt = Number(r.promptTokens ?? 0) || 0;
      const ct = Number(r.completionTokens ?? 0) || 0;
      const tt = Number(r.totalTokens ?? 0) || pt + ct;
      totalPrompt += pt;
      totalCompletion += ct;
      totalTokens += tt;

      const alias = (r.alias as string) || '(unknown)';
      const key = (r.key as string) || '(unknown)';
      const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD

      bump(byAlias, alias, { req: 1, fail: isFail ? 1 : 0, tokens: tt, ms });
      bump(byKey, key, { req: 1, fail: isFail ? 1 : 0, tokens: tt, ms });
      bump(byDay, day, { req: 1, fail: isFail ? 1 : 0, tokens: tt, ms });
    }

    // p95 延迟
    const p95 = percentile(latencies, 0.95);
    const toArr = (m: Map<string, Agg>) =>
      [...m.entries()]
        .map(([k, v]) => ({
          key: k,
          requests: v.req,
          failures: v.fail,
          successRate: v.req > 0 ? +((1 - v.fail / v.req) * 100).toFixed(2) : 100,
          tokens: v.tokens,
          p95Ms: percentile(v.latencies, 0.95),
        }))
        .sort((a, b) => b.requests - a.requests);

    return c.json({
      rangeDays,
      generatedAt: new Date().toISOString(),
      overview: {
        requests: totalReq,
        success: successReq,
        failures: failReq,
        successRate: totalReq > 0 ? +((1 - failReq / totalReq) * 100).toFixed(2) : 100,
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens,
        p95Ms: p95,
      },
      byAlias: toArr(byAlias),
      byKey: toArr(byKey),
      byDay: toArr(byDay).sort((a, b) => (a.key < b.key ? -1 : 1)),
    });
  });

  // 每个别名「最近一次成功请求」实际生效的模型（反映 failover 实际落点）
  admin.get('/api/alias-status', (c) => {
    const path = getAccessLogPath();
    let lines: string[] = [];
    try {
      if (existsSync(path)) lines = readFileSync(path, 'utf-8').split('\n');
    } catch {
      lines = [];
    }
    // access.log 按时间追加，后面的记录更新；每个别名只保留最近一次成功的 realModel
    const latest = new Map<string, { model: string; ts: string }>();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.path !== '/v1/chat/completions') continue;
      const status = Number(r.status ?? 0);
      if (status === 0 || status >= 400) continue; // 仅统计成功请求
      const alias = (r.alias as string) ?? '';
      const model = (r.realModel as string) ?? '';
      if (!alias || !model) continue;
      latest.set(alias, { model, ts: typeof r.ts === 'string' ? r.ts : '' });
    }
    return c.json({
      generatedAt: new Date().toISOString(),
      aliases: [...latest.entries()].map(([name, v]) => ({
        name,
        activeModel: v.model,
        lastSuccessTs: v.ts,
      })),
    });
  });

  // 静态托管 admin/dist + SPA fallback（开发模式由 Vite 5173 托管，可不注册）
  if (opts?.includeStatic !== false) {
    const DIST = resolve(import.meta.dir, '../admin/dist');
    admin.get('/', async (c) => serveSpa(c, DIST, ''));
    admin.get('/*', async (c) => {
      const rel = c.req.path.replace(/^\/admin\//, '');
      if (rel.startsWith('api/')) {
        return c.json({ error: { message: '接口不存在', type: 'invalid_request_error' } }, 404);
      }
      return serveSpa(c, DIST, rel);
    });
  }

  return admin;
}
