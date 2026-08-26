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
 * 轻量终端 spinner：执行异步任务期间显示旋转动画 + 文案，
 * 完成后用 ✔（成功）或 ✗（失败）收尾并换行。不依赖任何第三方库。
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const elapsed = () => Math.floor((Date.now() - start) / 1000);

  if (!process.stdout.isTTY) {
    // 非交互终端（CI / 管道 / 沙箱日志）：静态提示 + 周期性「已等待 Ns」，
    // 避免 npm 查询较慢时整段静默、看起来像卡死
    process.stdout.write(`⏳ ${text}...\n`);
    const timer = setInterval(() => {
      process.stdout.write(`   ⏳ 仍在查询... (已等待 ${elapsed()}s)\n`);
    }, 3000);
    try {
      const result = await fn();
      clearInterval(timer);
      process.stdout.write(`✔ ${text} (${elapsed()}s)\n`);
      return result;
    } catch (e) {
      clearInterval(timer);
      process.stdout.write(`✗ ${text}\n`);
      throw e;
    }
  }

  let frame = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}... (${elapsed()}s)`);
    frame++;
  }, 100);
  try {
    const result = await fn();
    clearInterval(timer);
    process.stdout.write(`\r✔ ${text}\n`);
    return result;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(`\r✗ ${text}\n`);
    throw e;
  }
}

/** npm 查询遇临时性失败时的最大重试次数与每次间隔 */
const NPM_QUERY_RETRIES = 3;
const NPM_QUERY_RETRY_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 通用重试：task 抛错时重试，直到成功或重试次数耗尽。
 * 耗尽后抛出最后一次的错误，由上层终止并提示原因。
 */
async function withRetry<T>(
  task: () => Promise<T>,
  opts: { retries: number; delayMs: number; onRetry?: (attempt: number, err: Error) => void },
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    try {
      return await task();
    } catch (e) {
      lastErr = e as Error;
      if (attempt <= opts.retries) {
        opts.onRetry?.(attempt, lastErr);
        await sleep(opts.delayMs);
      }
    }
  }
  throw lastErr ?? new Error('未知查询错误');
}

/**
 * 执行 `npm view <name> versions --json`，结构化返回：
 *   - { found: true, versions }          查询成功
 *   - { found: false, versions: [] }      包在 registry 上不存在（404，视为首发）
 *   - 抛错                                传输 / 网络等临时性错误（需重试或终止）
 * 通过 stderr 是否含 E404 / Not Found 区分「真的不存在」与「查询出错」，
 * 避免把网络抖动误判成「从未发布」。
 */
async function npmViewVersions(name: string): Promise<{ found: boolean; versions: string[] }> {
  const proc = Bun.spawn(['npm', 'view', name, 'versions', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0) {
    try {
      const parsed = JSON.parse(out);
      return { found: true, versions: Array.isArray(parsed) ? parsed : [] };
    } catch {
      throw new Error(`npm 返回了无法解析的响应: ${out.trim().slice(0, 200)}`);
    }
  }
  if (/E?404|Not Found/i.test(err)) return { found: false, versions: [] };
  throw new Error(`npm view 查询失败 (exit ${code}): ${(err.trim() || out.trim()).slice(0, 300)}`);
}

/**
 * 从 npm registry 拉取该包「当前通道」已发布的最新版本（按 semver 取最大）。
 * - channel=beta：只看带 prerelease 后缀的版本（如 x.y.z-beta.N），取最大
 * - channel=latest：只看 stable 版本（无后缀），取最大
 * 该通道没有任何已发布版本（含从未发布）返回 null。
 * 查询遇临时性错误会重试；重试耗尽仍失败则向上抛错，由 main() 终止并提示原因。
 * 注意：不能用 `npm view <pkg> version`（它只看 latest dist-tag，会漏掉 beta 版本）。
 */
async function fetchLatestVersion(name: string, channel: Channel): Promise<string | null> {
  const result = await withRetry(
    () => npmViewVersions(name),
    {
      retries: NPM_QUERY_RETRIES,
      delayMs: NPM_QUERY_RETRY_DELAY_MS,
      onRetry: (attempt, err) =>
        console.warn(`\n⚠️  第 ${attempt} 次查询 npm 失败，${NPM_QUERY_RETRY_DELAY_MS / 1000}s 后重试：${err.message}`),
    },
  );
  if (!result.found) return null;
  const isPre = (v: string) => /-\w/.test(v);
  const inChannel = channel === 'beta' ? isPre : (v: string) => !isPre(v);
  const candidates = result.versions.filter(inChannel).sort((a, b) => cmpSemver(a, b));
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** 简单 semver 比较：a < b 返回负数，a === b 返回 0，a > b 返回正数 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  // base 相同：比较 prerelease（无后缀 > 有后缀；同为后缀按字典序）
  const preA = a.includes('-') ? a.split('-')[1] : null;
  const preB = b.includes('-') ? b.split('-')[1] : null;
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return preA < preB ? -1 : preA > preB ? 1 : 0;
}

/** 校验字符串是否合法 semver（允许 -prerelease 后缀） */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v);
}

/**
 * 查询 `npm view <name>@<version> version`，区分三种情况：
 *   - { exists: true }                 已发布（占用）
 *   - { exists: false }                包/版本不存在（404）
 *   - 抛错                             传输 / 网络等临时性错误（需重试或终止）
 */
async function npmViewVersionExact(name: string, version: string): Promise<{ exists: boolean }> {
  const proc = Bun.spawn(['npm', 'view', `${name}@${version}`, 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0) return { exists: out.trim() === version };
  if (/E?404|Not Found/i.test(err)) return { exists: false };
  throw new Error(`npm view 查询失败 (exit ${code}): ${(err.trim() || out.trim()).slice(0, 300)}`);
}

/** 该版本号是否已在 npm 上发布过（占用）。
 *  临时性查询错误会重试；重试耗尽仍失败则抛错，由上层终止并提示原因，
 *  避免把「查询失败」误判为「未占用」而覆盖已发布版本。 */
export async function versionExists(name: string, version: string): Promise<boolean> {
  return await withRetry(
    () => npmViewVersionExact(name, version),
    {
      retries: NPM_QUERY_RETRIES,
      delayMs: NPM_QUERY_RETRY_DELAY_MS,
      onRetry: (attempt, err) =>
        console.warn(`\n⚠️  第 ${attempt} 次查询 npm 失败，${NPM_QUERY_RETRY_DELAY_MS / 1000}s 后重试：${err.message}`),
    },
  ).then((r) => r.exists);
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

/**
 * 发布前确保已登录 npm。未登录 / 登录态失效时：
 *   - 交互终端：自动执行 `npm login`，等待用户完成浏览器/凭证登录后再继续
 *   - 非交互环境：明确提示需要先自行登录，直接退出
 * 登录成功后再次校验，确保后续 publish 不会因未登录而 404 / ENEEDAUTH。
 */
async function ensureNpmLogin(): Promise<void> {
  const whoami = await Bun.spawn(['npm', 'whoami'], { stdout: 'pipe', stderr: 'pipe' });
  const code = await whoami.exited;
  if (code === 0) {
    const user = (await new Response(whoami.stdout).text()).trim();
    console.log(`\n✔ npm 已登录: ${user}`);
    return;
  }
  console.log(`\n⚠️  未检测到 npm 登录态（或登录已失效），发布需要先登录`);
  if (!process.stdin.isTTY) {
    throw new Error('当前非交互终端无法执行 npm login，请先在终端运行 `npm login` 后再重试。');
  }
  console.log(`请完成 npm 登录（会打开浏览器 / 输入凭证）：`);
  await run('npm', ['login']);
  // 登录后再次确认
  const recheck = await Bun.spawn(['npm', 'whoami'], { stdout: 'pipe', stderr: 'pipe' });
  if ((await recheck.exited) !== 0) {
    throw new Error('npm login 未完成或失败，请检查登录状态后重试。');
  }
  console.log(`✔ npm 登录成功: ${(await new Response(recheck.stdout).text()).trim()}`);
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
    if (await withSpinner(`查询 npm 上 ${pkg.name}@${explicitVersion} 是否已发布`, () => versionExists(pkg.name, explicitVersion))) {
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

    // 基准版本取 npm 远端「当前通道」最新版；查不到（从未发布 / 该通道无版本）则默认 0.0.0
    const remoteVer = await withSpinner(`查询 npm 上 ${pkg.name} 在 ${channel} 通道的最新版本`, () => fetchLatestVersion(pkg.name, channel));
    isFirstRelease = remoteVer === null;
    oldVer = remoteVer ?? '0.0.0';
    newVer = nextVersion(oldVer, channel, bump, isFirstRelease);

    // 校验算出的新版本是否已被占用（交互模式此前未校验，会直接 publish 撞墙）
    // 若已占用：beta 通道的 iteration 自动顺延 +1，直到找到一个未占用版本；其他情况报错让用户重跑
    if (await versionExists(pkg.name, newVer)) {
      if (channel === 'beta' && bump === 'iteration') {
        let guard = 0;
        while (await versionExists(pkg.name, newVer)) {
          newVer = nextVersion(newVer, channel, 'iteration', false);
          if (++guard > 50) throw new Error('iteration 顺延超过 50 次仍被占用，请检查 npm 版本历史');
        }
        console.log(`\n⚠️  ${oldVer} 的下一版已被占用，已自动顺延到 ${newVer}`);
      } else {
        throw new Error(`版本 ${pkg.name}@${newVer} 已被发布过（npm 上已存在）。请换一个未占用的版本号，或用 beta+iteration 自动顺延。`);
      }
    }

    if (isFirstRelease) {
      console.log(`\nℹ️  npm 上未找到 ${pkg.name}（${channel} 通道），按首发处理（基准版本 ${oldVer}）`);
    } else {
      console.log(`\nℹ️  npm ${channel} 通道最新版本 ${oldVer}（本地 ${pkg.version}）`);
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

  // 发布前确认 npm 登录态：未登录（或登录态失效）时引导登录，避免 publish 时 404 / ENEEDAUTH
  await ensureNpmLogin();

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
