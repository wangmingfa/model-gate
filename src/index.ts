import { statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { loadConfig, ConfigError } from './config';
import type { Config } from './config';
import { createApp } from './app';
import { configureLogging } from './logger';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 本机所有非回环 IPv4 地址（用于 host=0.0.0.0 时提示可访问入口） */
function localIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

const configPath =
  argValue('--config') ?? argValue('-c') ?? process.env.MODEL_GATE_CONFIG ?? 'config.json';

let cfg: Config;
try {
  cfg = loadConfig(configPath);
} catch (e) {
  console.error(`[model-gate] ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  process.exit(1);
}
configureLogging(cfg.access_log);

// 配置热加载：每秒轮询 mtime，变化则重载并原子替换；校验失败则保留旧配置
let lastMtime = statSync(configPath).mtimeMs;
setInterval(() => {
  let mtime: number;
  try {
    mtime = statSync(configPath).mtimeMs;
  } catch {
    return; // 文件暂时不可读（编辑器的原子替换间隙），忽略
  }
  if (mtime === lastMtime) return;
  lastMtime = mtime;
  try {
    const next = loadConfig(configPath);
    cfg = next;
    configureLogging(next.access_log);
    console.log(`[model-gate] 配置已热加载: ${configPath}（默认模型=${next.default_model}，别名=${Object.keys(next.aliases).join(', ')}）`);
  } catch (e) {
    console.error(`[model-gate] 配置重载失败，保留当前配置: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  }
}, 1000);

const app = createApp(() => cfg, { configPath });

Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  // 把 Bun server 作为 env 传入，让 /admin 的回环检查能拿到 requestIP
  fetch: (req, server) => app.fetch(req, server),
});

if (cfg.host === '0.0.0.0') {
  console.log(`[model-gate] 已启动，监听所有网卡（端口 ${cfg.port}），可访问入口:`);
  console.log(`  http://127.0.0.1:${cfg.port}（本机）`);
  for (const ip of localIPv4Addresses()) {
    console.log(`  http://${ip}:${cfg.port}`);
  }
} else {
  console.log(`[model-gate] 已启动: http://${cfg.host}:${cfg.port}`);
}
console.log(`[model-gate] 配置: ${configPath} | 别名: ${Object.keys(cfg.aliases).join(', ')} | 默认模型: ${cfg.default_model}`);
