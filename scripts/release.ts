#!/usr/bin/env bun
/**
 * 一键发布到 npm。
 *
 * 交互流程：
 *   1. 选择发布通道：latest / beta
 *   2. 选择版本升级：major / minor / patch / iteration
 *   3. 自动：写回 package.json version → bun run build → npm publish（beta 带 --tag beta）
 *
 * 也支持非交互（CI / 脚本调用），直接传参：
 *   bun scripts/release.ts <latest|beta> <major|minor|patch|iteration>
 *
 * 版本规则：
 *   - major / minor / patch 基于当前「基础版本」(去掉 prerelease 后缀) 升级
 *   - iteration：在 prerelease 上累加迭代号
 *       · 当前 x.y.z-beta.N  →  x.y.z-beta.(N+1)
 *       · 当前 x.y.z (stable) →  x.y.(z+1)-beta.1   （从 stable 切到 beta 的首个迭代）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_PATH = resolve(import.meta.dir, '..', 'package.json');

type Channel = 'latest' | 'beta';
type Bump = 'major' | 'minor' | 'patch' | 'iteration';

const CHANNELS: Channel[] = ['latest', 'beta'];
const BUMPS: Bump[] = ['major', 'minor', 'patch', 'iteration'];

function readPkg(): { version: string; [k: string]: unknown } {
  return JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { version: string };
}

/** 把版本拆成 { base, pre }，pre 形如 "beta.3" 或 null */
function parseVersion(v: string): { base: string; pre: string | null; nums: [number, number, number] } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return {
    base: `${m[1]}.${m[2]}.${m[3]}`,
    pre: m[4] ?? null,
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
  };
}

function bumpBase([maj, min, pat]: [number, number, number], bump: Exclude<Bump, 'iteration'>): [number, number, number] {
  switch (bump) {
    case 'major':
      return [maj + 1, 0, 0];
    case 'minor':
      return [maj, min + 1, 0];
    case 'patch':
      return [maj, min, pat + 1];
  }
}

/** 计算新版本号 */
function nextVersion(current: string, channel: Channel, bump: Bump): string {
  const { nums, pre } = parseVersion(current);

  if (channel === 'beta') {
    if (bump === 'iteration') {
      // 当前已在 beta：迭代号 +1；当前是 stable：切到下一个 patch 的 beta.1
      if (pre && pre.startsWith('beta.')) {
        const n = Number(pre.slice('beta.'.length)) || 0;
        return `${nums[0]}.${nums[1]}.${nums[2]}-beta.${n + 1}`;
      }
      const [maj, min, pat] = bumpBase(nums, 'patch');
      return `${maj}.${min}.${pat}-beta.1`;
    }
    // beta + major/minor/patch：升基础版本并附 beta.1
    const [maj, min, pat] = bumpBase(nums, bump);
    return `${maj}.${min}.${pat}-beta.1`;
  }

  // latest 通道
  if (bump === 'iteration') {
    // latest 上的 iteration 没有 prerelease 概念，等价于 patch
    const [maj, min, pat] = bumpBase(nums, 'patch');
    return `${maj}.${min}.${pat}`;
  }
  const [maj, min, pat] = bumpBase(nums, bump);
  return `${maj}.${min}.${pat}`;
}

function pick<T extends string>(label: string, options: T[], input: string | undefined, defaultValue: T): T {
  if (input !== undefined) {
    const hit = options.find((o) => o === input);
    if (!hit) throw new Error(`无效的${label}: "${input}"，可选: ${options.join(' / ')}`);
    return hit;
  }
  // 交互选择
  console.log(`\n请选择 ${label}：(默认 ${defaultValue})`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}${o === defaultValue ? '  ◀' : ''}`));
  const ans = (prompt(`输入序号或名称 (默认 ${defaultValue}):`) ?? '').trim().toLowerCase();
  if (ans === '') return defaultValue;
  const byIndex = options[Number(ans) - 1];
  if (byIndex) return byIndex;
  const byName = options.find((o) => o === ans);
  if (!byName) throw new Error(`无效的${label}: "${ans}"`);
  return byName;
}

async function run(cmd: string, args: string[]): Promise<void> {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const proc = Bun.spawn([cmd, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`命令失败 (exit ${code}): ${cmd} ${args.join(' ')}`);
}

async function main() {
  const argv = Bun.argv.slice(2);
  // 通道默认 beta；升级默认随通道：beta→iteration，latest→patch
  const channel = pick<Channel>('发布通道', CHANNELS, argv[0] ?? undefined, 'beta');
  const defaultBump: Bump = channel === 'beta' ? 'iteration' : 'patch';
  const bump = pick<Bump>('版本升级', BUMPS, argv[1] ?? undefined, defaultBump);

  const pkg = readPkg();
  const oldVer = pkg.version;
  const newVer = nextVersion(oldVer, channel, bump);

  console.log(`\n==============================`);
  console.log(`  当前版本 : ${oldVer}`);
  console.log(`  发布通道 : ${channel}`);
  console.log(`  版本升级 : ${bump}`);
  console.log(`  新版本号 : ${newVer}`);
  console.log(`==============================`);

  const confirm = (prompt(`确认发布 ${newVer} 到 npm (${channel})? [y/N]:`) ?? 'n').trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('已取消。');
    process.exit(0);
  }

  // 1. 写回版本号
  pkg.version = newVer;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`\n✓ package.json version → ${newVer}`);

  // 2. build（embed + bun build，产出 model-gate.js）
  await run('bun', ['run', 'build']);

  // 3. publish
  const publishArgs = ['publish'];
  if (channel === 'beta') publishArgs.push('--tag', 'beta');
  publishArgs.push('--access', 'public');
  await run('npm', publishArgs);

  console.log(`\n🎉 已发布 model-gate@${newVer} (${channel})`);
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
