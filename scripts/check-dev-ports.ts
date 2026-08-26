// dev 端口预检：在 `bun run dev` 启动前检查 dev 端口是否被占用。
//
// 占用时：列出每个端口的占用进程（PID + 名称 + 命令行），交互询问是否杀死；
//   - 用户确认 → 杀掉后退出码 0，触发 `&&` 后续的 dev 启动
//   - 用户拒绝 / 非交互环境 → 退出码 1，dev 不会启动（需手动处理）
// 空闲时：直接退出码 0。
//
// dev 端口：8787=API（dev:api）、5173=admin UI（dev:ui / vite）。

import { spawnSync, execSync } from 'node:child_process';

const PORTS = [8787, 5173];
const isWin = process.platform === 'win32';

const safe = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

/** 取某端口上处于 LISTEN 的进程 PID（排除自身） */
function pidsOnPort(port: number): number[] {
  const set = new Set<number>();
  if (isWin) {
    const out = safe(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
    );
    out.split(/\r?\n/).forEach((l) => {
      const p = parseInt(l.trim(), 10);
      if (p) set.add(p);
    });
  } else {
    const out = safe(`lsof -ti tcp:${port}`);
    out.split(/\r?\n/).forEach((l) => {
      const p = parseInt(l.trim(), 10);
      if (p) set.add(p);
    });
  }
  set.delete(process.pid);
  return [...set];
}

interface ProcInfo {
  pid: number;
  name: string;
  cmd: string;
}

/** 批量查进程名称与命令行，用于展示 */
function describe(pids: number[]): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>();
  pids.forEach((p) => map.set(p, { pid: p, name: '', cmd: '' }));
  if (pids.length === 0) return map;
  if (isWin) {
    const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const out = (ps.stdout || '').trim();
    if (out) {
      try {
        const arr = JSON.parse(out.startsWith('[') ? out : `[${out}]`) as ProcInfo[];
        arr.forEach((p) => map.set(p.pid, { pid: p.pid, name: p.name ?? '', cmd: p.cmd ?? '' }));
      } catch {
        /* 解析失败则保留仅有 pid 的占位 */
      }
    }
    // 兜底：Get-CimInstance 拿不到名称时，用 tasklist 补镜像名，便于判断
    for (const p of map.values()) {
      if (!p.name) {
        const tl = safe(`tasklist /FI "PID eq ${p.pid}" /FO CSV /NH`).trim();
        const m = tl.match(/"([^"]+)"/);
        if (m) p.name = m[1];
      }
    }
  } else {
    pids.forEach((p) => {
      const cmd = safe(`ps -p ${p} -o command=`).trim();
      map.set(p, { pid: p, name: cmd.split(/\s+/)[0] ?? '', cmd });
    });
  }
  return map;
}

/** 等待端口释放（杀进程后给 OS 一点时间），最多 ~2s */
function waitUntilFree(port: number): void {
  for (let i = 0; i < 20; i++) {
    if (pidsOnPort(port).length === 0) return;
    // 阻塞式短暂等待（bun 下可用）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function ask(question: string): boolean {
  const promptFn = (globalThis as any).prompt as ((q?: string) => string | null) | undefined;
  if (typeof promptFn !== 'function' || !process.stdin.isTTY) {
    console.log('（非交互环境，无法确认）请手动处理占用进程后重试，或运行 `bun run kill-dev`。');
    return false;
  }
  const ans = promptFn(`${question} (y/N) `);
  return ans !== null && ans.trim().toLowerCase() === 'y';
}

const occupied = new Map<number, number[]>();
PORTS.forEach((port) => {
  const pids = pidsOnPort(port);
  if (pids.length) occupied.set(port, pids);
});

if (occupied.size === 0) {
  console.log('✓ dev 端口空闲 (8787 API / 5173 UI)，直接启动');
  process.exit(0);
}

const allPids = [...new Set([...occupied.values()].flat())];
const info = describe(allPids);

console.log('\n⚠️  dev 端口被占用，dev 无法正常启动：\n');
for (const [port, pids] of occupied) {
  console.log(`  端口 ${port}（${port === 8787 ? 'API' : 'admin UI'}）被以下进程占用：`);
  pids.forEach((pid) => {
    const p = info.get(pid)!;
    const name = p.name || '未知进程';
    console.log(`    • PID ${pid}  ${name}`);
    if (p.cmd) console.log(`        ${p.cmd}`);
  });
  console.log('');
}

const ok = ask('是否杀掉以上占用进程并继续启动 dev？');
if (!ok) {
  console.log('已取消，未启动 dev。可手动处理后重试，或运行 `bun run kill-dev`。');
  process.exit(1);
}

for (const [port, pids] of occupied) {
  for (const pid of pids) {
    try {
      if (isWin) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
      console.log(`已杀死 PID ${pid}`);
    } catch {
      /* 可能已退出 */
    }
  }
  waitUntilFree(port);
}

console.log('✓ 占用已清理，开始启动 dev\n');
process.exit(0);
