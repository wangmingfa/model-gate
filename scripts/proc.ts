// 脚本共用的 Node 子进程封装（替代原 Bun.spawn）。
// Windows 下 npm/npx 是 .cmd，需显式补后缀；其余（git/node 等）直接用。
import { spawn } from 'node:child_process';

export function toCmd(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  if (cmd === 'npm') return 'npm.cmd';
  if (cmd === 'npx') return 'npx.cmd';
  return cmd;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 执行命令并捕获输出（不进 shell，参数数组原样传递） */
export function runCapture(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolveP) => {
    const p = spawn(toCmd(cmd), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('error', (e) => resolveP({ code: -1, stdout, stderr: stderr + String(e) }));
    p.on('close', (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

/** 执行命令并继承父进程 stdio（交互式命令用），返回退出码 */
export function runInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(toCmd(cmd), args, { stdio: 'inherit' });
    p.on('error', rejectP);
    p.on('close', (code) => resolveP(code ?? -1));
  });
}
