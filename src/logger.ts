import { appendFileSync } from 'node:fs';
import type { UsageBox } from './providers';

/** 一条请求记录（access log 与控制台摘要共用） */
export interface LogRecord {
  ts: string;
  method: string;
  path: string;
  /**
   * 最终状态码；流式请求在流结束前可能为 0（"pending" 阶段），
   * 下游监控工具可用 `status === 0 && stream === true` 过滤掉。
   */
  status: number;
  ms: number;
  key?: string;
  alias?: string;
  realModel?: string;
  stream?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 流式请求的 token 用量在流消费完才确定，用 WeakMap 挂在记录上（不参与 JSON 序列化） */
const usageBoxes = new WeakMap<LogRecord, UsageBox>();

export function setUsageBox(rec: LogRecord, box: UsageBox): void {
  usageBoxes.set(rec, box);
}

/** 把容器里已填充的用量拷贝到记录字段上（写日志前调用） */
export function applyUsageBox(rec: LogRecord): void {
  const box = usageBoxes.get(rec);
  if (!box?.usage) return;
  rec.promptTokens = box.usage.prompt_tokens ?? rec.promptTokens;
  rec.completionTokens = box.usage.completion_tokens ?? rec.completionTokens;
  rec.totalTokens = box.usage.total_tokens ?? rec.totalTokens;
}

let accessEnabled = true;
let accessPath = 'access.log';

/** 由入口在配置加载/热加载时调用 */
export function configureLogging(enabled: boolean, path?: string): void {
  accessEnabled = enabled;
  if (path) accessPath = path;
}

/** 追加一条 JSONL 记录到 access.log；写入失败静默（不拖垮请求） */
export function writeAccessLog(r: LogRecord): void {
  if (!accessEnabled) return;
  try {
    appendFileSync(accessPath, JSON.stringify(r) + '\n');
  } catch {
    // ignore
  }
}

/** 控制台单行摘要 */
export function consoleSummary(r: LogRecord): void {
  const extra = [
    r.key && `key=${r.key}`,
    r.alias && `alias=${r.alias}`,
    r.realModel && `model=${r.realModel}`,
    r.totalTokens != null && `tokens=${r.totalTokens}`,
    r.stream && 'stream',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[${r.ts}] ${r.method} ${r.path} ${r.status} ${r.ms}ms${extra ? ' ' + extra : ''}`);
}
