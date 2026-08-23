#!/usr/bin/env bun
/**
 * 一键发布到 npm。
 *
 * 交互流程（inquirer 方向键）：
 *   1. 选择发布通道：latest / beta（默认 beta）
 *   2. 选择版本升级：major / minor / patch / iteration（beta 默认 iteration，latest 默认 patch）
 *   3. 方向键确认发布
 *   4. 自动：写回 package.json version → bun run build → npm publish（beta 带 --tag beta）
 *   5. 发布成功后自动 git commit package.json 的版本变更（不 push）
 *
 * 也支持非交互（CI / 脚本调用）：
 *   bun scripts/release.ts <latest|beta> <major|minor|patch|iteration> [otp]   # 旧版：指定通道+升级
 *   bun scripts/release.ts 0.0.0-beta.1 [--otp xxx]                            # 显式版本号：跳过通道/升级选择，仅确认一次
 *     - 传入合法版本号（x.y.z 或 x.y.z-beta.N）即视为显式指定，自动推断通道（带 -beta 后缀→beta）
 *     - 自动校验该版本号未被 npm 占用，已占用则报错退出
 *     - 仅做一次发布确认，不再询问通道与升级方式
 *
 * 版本规则：
 *   - major / minor / patch 基于当前「基础版本」(去掉 prerelease 后缀) 升级
 *   - iteration：在 prerelease 上累加迭代号
 *       · 当前 x.y.z-beta.N  →  x.y.z-beta.(N+1)
 *       · 当前 x.y.z (stable) →  x.y.(z+1)-beta.1   （从 stable 切到 beta 的首个迭代）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import inquirer from 'inquirer';

const PKG_PATH = resolve(import.meta.dir, '..', 'package.json');

/**
 * 从 npm registry 拉取该包已发布的最新版本。
 * 查不到（404 / 网络错误 / 从未发布）返回 null。
 */
async function fetchLatestVersion(name: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['npm', 'view', name, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const v = out.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 校验字符串是否合法 semver（允许 -prerelease 后缀） */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v);
}

/** 该版本号是否已在 npm 上发布过（占用） */
export async function versionExists(name: string, version: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['npm', 'view', `${name}@${version}`, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return false;
    return out.trim() === version;
  } catch {
    return false;
  }
}

/** 从版本号推断通道：带 -beta 等 prerelease 后缀 → beta，否则 latest */
export function channelOfVersion(v: string): Channel {
  return /-\w/.test(v) ? 'beta' : 'latest';
}

type Channel = 'latest' | 'beta';
type Bump = 'major' | 'minor' | 'patch' | 'iteration';

const CHANNELS: Channel[] = ['latest', 'beta'];
const BUMPS: Bump[] = ['major', 'minor', 'patch', 'iteration'];

export function readPkg(): { name: string; version: string; [k: string]: unknown } {
  return JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { name: string; version: string };
}

/** 把版本拆成 { base, pre }，pre 形如 "beta.3" 或 null */
export function parseVersion(v: string): { base: string; pre: string | null; nums: [number, number, number] } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return {
    base: `${m[1]}.${m[2]}.${m[3]}`,
    pre: m[4] ?? null,
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
  };
}

export function bumpBase([maj, min, pat]: [number, number, number], bump: Exclude<Bump, 'iteration'>): [number, number, number] {
  switch (bump) {
    case 'major':
      return [maj + 1, 0, 0];
    case 'minor':
      return [maj, min + 1, 0];
    case 'patch':
      return [maj, min, pat + 1];
  }
}

/**
 * 计算新版本号。
 * @param isFirstRelease 远端 registry 查不到该包（从未发布过）。
 *   首次发布时，stable → beta 不提前升 patch，直接用当前 base 挂 beta.1。
 */
export function nextVersion(current: string, channel: Channel, bump: Bump, isFirstRelease = false): string {
  const { nums, pre } = parseVersion(current);

  if (channel === 'beta') {
    if (bump === 'iteration') {
      // 当前已在 beta：迭代号 +1
      if (pre && pre.startsWith('beta.')) {
        const n = Number(pre.slice('beta.'.length)) || 0;
        return `${nums[0]}.${nums[1]}.${nums[2]}-beta.${n + 1}`;
      }
      // 当前是 stable：
      //   - 首发：直接用当前 base 挂 beta.1（如 0.1.0 → 0.1.0-beta.1）
      //   - 非首发：切到下一个 patch 的 beta.1（如 0.1.0 → 0.1.1-beta.1）
      if (isFirstRelease) {
        return `${nums[0]}.${nums[1]}.${nums[2]}-beta.1`;
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

/** 交互选择（inquirer 方向键列表）；非交互时 input 直接命中 */
async function pick<T extends string>(
  label: string,
  options: T[],
  input: string | undefined,
  defaultValue: T,
): Promise<T> {
  if (input !== undefined) {
    const hit = options.find((o) => o === input);
    if (!hit) throw new Error(`无效的${label}: "${input}"，可选: ${options.join(' / ')}`);
    return hit;
  }
  const { ans } = await inquirer.prompt<{ ans: T }>([
    {
      type: 'select',
      name: 'ans',
      message: label,
      choices: options,
      default: defaultValue,
    },
  ]);
  return ans;
}

async function run(cmd: string, args: string[]): Promise<void> {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const proc = Bun.spawn([cmd, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`命令失败 (exit ${code}): ${cmd} ${args.join(' ')}`);
}

async function main() {
  const argv = Bun.argv.slice(2);

  // 解析可选参数：
  //   bun run release <version> [--otp xxx]
  //   bun run release <channel> <bump> [otp]   （旧的非交互用法仍兼容）
  //   bun run release                            （全交互）
  let explicitVersion: string | undefined;
  let otp: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--otp') {
      otp = argv[++i];
    } else if (a.startsWith('--otp=')) {
      otp = a.slice('--otp='.length);
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  // 第一个位置参数：若像版本号（x.y.z[-pre]）则视为显式版本，否则走旧版 channel/bump
  if (positional[0] && isValidVersion(positional[0])) {
    explicitVersion = positional[0];
  }
  const legacyChannel = explicitVersion ? undefined : positional[0];
  const legacyBump = explicitVersion ? undefined : positional[1];
  if (!explicitVersion && positional[2]) otp = otp ?? positional[2];

  const pkg = readPkg();

  let channel: Channel;
  let bump: Bump;
  let newVer: string;
  let oldVer: string;
  let isFirstRelease: boolean;

  if (explicitVersion) {
    // 显式版本模式：跳过通道/升级交互，仅做一次确认
    if (await versionExists(pkg.name, explicitVersion)) {
      throw new Error(`版本 ${pkg.name}@${explicitVersion} 已被发布过，不能重复发布。请换一个未占用的版本号。`);
    }
    channel = channelOfVersion(explicitVersion);
    bump = 'iteration'; // 仅占位，显式模式下不参与计算
    oldVer = explicitVersion; // 显示用
    newVer = explicitVersion;
    isFirstRelease = false;
    console.log(`\nℹ️  使用显式版本号 ${explicitVersion}（通道 ${channel}，跳过通道/升级选择）`);
  } else {
    // 交互 / 旧版非交互模式
    channel = await pick<Channel>('发布通道 (latest / beta)', CHANNELS, legacyChannel, 'beta');
    const defaultBump: Bump = channel === 'beta' ? 'iteration' : 'patch';
    bump = await pick<Bump>('版本升级', BUMPS, legacyBump, defaultBump);

    // 基准版本优先取 npm 远端最新版；查不到（从未发布）则默认 0.0.0
    const remoteVer = await fetchLatestVersion(pkg.name);
    isFirstRelease = remoteVer === null;
    oldVer = remoteVer ?? '0.0.0';
    newVer = nextVersion(oldVer, channel, bump, isFirstRelease);

    if (isFirstRelease) {
      console.log(`\nℹ️  npm 上未找到 ${pkg.name}，按首发处理（基准版本 ${oldVer}）`);
    } else {
      console.log(`\nℹ️  npm 最新版本 ${oldVer}（本地 ${pkg.version}）`);
    }
  }

  console.log(`\n==============================`);
  console.log(`  当前版本 : ${oldVer}`);
  if (!explicitVersion) console.log(`  发布通道 : ${channel}`);
  if (!explicitVersion) console.log(`  版本升级 : ${bump}`);
  console.log(`  新版本号 : ${newVer}`);
  console.log(`  发布通道 : ${channel}`);
  console.log(`==============================`);

  // 确认：显式版本模式只做一次确认；其余模式方向键确认 + 询问 OTP
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    { type: 'confirm', name: 'ok', message: `确认发布 ${newVer} 到 npm (${channel})?`, default: false },
  ]);
  if (!ok) {
    console.log('已取消。');
    process.exit(0);
  }
  if (!otp) {
    const { otpAns } = await inquirer.prompt<{ otpAns: string }>([
      { type: 'input', name: 'otpAns', message: 'OTP（留空跳过，发布时若要求再重试）:' },
    ]);
    otp = otpAns.trim() || undefined;
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
  if (otp) publishArgs.push('--otp', otp);
  await run('npm', publishArgs);

  console.log(`\n🎉 已发布 ${pkg.name}@${newVer} (${channel})`);

  // 4. 发布成功后自动提交版本变更（仅 package.json，build 产物已被 gitignore）
  await gitCommitRelease(pkg.name, newVer, channel);
}

/** 发布成功后提交 package.json 的版本变更（不 push，由用户自行决定） */
async function gitCommitRelease(name: string, version: string, channel: Channel): Promise<void> {
  // 仅在 git 仓库内、且 package.json 确有改动时才提交
  const statusProc = Bun.spawn(['git', 'status', '--porcelain', 'package.json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const statusOut = await new Response(statusProc.stdout).text();
  await statusProc.exited;
  if (!statusOut.trim()) {
    console.log('\nℹ️  package.json 无改动，跳过 commit。');
    return;
  }
  await run('git', ['add', 'package.json']);
  const msg = `chore: release ${name}@${version} (${channel})`;
  await run('git', ['commit', '-m', msg]);
  console.log(`\n✓ 已提交版本变更（${msg}）。未自动 push，请按需手动推送。`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  });
}
