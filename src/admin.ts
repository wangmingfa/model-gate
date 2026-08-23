import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import { validateConfig, checkConfig } from './config';
import { adminAssets } from './admin-assets.generated';

/** 回环检查所需的 Bun server 形态（app.fetch(req, server) 时 c.env = server） */
export interface LoopbackEnv {
  requestIP?: (req: Request) => { address: string; family: string; port: number } | null;
}

const SESSION_COOKIE = 'mg_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 60 * 1000; // 5 次失败锁 60s

/** 会话：token -> 过期时间戳（内存态，重启失效） */
const sessions = new Map<string, number>();
/** 登录限流：ip -> { 失败次数, 锁定截止时间戳 } */
const loginFails = new Map<string, { fails: number; lockedUntil: number }>();

function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  return a === '127.0.0.1' || a === '::1';
}

/** 密钥掩码：保留前 3 后 3，如 sk-****abc；短密钥全掩 */
export function maskKey(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
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
async function authGuard(c: Context, next: Next): Promise<Response | void> {
  const ip = clientIp(c);
  if (!ip || isLoopbackAddress(ip)) return next();

  const path = c.req.path; // 形如 /admin/api/config
  const isPublic =
    path === '/admin' ||
    path.startsWith('/admin/assets/') ||
    /^\/admin\/api\/(auth-status|login|logout)$/.test(path);
  if (isPublic) return next();

  const token = parseCookies(c.req.header('cookie') ?? '')[SESSION_COOKIE];
  if (token && (sessions.get(token) ?? 0) > Date.now()) return next();
  return c.json(
    { error: { message: '需要登录', type: 'unauthorized', code: 'auth_required' } },
    401,
  );
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`;
}

/** 读取磁盘上原始配置（api_key 可能仍是 ${VAR} 引用），用于 PUT 时保持原值 */
function readRaw(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * PUT 时解析 provider 的 api_key：
 * - 留空或等于当前掩码形式 → 保持原始值（保留 ${VAR} 引用）
 * - 否则当作新值
 */
function resolveApiKey(draftVal: unknown, resolvedCur: string | undefined, rawCur: unknown): unknown {
  if (typeof draftVal !== 'string') return draftVal;
  if (draftVal === '' && resolvedCur) return rawCur ?? resolvedCur;
  if (resolvedCur && maskKey(resolvedCur) === draftVal) return rawCur ?? resolvedCur;
  return draftVal;
}

/**
 * PUT 时解析 keys 数组（新结构 {name,key,created_at}[]）：
 * - 掩码条目（key 等于当前掩码形式）→ 按 name 还原为原始值（保留 raw 中的原始 key）
 * - 新增条目 → 原样保留（name + 完整 key + created_at）
 */
function resolveKeys(draftKeys: unknown, current: Config, raw: Record<string, unknown> | null): unknown {
  if (!Array.isArray(draftKeys)) return draftKeys;
  const rawKeys = Array.isArray(raw?.keys) ? (raw.keys as Record<string, unknown>[]) : [];
  return draftKeys.map((k) => {
    if (typeof k !== 'object' || k === null) return k;
    const item = k as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.key !== 'string') return item;
    const cur = current.keys.find((c) => c.name === item.name);
    if (cur && maskKey(cur.key) === item.key) {
      const rawKey = rawKeys.find((r) => r.name === item.name)?.key;
      return { ...item, key: typeof rawKey === 'string' ? rawKey : cur.key };
    }
    return item;
  });
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

/** 构建管理界面应用（挂载到 /admin 下） */
export function createAdminApp(
  getConfig: () => Config,
  configPath: string | undefined,
  opts?: { includeStatic?: boolean },
): Hono {
  const admin = new Hono();
  admin.use('*', authGuard);

  // 登录状态：未配密码时登录页提示去配置文件配置；登录后供前端三态渲染
  admin.get('/api/auth-status', (c) => {
    const cfg = getConfig();
    const token = parseCookies(c.req.header('cookie') ?? '')[SESSION_COOKIE];
    const loggedIn = !!token && (sessions.get(token) ?? 0) > Date.now();
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
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
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

  // 登出：销毁会话 + 清 cookie
  admin.post('/api/logout', (c) => {
    const token = parseCookies(c.req.header('cookie') ?? '')[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return c.json({ ok: true }, { status: 200, headers: { 'set-cookie': clearSessionCookie() } });
  });

  // 返回完整配置（前端编辑底稿；keys 返回原始值，前端负责掩码显示）
  admin.get('/api/config', (c) => {
    const cfg = getConfig();
    const { admin_password, ...rest } = cfg; // admin_password 不进编辑范围
    // 注意：api_key 返回真实值（前端为 password 输入框，明文不可见）；
    // 真实密钥会经网络传至浏览器，若在意泄露可改回 maskKey。PUT 时前端原样回传即原样保存。
    return c.json({
      ...rest,
      keys: cfg.keys,
      providers: Object.fromEntries(
        Object.entries(cfg.providers).map(([name, p]) => [name, { ...p, api_key: p.api_key }]),
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
    const current = getConfig();
    const raw = readRaw(configPath);

    if (Array.isArray(d.keys)) d.keys = resolveKeys(d.keys, current, raw);
    if (typeof d.providers === 'object' && d.providers !== null) {
      const providers = { ...(d.providers as Record<string, unknown>) };
      for (const [name, p] of Object.entries(providers)) {
        if (typeof p === 'object' && p !== null) {
          const cur = current.providers[name];
          providers[name] = {
            ...(p as Record<string, unknown>),
            api_key: resolveApiKey(
              (p as Record<string, unknown>).api_key,
              cur?.api_key,
              (raw?.providers as Record<string, unknown> | undefined)?.[name] &&
                ((raw?.providers as Record<string, unknown>)[name] as Record<string, unknown>).api_key,
            ),
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

    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(15000),
      });
      const ms = Date.now() - start;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return c.json({ ok: false, status: res.status, error: text.slice(0, 500), ms });
      }
      return c.json({ ok: true, ms });
    } catch (e) {
      return c.json({ ok: false, status: null, error: (e as Error).message, ms: Date.now() - start });
    }
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
