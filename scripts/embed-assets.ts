// 把 admin/dist 的构建产物（index.html + assets/*）内嵌为一个 TS 模块，
// 供 src/admin.ts 从内存读取（单文件打包 bun xxx.js 时无需依赖磁盘 dist）。
// 用法: bun scripts/embed-assets.ts   → 生成 src/admin-assets.generated.ts
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = join(import.meta.dir, '../admin/dist');
const OUT = join(import.meta.dir, '../src/admin-assets.generated.ts');

/** 递归收集 dist 下所有文件（相对路径 -> 内容） */
function collect(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      Object.assign(out, collect(full));
    } else {
      out[relative(DIST, full).split('\\').join('/')] = readFileSync(full, 'utf-8');
    }
  }
  return out;
}

const assets = collect(DIST);
if (Object.keys(assets).length === 0) {
  console.error('[embed-assets] admin/dist 为空，请先运行 bun run build:admin');
  process.exit(1);
}

const entries = Object.entries(assets)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join('\n');

const content = `// 由 scripts/embed-assets.ts 自动生成，勿手改（重新构建 admin 后需重新生成）
export const adminAssets: Record<string, string> = {
${entries}
};
`;

writeFileSync(OUT, content, 'utf-8');
console.log(`[embed-assets] 已生成 ${OUT}（${Object.keys(assets).length} 个文件，${(content.length / 1024).toFixed(1)}KB）`);
