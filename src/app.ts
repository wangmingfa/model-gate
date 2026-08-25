import { Hono } from 'hono';
import type { Config } from './config';
import { chatWithFailover } from './providers';
import type { LogRecord } from './logger';
import { writeAccessLog, consoleSummary, setUsageBox, applyUsageBox } from './logger';
import { createAdminApp } from './admin';
import type { LoopbackEnv } from './admin';

type Vars = { access?: LogRecord };

/**
 * 构建应用。config 通过 getConfig 惰性读取，这样入口热加载换掉配置后，
 * 同一份 app 实例立即使用新配置。
 */
export function createApp(
  getConfig: () => Config,
  opts?: { configPath?: string; includeAdminStatic?: boolean },
): Hono<{ Variables: Vars; Bindings: LoopbackEnv }> {
  const app = new Hono<{ Variables: Vars; Bindings: LoopbackEnv }>();

  // 全量请求日志中间件（先注册，作为最外层）
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const rec: LogRecord = c.get('access') ?? {
      ts: '',
      method: c.req.method,
      path: c.req.path,
      status: 0,
      ms: 0,
    };
    const finish = () => {
      applyUsageBox(rec);
      rec.ts = new Date().toISOString();
      rec.status = c.res.status;
      rec.ms = Date.now() - start;
      writeAccessLog(rec);
      consoleSummary(rec);
    };
    if (rec.stream === true && c.res.body) {
      // 流式：等流结束后再写日志（此时 usageBox 已被 SSE 改写过程填好）
      const [client, probe] = c.res.body.tee();
      c.res = new Response(client, { status: c.res.status, headers: c.res.headers });
      void (async () => {
        const reader = probe.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // 客户端中断或上游空闲超时，仍要落日志
        }
        finish();
      })();
      // 流式路径：rec.status 暂为 0（等待流结束），避免 access.log 出现 "状态为 0" 的误报
      // 非流式路径已在 finish() 里写完 status，不触发这里
      return;
    } else {
      finish();
    }
  });

  // 下游鉴权：/v1/* 必须携带 keys 列表里的 Bearer key
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const cfg = getConfig();
    // 首跑尚未配置 keys：返回 503 引导去 /admin 配置，而非统一 401
    if (cfg.keys.length === 0) {
      return c.json(
        {
          error: {
            message: '网关尚未完成配置：请访问 /admin 添加至少一个下游密钥（keys）后再发起请求',
            type: 'service_unavailable',
            code: 'not_configured',
          },
        },
        503,
      );
    }
    if (!cfg.keys.some((k) => k.key === key)) {
      return c.json(
        {
          error: {
            message: '无效或缺失的 API key（Authorization: Bearer <key>）',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      );
    }
    c.set('access', {
      ts: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      status: 0,
      ms: 0,
      key,
    });
    await next();
  });

  // 健康检查（不鉴权，方便本机探活）
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // 列出可用模型（返回别名列表）
  app.get('/v1/models', (c) => {
    const data = Object.keys(getConfig().aliases).map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'model-gate',
    }));
    return c.json({ object: 'list', data });
  });

  // chat/completions：统一入口
  app.post('/v1/chat/completions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { message: '请求体必须是合法 JSON', type: 'invalid_request_error', code: 'invalid_json' } },
        400,
      );
    }
    if (typeof body !== 'object' || body === null) {
      return c.json(
        { error: { message: '请求体必须是 JSON 对象', type: 'invalid_request_error', code: 'invalid_json' } },
        400,
      );
    }
    const reqBody = body as Record<string, unknown>;
    const cfg = getConfig();

    // 模型名解析：未传则用默认别名
    const alias =
      typeof reqBody.model === 'string' && reqBody.model.length > 0 ? reqBody.model : cfg.default_model;
    if (!cfg.aliases[alias]) {
      return c.json(
        {
          error: {
            message: `未知模型 "${alias}"，可用别名: ${Object.keys(cfg.aliases).join(', ')}`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        400,
      );
    }

    const rec = c.get('access');
    if (rec) {
      rec.alias = alias;
      rec.stream = reqBody.stream === true;
    }

    const { res, realModel, usageBox } = await chatWithFailover(cfg, alias, reqBody);
    if (rec) {
      rec.realModel = realModel;
      setUsageBox(rec, usageBox);
    }
    return res;
  });

  // 其余 /v1/* 端点：暂未实现
  app.all('/v1/*', (c) =>
    c.json(
      { error: { message: '该端点尚未实现', type: 'invalid_request_error', code: 'not_implemented' } },
      501,
    ),
  );

  // favicon 兜底：浏览器在 /admin（无末尾斜杠）时把相对 logo.svg 解析成根路径
  // /logo.svg，Hono 又不会为此发 302（内部归一化到 /admin/ 但仍返回 200），
  // 故把根 /logo.svg 重定向到已能正常服务的 /admin/logo.svg，避免标签栏 favicon 404。
  app.get('/logo.svg', (c) => c.redirect('/admin/logo.svg'));

  // 管理界面（SPA + /admin/api/*），挂载在最后，避免被 /v1/* 的 501 catch-all 拦截
  app.route('/admin', createAdminApp(getConfig, opts?.configPath, { includeStatic: opts?.includeAdminStatic ?? true }));

  return app;
}
