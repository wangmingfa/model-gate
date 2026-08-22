// dev 模式下确保 src/admin-assets.generated.ts 存在，避免 dev:api 因
// 顶层 import 找不到该模块而崩溃（另一台电脑 clone 后直接 bun run dev 报
// Cannot find module './admin-assets.generated'）。
//
// 该文件是 build 时由 scripts/embed-assets.ts 生成的真实内嵌产物；dev 不需要
// 内嵌（前端由 Vite 直接托管，serveSpa 走磁盘 admin/dist），所以这里只生成一个
// 空壳：导出同形态的空 Record，import 不再报错，且 serveSpa 的 embedded 分支
// 落到 undefined 自然回退到磁盘 dist。
//
// 仅在文件不存在时才写，避免覆盖 build 生成的真实内嵌文件。
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(import.meta.dir, '../src/admin-assets.generated.ts');

if (!existsSync(OUT)) {
  const content = `// dev 空壳：由 scripts/ensure-admin-assets.ts 自动生成（仅 dev 用，生产由 embed 生成真实内嵌）
// 此文件已被 .gitignore 忽略，不会进版本库。
export const adminAssets: Record<string, string> = {};
`;
  writeFileSync(OUT, content, 'utf-8');
  console.log('[dev] 已生成空的 src/admin-assets.generated.ts（dev 走磁盘 admin/dist）');
}
