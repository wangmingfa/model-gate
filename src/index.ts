#!/usr/bin/env bun
import { statSync, existsSync, writeFileSync, readSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig, ConfigError } from './config';
import type { Config } from './config';
import { createApp } from './app';
import { configureLogging } from './logger';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 解析配置路径：相对路径基于 cwd，~ 展开为用户目录；返回绝对路径 */
function resolveConfigPath(raw: string): string {
  const expanded = raw.startsWith('~') ? homedir() + raw.slice(1) : raw;
  return resolve(expanded);
}

/** 生成一份示例配置文本（首次启动 / init 复用同一份） */
function buildSampleConfig(): string {
  const sample = {
    port: 8787,
    host: '127.0.0.1',
    default_model: 'fast',
    timeout_seconds: 60,
    access_log: true,
    keys: [
      { name: 'Claude', key: 'sk-local-claude', created_at: new Date().toISOString() },
      { name: 'Cursor', key: 'sk-local-cursor', created_at: new Date().toISOString() },
    ],
    admin_password: '',
    providers: {
      deepseek: {
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-your-deepseek-key-here',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      kimi: {
        base_url: 'https://api.moonshot.cn/v1',
        api_key: 'sk-your-kimi-key-here',
        models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
      },
    },
    aliases: {
      fast: ['deepseek:deepseek-chat', 'kimi:moonshot-v1-8k'],
      reason: ['deepseek:deepseek-reasoner'],
    },
  };
  return JSON.stringify(sample, null, 2) + '\n';
}

/** 把示例配置写入 path；失败抛错由调用方处理 */
function writeSampleConfig(path: string): void {
  writeFileSync(path, buildSampleConfig(), 'utf-8');
}

/** 读取一行 stdin（用于 init 的覆盖确认）；非 TTY / 出错时返回空字符串 */
function readStdinLine(): string {
  try {
    if (!process.stdin.isTTY) return '';
    // 同步读一行（init 是一次性短命令，不会与 server 事件循环冲突）
    const buf = Buffer.alloc(1024);
    const n = readSync(0, buf, 0, buf.length, null);
    if (n === null || n <= 0) return '';
    return buf.subarray(0, n).toString('utf-8').trim().toLowerCase();
  } catch {
    return '';
  }
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

const rawConfigPath =
  argValue('--config') ?? argValue('-c') ?? process.env.MODEL_GATE_CONFIG ?? 'config.json';
const configPath = resolveConfigPath(rawConfigPath);

// 子命令：model-gate init —— 生成示例配置（全局安装后也能拿到，无需 clone 源码）
const subcommand = process.argv[2];
if (subcommand === 'init') {
  try {
    if (existsSync(configPath)) {
      // 已存在：交互确认是否覆盖（非 TTY / 直接回车 = 不覆盖）
      const force = process.argv.includes('--force');
      let overwrite = force;
      if (!force) {
        process.stdout.write(
          `[model-gate] 配置文件已存在: ${configPath}\n[model-gate] 是否覆盖？[y/N] `,
        );
        const answer = readStdinLine();
        overwrite = answer === 'y' || answer === 'yes';
      }
      if (!overwrite) {
        console.log(`[model-gate] 已存在，未覆盖: ${configPath}`);
        process.exit(0);
      }
    }
    writeSampleConfig(configPath);
    console.log(`[model-gate] 已生成示例配置: ${configPath}`);
    console.log(`[model-gate] 把 providers.*.api_key 换成真实 key（或用 \${ENV_VAR} 引用环境变量），再运行 \`model-gate\` 启动`);
    process.exit(0);
  } catch (e) {
    console.error(`[model-gate] 生成配置失败: ${(e as Error).message}`);
    process.exit(1);
  }
}

// 子命令：model-gate upgrade [@beta] —— 升级到最新版本（默认 latest，指定 @beta 升级到最新 beta）
// 优先用 bun 全局安装；bun 不可用则提示用户先安装 bun
if (subcommand?.startsWith('upgrade')) {
  try {
    const tag = subcommand.includes('@') ? subcommand.split('@')[1] : 'latest';
    const pkgName = 'wangmingfa/model-gate'; // 不带 @，npm/bun install -g 接受 @scope/name 写法
    const spec = `@${pkgName}@${tag}`;

    // 优先 bun
    const bunPath = typeof Bun !== 'undefined' ? Bun.which('bun') : undefined;
    if (bunPath) {
      console.log(`[model-gate] 正在用 bun 升级到 ${tag} 版本: ${spec}`);
      const proc = Bun.spawn(['bun', 'install', '-g', spec], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const code = await proc.exited;
      if (code === 0) {
        console.log(`\n✅ 已升级到 ${spec}，请重启 model-gate 生效`);
        process.exit(0);
      }
      // bun 报错但不一定是「找不到 bun」—— 仍提示安装以确保清晰
      console.error(`\n❌ bun 升级失败（exit ${code}）。`);
    }

    // bun 不可用 / 失败：提示安装（不 fallback 到 npm，按需求仅提示）
    console.error(`\n⚠️  未检测到可用的 bun，无法自动升级。`);
    console.error(`   请先安装 bun： https://bun.sh/docs/install`);
    console.error(`   或手动升级： bun install -g ${spec}`);
    process.exit(1);
  } catch (e) {
    console.error(`[model-gate] 升级失败: ${(e as Error).message}`);
    process.exit(1);
  }
}

// 启动 guard：配置文件不存在时，自动生成一份示例并继续启动（零配置开箱即用）
if (!existsSync(configPath)) {
  try {
    writeSampleConfig(configPath);
    console.log(`[model-gate] 配置文件不存在，已自动生成示例: ${configPath}`);
    console.log(`[model-gate] 把 providers.*.api_key 换成真实 key（或用 \${ENV_VAR} 引用环境变量）后重启即可生效`);
  } catch (e) {
    console.error(`[model-gate] 自动生成示例配置失败: ${(e as Error).message}`);
    process.exit(1);
  }
}

let cfg: Config;
try {
  cfg = loadConfig(configPath, 'boot');
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
    const next = loadConfig(configPath, 'boot');
    cfg = next;
    configureLogging(next.access_log);
    console.log(`[model-gate] 配置已热加载: ${configPath}（默认模型=${Object.keys(next.aliases).length > 0 ? next.default_model : '(未配置)'}，别名=${Object.keys(next.aliases).join(', ') || '(未配置)'}）`);
  } catch (e) {
    console.error(`[model-gate] 配置重载失败，保留当前配置: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  }
}, 1000);

const includeAdminStatic = process.env.MODEL_GATE_DEV !== '1';
const app = createApp(() => cfg, { configPath, includeAdminStatic });

// 显式接管终止信号并优雅停服：避免 bun run --parallel 下 SIGINT 传播失败导致 socket 未释放、端口残留占用
const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  // 把 Bun server 作为 env 传入，让 /admin 的回环检查能拿到 requestIP
  fetch: (req, server) => app.fetch(req, server),
});

function shutdown(signal: string): void {
  console.log(`[model-gate] 收到 ${signal}，正在关闭...`);
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (cfg.host === '0.0.0.0') {
  if (includeAdminStatic) {
    console.log(`[model-gate] 已启动，监听所有网卡（端口 ${cfg.port}），管理界面可访问入口:`);
    console.log(`  http://127.0.0.1:${cfg.port}/admin（本机）`);
    for (const ip of localIPv4Addresses()) {
      console.log(`  http://${ip}:${cfg.port}/admin`);
    }
  } else {
    console.log(`[model-gate] 已启动（开发模式，仅 API），端口 ${cfg.port}；管理界面通过 Vite: http://localhost:5173/admin`);
  }
} else if (includeAdminStatic) {
  console.log(`[model-gate] 已启动: http://${cfg.host}:${cfg.port}/admin（管理界面）`);
} else {
  console.log(`[model-gate] 已启动（开发模式，仅 API）: http://${cfg.host}:${cfg.port}`);
  console.log(`[model-gate] 管理界面通过 Vite: http://localhost:5173/admin`);
}
console.log(`[model-gate] 配置: ${configPath} | 别名: ${Object.keys(cfg.aliases).join(', ') || '(未配置)'} | 默认模型: ${Object.keys(cfg.aliases).length > 0 ? cfg.default_model : '(未配置)'}`);
