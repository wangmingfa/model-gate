import { defineConfig } from 'vitest/config';

// 根项目测试：仅后端 src/*.test.ts（纯 Node 环境）。
// admin/ 前端测试由 admin/package.json 自己的 vitest 配置负责。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
