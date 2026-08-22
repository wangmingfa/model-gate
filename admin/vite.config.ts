import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(async () => {
  const plugins = [vue()];

  // code-inspector-plugin 是开发期辅助插件（点击元素直达 IDE），属可选依赖。
  // 用动态 import 包 try/catch，避免其依赖（ansi-styles 等）缺失时拖垮整个 dev 服务器。
  try {
    const mod = await import('code-inspector-plugin');
    const codeInspectorPlugin = mod.codeInspectorPlugin ?? (mod as any).default;
    if (typeof codeInspectorPlugin === 'function') {
      plugins.push(codeInspectorPlugin({ bundler: 'vite' }));
    }
  } catch (e) {
    console.warn(
      '[vite] code-inspector-plugin 未加载（依赖缺失或安装不完整），已跳过：',
      (e as Error)?.message ?? e
    );
  }

  return {
    // 网关把 admin 挂在 /admin 下，资源路径必须带前缀，否则 /assets/* 404
    base: '/admin/',
    plugins,
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
  };
});
