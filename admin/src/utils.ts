/** 复制文本到剪贴板：优先 Clipboard API，不可用（非 HTTPS/localhost）时降级 execCommand */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级到 execCommand
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 密钥掩码：保留前 3 后 3，如 sk-****abc；短密钥全掩（与后端一致，避免明文展示） */
export function maskKey(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
}

/** 格式化添加时间为本地可读形式 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
