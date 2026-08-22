import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { codeInspectorPlugin } from 'code-inspector-plugin';

export default defineConfig({
  plugins: [
    vue(),
    codeInspectorPlugin({
      bundler: 'vite',
    }),
  ],
  // 网关把 admin 挂在 /admin 下，资源路径必须带前缀，否则 /assets/* 404
  base: '/admin/',
  server: {
    host: true, // 允许局域网/域名访问 5173（远程热更新）；无鉴权，仅开发期使用
    port: 5173,
    proxy: {
      // 开发时把管理 API 代理到网关端口
      '/admin/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
