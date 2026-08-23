#!/usr/bin/env bun
/**
 * 撤销已发布的 npm 版本。
 *
 * 两种模式：
 *   1. 默认（软撤销）：npm deprecate <pkg>@<ver> "<msg>"
 *      - 版本仍可被安装，但安装时打印废弃警告；永久可用、安全。
 *   2. --hard（硬撤销）：npm unpublish <pkg>@<ver>
 *      - 真正删除版本；仅限发布后 72 小时内，超时需联系 npm 支持。
 *
 * 用法：
 *   bun scripts/unpublish.ts                 # 交互：列出最近 5 个版本用方向键选
 *   bun scripts/unpublish.ts 0.1.1-beta.1    # 指定版本
 *   bun scripts/unpublish.ts 0.1.1-beta.1 --hard
 *   bun scripts/unpublish.ts --hard          # 交互选版本 + 硬撤销
 *   bun scripts/unpublish.ts 0.1.1-beta.1 --otp 123456
 *
 * 版本列表取 npm registry 上最近发布的 5 个（versions 数组尾部）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import inquirer from 'inquirer';

const PKG_PATH = resolve(import.meta.dir, '..', 'package.json');
const RECENT = 5;

export function readPkg(): { name: string } {
  return JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { name: string };
}

/** 拉取该包已发布的所有版本（升序），失败返回空数组 */
export async function fetchVersions(name: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(['npm', 'view', name, 'versions', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return [];
    const data = JSON.parse(out);
    // npm 单版本时可能返回字符串，多版本返回数组
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

async function run(cmd: string, args: string[]): Promise<void> {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const proc = Bun.spawn([cmd, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`命令失败 (exit ${code}): ${cmd} ${args.join(' ')}`);
}

async function main() {
  const argv = Bun.argv.slice(2);
  const pkg = readPkg();

  // 解析参数
  let target: string | undefined;
  let hard = false;
  let otp: string | undefined;
  for (const a of argv) {
    if (a === '--hard') hard = true;
    else if (a === '--otp') {
      /* 占位，下面单独取 */
    } else if (a.startsWith('--otp=')) {
      otp = a.slice('--otp='.length);
    } else if (!a.startsWith('--') && /^[\d.+-]/.test(a)) {
      target = a;
    }
  }
  // 单独处理 --otp <code>
  const otpIdx = argv.indexOf('--otp');
  if (otpIdx !== -1 && argv[otpIdx + 1]) otp = argv[otpIdx + 1];

  // 未指定版本 → 拉最近 RECENT 个，方向键选
  if (!target) {
    const all = await fetchVersions(pkg.name);
    if (all.length === 0) {
      console.error(`\n❌ npm 上找不到 ${pkg.name} 的任何已发布版本，无法撤销。`);
      process.exit(1);
    }
    const recent = all.slice(-RECENT);
    const { choice } = await inquirer.prompt<{ choice: string }>([
      {
        type: 'select',
        name: 'choice',
        message: `选择要撤销的版本（最近 ${RECENT} 个）`,
        choices: recent,
        default: recent[recent.length - 1],
      },
    ]);
    target = choice;
  }

  console.log(`\n==============================`);
  console.log(`  包名     : ${pkg.name}`);
  console.log(`  目标版本 : ${target}`);
  console.log(`  撤销方式 : ${hard ? 'hard (unpublish，72h 内)' : 'soft (deprecate，安全)'}`);
  console.log(`==============================`);

  if (hard) {
    const { ok } = await inquirer.prompt<{ ok: boolean }>([
      {
        type: 'confirm',
        name: 'ok',
        message: `⚠️ 确认 HARD 删除 ${pkg.name}@${target}？此操作不可恢复（仅发布 72h 内允许）`,
        default: false,
      },
    ]);
    if (!ok) {
      console.log('已取消。');
      process.exit(0);
    }
    const args = ['unpublish', `${pkg.name}@${target}`, '--access', 'public'];
    if (otp) args.push('--otp', otp);
    await run('npm', args);
    console.log(`\n🗑️  已硬删除 ${pkg.name}@${target}`);
  } else {
    const { msg } = await inquirer.prompt<{ msg: string }>([
      {
        type: 'input',
        name: 'msg',
        message: '废弃说明 (deprecate message):',
        default: 'This version is deprecated. Please upgrade.',
      },
    ]);
    const args = ['deprecate', `${pkg.name}@${target}`, msg];
    if (otp) args.push('--otp', otp);
    await run('npm', args);
    console.log(`\n🚫 已标记废弃 ${pkg.name}@${target}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  });
}
