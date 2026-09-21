// 生产构建：把 src/index.ts 打包为单文件 model-gate.js（Node 可直接运行）。
// 由 `npm run build` 调用（embed 阶段已把 admin/dist 内嵌为 src/admin-assets.generated.ts）。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  outfile: 'model-gate.js',
  // 注意：src/index.ts 首行自带 shebang，esbuild 会保留到产物顶部；此处不要再加 banner，否则双 shebang 语法错误
});
console.log('[build] 已生成 model-gate.js（node model-gate.js 可直接运行）');
