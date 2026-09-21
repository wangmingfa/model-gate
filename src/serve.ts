// @hono/node-server 启动封装：统一把客户端来源地址以 requestIP 形式注入 env，
// 供 /admin 回环检查使用（Bun.serve 时代由 server.requestIP 提供，Node 下从
// IncomingMessage.socket 读取）。
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

/** 结构化描述 Hono app（env 用 any 以绕开 Hono 泛型 Env/Schema 的参数逆变限制） */
interface FetchLikeApp {
  fetch: (req: Request, env?: any, executionCtx?: any) => Response | Promise<Response>;
}

export function serveApp(
  app: FetchLikeApp,
  opts: { hostname?: string; port?: number },
): ServerType {
  return serve({
    hostname: opts.hostname,
    port: opts.port,
    fetch: (req, env) => {
      const sock = env.incoming.socket;
      return app.fetch(req, {
        requestIP: () => {
          const address = sock.remoteAddress;
          if (!address) return null;
          return {
            address,
            family: sock.remoteFamily ?? 'IPv4',
            port: sock.remotePort ?? 0,
          };
        },
      });
    },
  });
}

/** 优雅停服：关闭监听并断开 keep-alive 空闲连接，避免端口残留占用。
 *  forceExitAfterMs：可选，超时未关完（长连接不肯退）则强制退出整个进程——仅 CLI 关停时传；
 *  在脚本里停掉某个 server 后还要继续执行时不要传，否则会误杀整个脚本。 */
export function stopServer(
  server: ServerType,
  opts: { onClosed?: () => void; forceExitAfterMs?: number } = {},
): void {
  server.close(() => opts.onClosed?.());
  (server as Server).closeAllConnections();
  if (opts.forceExitAfterMs !== undefined) {
    setTimeout(() => process.exit(0), opts.forceExitAfterMs).unref();
  }
}
