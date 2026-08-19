import { statSync } from 'node:fs';
import { loadConfig, ConfigError } from './config';
import type { Config } from './config';
import { createApp } from './app';
import { configureLogging } from './logger';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
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

const app = createApp(() => cfg);

Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch: app.fetch,
});

console.log(`[model-gate] 已启动: http://${cfg.host}:${cfg.port}（配置: ${configPath}）`);
console.log(`[model-gate] 别名: ${Object.keys(cfg.aliases).join(', ')} | 默认模型: ${cfg.default_model}`);
