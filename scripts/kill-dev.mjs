// Kill leftover `bun run dev` processes and free their ports.
// Usage:
//   bun scripts/kill-dev.mjs        # kill for real
//   bun scripts/kill-dev.mjs --dry  # list only, do not kill
//
// Strategy:
//   1. Find PIDs listening on the dev ports (5173 vite, 8787 api).
//   2. Find PIDs whose command line matches the dev signature
//      (run dev / dev:api / dev:ui / vite / src/index.ts).
//   3. Kill everything found (except ourselves).

import { execSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const PORTS = [5173, 8787];
const CMD_SIGNATURES = ['run dev', 'dev:api', 'dev:ui', 'vite/bin/vite', 'src/index.ts'];
const DRY = process.argv.includes('--dry');

const isWin = process.platform === 'win32';

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function pidsFromPorts() {
  const pids = new Set();
  if (isWin) {
    for (const port of PORTS) {
      const out = sh(
        `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`
      );
      out.split(/\r?\n/).forEach((l) => {
        const p = parseInt(l.trim(), 10);
        if (p) pids.add(p);
      });
    }
  } else {
    for (const port of PORTS) {
      const out = sh(`lsof -ti tcp:${port}`);
      out.split(/\r?\n/).forEach((l) => {
        const p = parseInt(l.trim(), 10);
        if (p) pids.add(p);
      });
    }
  }
  return pids;
}

function pidsFromCmdline() {
  const pids = new Set();
  const pattern = CMD_SIGNATURES.join('|').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (isWin) {
    // Use spawnSync so we can exclude the helper powershell's own PID:
    // its command line contains the signature string and would self-match.
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const helperPid = ps.pid;
    const out = ps.stdout || '';
    out.split(/\r?\n/).forEach((l) => {
      const p = parseInt(l.trim(), 10);
      if (p) pids.add(p);
    });
    if (helperPid) pids.delete(helperPid);
  } else {
    const out = sh(`pgrep -f '${CMD_SIGNATURES.join('|')}'`);
    out.split(/\r?\n/).forEach((l) => {
      const p = parseInt(l.trim(), 10);
      if (p) pids.add(p);
    });
  }
  return pids;
}

function killPid(pid) {
  if (DRY) {
    console.log(`[dry] would kill PID ${pid}`);
    return;
  }
  try {
    if (isWin) {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    console.log(`killed PID ${pid}`);
  } catch {
    /* already gone */
  }
}

const pids = new Set([...pidsFromPorts(), ...pidsFromCmdline()]);
pids.delete(process.pid);

if (pids.size === 0) {
  console.log(DRY ? '[dry] no bun run dev processes or port occupation found' : 'no bun run dev processes or port occupation found');
} else {
  console.log(`${DRY ? '[dry] ' : ''}found ${pids.size} process(es) to clean up:`);
  for (const p of [...pids].sort((a, b) => a - b)) killPid(p);
  console.log(`${DRY ? '[dry] ' : ''}done.`);
}
