import type { Config } from './config';

/** 上游调用失败（网络错误 / 非 2xx / 超时），status 为上游 HTTP 状态码，网络错误为 null */
export class UpstreamError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** 从上游响应体里提取人类可读的错误消息（OpenAI 风格 {error:{message}} 或纯文本） */
export function extractErrorMessage(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m;
    return JSON.stringify(j).slice(0, 500);
  } catch {
    return t.slice(0, 500);
  }
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AttemptError {
  /** 形如 "provider:model" 的目标 */
  target: string;
  message: string;
  status: number | null;
}

/** token 用量容器：非流式在返回时已填好；流式在 SSE 消费过程中填充 */
export interface UsageBox {
  usage: Usage | null;
}

export interface ChatResult {
  /** 直接返回给下游的 Response（model 字段已改写为别名） */
  res: Response;
  /** 最终成功的真实模型名（"provider:model"），全部失败时为 '' */
  realModel: string;
  usageBox: UsageBox;
  errors: AttemptError[];
}

const encoder = new TextEncoder();

/**
 * 重写一行 SSE 文本：把 data 行里的 model 字段改为别名，并捕获 usage。
 * 返回要写入下游的字节；空行/注释行/[DONE] 原样透传。
 */
function rewriteSSELine(line: string, alias: string, usageBox: { usage: Usage | null }): string {
  if (line.startsWith('data:') && !line.startsWith('data: [DONE]')) {
    const payload = line.slice(5).trim();
    if (payload) {
      try {
        const j = JSON.parse(payload);
        if (j && typeof j === 'object') {
          j.model = alias;
          if (j.usage && typeof j.usage === 'object') {
            usageBox.usage = {
              prompt_tokens: j.usage.prompt_tokens,
              completion_tokens: j.usage.completion_tokens,
              total_tokens: j.usage.total_tokens,
            };
          }
          return `data: ${JSON.stringify(j)}\n`;
        }
      } catch {
        // 非 JSON 的 data 行（极少见），原样透传
      }
    }
  }
  return line === '' ? '\n' : `${line}\n`;
}

/**
 * 把上游 SSE 流包成下游 ReadableStream：逐行改写 model 字段、捕获 usage、
 * 并实现"空闲超时"（无数据超过 idleMs 毫秒则断开下游）。
 */
export function wrapSSEStream(
  upstream: ReadableStream<Uint8Array>,
  alias: string,
  idleMs: number,
): { stream: ReadableStream<Uint8Array>; usageBox: UsageBox } {
  const reader = upstream.getReader();
  const usageBox: UsageBox = { usage: null };
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  // controller 只能被 error/close 终止一次；空闲超时已 error 后若再 close 会抛 TypeError。
  // 用 terminated 守卫保证 error/close 至多执行一次，避免重复终止引发的异常。
  let terminated = false;
  const end = (fn: () => void) => {
    if (terminated) return;
    terminated = true;
    fn();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      timer = setInterval(() => {
        if (Date.now() - lastActivity > idleMs) {
          clearInterval(timer!);
          reader.cancel().catch(() => {});
          end(() => controller.error(new Error(`upstream 流式空闲超时（${idleMs}ms 无数据）`)));
        }
      }, 1000);

      const decoder = new TextDecoder();
      let lineBuf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();
          lineBuf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx);
            lineBuf = lineBuf.slice(idx + 1);
            controller.enqueue(encoder.encode(rewriteSSELine(line, alias, usageBox)));
          }
        }
        if (lineBuf.length > 0) {
          controller.enqueue(encoder.encode(rewriteSSELine(lineBuf, alias, usageBox)));
        }
        end(() => controller.close());
      } catch (e) {
        end(() => controller.error(e));
      } finally {
        if (timer) clearInterval(timer);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return { stream, usageBox };
}

interface TargetRef {
  providerName: string;
  model: string;
}

/** 解析 "provider:model"（provider 名允许含冒号吗？不允许——分隔取第一个冒号） */
function parseTarget(target: string): TargetRef {
  const sep = target.indexOf(':');
  return { providerName: target.slice(0, sep), model: target.slice(sep + 1) };
}

/**
 * 按别名做有序 failover 的 chat/completions 调用。
 * 逐个尝试 aliases[alias] 的目标；网络错误/超时/非 2xx 都切下一个。
 * 全部失败时返回聚合错误（最后一个 4xx 沿用其状态码，否则 502）。
 * stream: true 时只有"未拿到 200 之前"的失败才切换；一旦开始推流即提交。
 */
export async function chatWithFailover(
  cfg: Config,
  alias: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  const targets = cfg.aliases[alias];
  const errors: AttemptError[] = [];
  const timeoutMs = cfg.timeout_seconds * 1000;
  const isStream = body.stream === true;

  for (const target of targets) {
    const { providerName, model } = parseTarget(target);
    const provider = cfg.providers[providerName];
    const upstreamBody = { ...body, model };
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.api_key}`,
    };
    const url = `${provider.base_url}/chat/completions`;

    // 流式：仅限制"等到响应头"的时间（header 一到就清除，SSE body 不设整体超时）
    let headerController: AbortController | null = null;
    let headerTimer: ReturnType<typeof setTimeout> | null = null;
    if (isStream) {
      headerController = new AbortController();
      headerTimer = setTimeout(() => headerController?.abort(), timeoutMs);
    }

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: isStream ? headerController!.signal : AbortSignal.timeout(timeoutMs),
      });
      if (headerTimer) clearTimeout(headerTimer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new UpstreamError(extractErrorMessage(text) ?? `upstream ${res.status} ${res.statusText}`, res.status);
      }

      if (isStream && res.body) {
        const { stream, usageBox } = wrapSSEStream(res.body, alias, timeoutMs);
        return {
          res: new Response(stream, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            },
          }),
          realModel: `${providerName}:${model}`,
          usageBox,
          errors,
        };
      }

      const j: unknown = await res.json().catch(() => null);
      if (!j || typeof j !== 'object') {
        throw new UpstreamError('upstream 返回了非 JSON 响应体');
      }
      const json = j as Record<string, unknown>;
      json.model = alias; // 非流式响应改写 model
      const usageBox: UsageBox = {
        usage: (json.usage && typeof json.usage === 'object' ? json.usage : null) as Usage | null,
      };
      return {
        res: new Response(JSON.stringify(json), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        realModel: `${providerName}:${model}`,
        usageBox,
        errors,
      };
    } catch (e) {
      // 网络错误、超时、非 2xx 都视为该目标失败，继续 failover
      errors.push({
        target,
        message: e instanceof Error ? e.message : typeof e === 'object' && e !== null && 'message' in e ? String((e as Record<string, unknown>).message) : String(e),
        status: e instanceof UpstreamError ? e.status : null,
      });
      continue;
    }
  }

  // 全部失败
  const last = errors[errors.length - 1];
  const status = last?.status && last.status >= 400 && last.status < 500 ? last.status : 502;
  const detail = errors.map((e) => `${e.target}: ${e.message}`).join('; ');
  const bodyErr = {
    error: {
      message: `别名 "${alias}" 的所有 provider 都失败了（${errors.length} 个目标）: ${detail}`,
      type: 'upstream_error',
      code: 'upstream_failed',
    },
  };
  return {
    res: new Response(JSON.stringify(bodyErr), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
    realModel: '',
    usageBox: { usage: null },
    errors,
  };
}
