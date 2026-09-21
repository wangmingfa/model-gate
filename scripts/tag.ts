#!/usr/bin/env bun
/**
 * 交互式创建发布 tag 并推送（触发 GitHub Actions 自动发布到 npm）。
 *
 * 交互流程（inquirer 方向键）：
 *   1. 选择通道：latest / beta（默认 latest；决定 CI 发布走 latest 还是 beta dist-tag）
 *   2. 选择版本升级：latest 默认 patch；beta 默认 iteration（beta.N 累加）
 *      版本基线取 npm 该通道最新已发布版本（与 release.ts 同一套规则，
 *      本地 package.json 可能落后于远端，以远端为准）
 *   3. 确认 → 本地打 annotated tag → 推送 origin
 *
 * 也支持非交互：bun scripts/tag.ts <version>   # 显式版本号，跳过通道/升级选择
 *   - 校验版本号合法且对应 tag 未被本地/远端占用
 *
 * tag 命名：v<version>；含 -beta.N 后缀的 tag 触发的 CI 发布自动走 --tag beta，
 * 否则走 latest（见 .github/workflows/publish.yml）。
 */

import inquirer from 'inquirer';
import {
  channelOfVersion,
  fetchLatestVersion,
  isValidVersion,
  nextVersion,
  pick,
  readPkg,
  run,
  withSpinner,
} from './release';

type Channel = 'latest' | 'beta';
type Bump = 'major' | 'minor' | 'patch' | 'iteration';

const CHANNELS: Channel[] = ['latest', 'beta'];
const BUMPS: Bump[] = ['major', 'minor', 'patch', 'iteration'];

/** 本地是否已存在同名 tag */
async function localTagExists(tag: string): Promise<boolean> {
  const p = Bun.spawn(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdout: 'pipe', stderr: 'pipe' });
  return (await p.exited) === 0;
}

/** 远端 origin 是否已存在同名 tag（ls-remote 权威查询，不依赖本地状态） */
async function remoteTagExists(tag: string): Promise<boolean> {
  const p = Bun.spawn(['git', 'ls-remote', '--tags', 'origin', tag], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().length > 0;
}

async function main() {
  const pkg = readPkg();
  const explicit = Bun.argv[2];

  let channel: Channel;
  let version: string;

  if (explicit !== undefined) {
    if (!isValidVersion(explicit)) throw new Error(`无效版本号: "${explicit}"，应为 x.y.z 或 x.y.z-beta.N`);
    channel = channelOfVersion(explicit);
    version = explicit;
    console.log(`\nℹ️  使用显式版本号 ${version}（通道 ${channel}）`);
  } else {
    channel = await pick<Channel>('发布通道（决定 CI 发布走 latest 还是 beta）', CHANNELS, undefined, 'latest');
    const defaultBump: Bump = channel === 'beta' ? 'iteration' : 'patch';
    const bump = await pick<Bump>('版本升级', BUMPS, undefined, defaultBump);

    // 基线取 npm 该通道最新已发布版本；查不到（从未发布 / 该通道无版本）按首发处理
    const remoteVer = await withSpinner(`查询 npm 上 ${pkg.name} 在 ${channel} 通道的最新版本`, () =>
      fetchLatestVersion(pkg.name, channel),
    );
    const isFirstRelease = remoteVer === null;
    const base = remoteVer ?? '0.0.0';
    version = nextVersion(base, channel, bump, isFirstRelease);
    if (isFirstRelease) {
      console.log(`\nℹ️  npm 上未找到 ${pkg.name}（${channel} 通道），按首发处理`);
    } else {
      console.log(`\nℹ️  npm ${channel} 通道最新 ${base}（package.json: ${pkg.version}）`);
    }
  }

  const tag = `v${version}`;

  // 打 tag 前先查占用（本地 / 远端），避免 push 时才发现冲突
  if (await localTagExists(tag)) throw new Error(`本地已存在 tag ${tag}。如需重建请先 git tag -d ${tag}`);
  if (await remoteTagExists(tag)) throw new Error(`远端 origin 已存在 tag ${tag}，请换一个版本号。`);

  console.log(`\n==============================`);
  console.log(`  包名    : ${pkg.name}`);
  console.log(`  新版本  : ${version}`);
  console.log(`  通道    : ${channel}`);
  console.log(`  tag     : ${tag}（将推送到 origin，触发 CI 构建发布）`);
  console.log(`==============================`);

  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    { type: 'confirm', name: 'ok', message: `确认创建并推送 ${tag}?`, default: false },
  ]);
  if (!ok) {
    console.log('已取消。');
    process.exit(0);
  }

  await run('git', ['tag', '-a', tag, '-m', `release ${pkg.name}@${version} (${channel})`]);
  console.log(`\n✓ 已创建 tag ${tag}`);
  await run('git', ['push', 'origin', tag]);
  console.log(`\n🎉 已推送 ${tag}。GitHub Actions 将自动构建并发布 ${pkg.name}@${version}（${channel}）。`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exit(1);
  });
}
