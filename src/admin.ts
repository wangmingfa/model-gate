import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config';
import { validateConfig } from './config';

/** 回环检查所需的 Bun server 形态（app.fetch(req, server) 时 c.env = server） */
export interface LoopbackEnv {
  requestIP?: (req: Request) => { address: string; family: string; port: number } | null;
}

/** 密钥掩码：保留前 3 后 3，如 sk-****abc；短密钥全掩 */
export function maskKey(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
}

function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, ''); // IPv4-mapped IPv6
  return a === '127.0.0.1' || a === '::1';
}

/** /admin/* 全局限流：仅本机回环可访问，与 host 配置无关；无 server env（测试/应用级请求）放行 */
async function loopbackGuard(c: Context, next: Next): Promise<Response | void> {
  const server = c.env as LoopbackEnv | undefined;
  if (server?.requestIP) {
    const ip = server.requestIP(c.req.raw);
    if (!ip || !isLoopbackAddress(ip.address)) {
      return c.json(
        { error: { message: '管理界面仅允许本机回环访问', type: 'forbidden', code: 'loopback_only' } },
        403,
      );
    }
  }
  return next();
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

/** PUT 时解析 keys 数组：掩码条目按顺序还原为原始值，新增条目原样保留 */
function resolveKeys(draftKeys: unknown, current: Config, raw: Record<string, unknown> | null): unknown {
  if (!Array.isArray(draftKeys)) return draftKeys;
  const rawKeys = Array.isArray(raw?.keys) ? (raw.keys as unknown[]) : [];
  return draftKeys.map((k) => {
    if (typeof k !== 'string') return k;
    const idx = current.keys.findIndex((cur) => maskKey(cur) === k);
    if (idx >= 0) return rawKeys[idx] ?? current.keys[idx];
    return k;
  });
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path); // POSIX 原子替换，热加载轮询随之感知 mtime 变化
}

async function serveSpa(c: Context, dist: string, rel: string): Promise<Response> {
  const safe = rel
    .split('/')
    .filter((s) => s && s !== '..')
    .join('/');
  const filePath = safe ? resolve(dist, safe) : resolve(dist, 'index.html');
  if (!filePath.startsWith(`${dist}/`)) return c.text('forbidden', 403);
  let f = Bun.file(filePath);
  if (await f.exists()) return new Response(f);
  // SPA fallback
  f = Bun.file(resolve(dist, 'index.html'));
  if (await f.exists()) return new Response(f, { headers: { 'content-type': 'text/html' } });
  return c.text('admin UI 未构建：先运行 bun run build:admin', 404);
}

/** 构建管理界面应用（挂载到 /admin 下） */
export function createAdminApp(getConfig: () => Config, configPath: string | undefined): Hono {
  const admin = new Hono();
  admin.use('*', loopbackGuard);

  // 返回掩码后的完整配置（前端编辑底稿）
  admin.get('/api/config', (c) => {
    const cfg = getConfig();
    return c.json({
      ...cfg,
      keys: cfg.keys.map(maskKey),
      providers: Object.fromEntries(
        Object.entries(cfg.providers).map(([name, p]) => [name, { ...p, api_key: maskKey(p.api_key) }]),
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
    const configForWrite: Config = { ...validated, providers: providersForWrite as Config['providers'] };
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

  // 测试连接：用后端持有的真实 key 发 1-token 请求
  admin.post('/api/test', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    const { provider, model } = (body ?? {}) as { provider?: string; model?: string };
    const cfg = getConfig();
    const p = provider ? cfg.providers[provider] : undefined;
    if (!p) return c.json({ error: { message: `未知 provider: ${provider ?? ''}`, type: 'invalid_request_error' } }, 400);
    if (typeof model !== 'string' || !p.models.includes(model)) {
      return c.json({ error: { message: `provider ${provider} 没有模型 ${model ?? ''}`, type: 'invalid_request_error' } }, 400);
    }
    const start = Date.now();
    try {
      const res = await fetch(`${p.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.api_key}` },
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

  // 静态托管 admin/dist + SPA fallback
  const DIST = resolve(import.meta.dir, '../admin/dist');
  admin.get('/', async (c) => serveSpa(c, DIST, ''));
  admin.get('/*', async (c) => {
    const rel = c.req.path.replace(/^\/admin\//, '');
    if (rel.startsWith('api/')) {
      return c.json({ error: { message: '接口不存在', type: 'invalid_request_error' } }, 404);
    }
    return serveSpa(c, DIST, rel);
  });

  return admin;
}
