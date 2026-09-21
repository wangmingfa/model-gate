import os from 'node:os';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// bun 在 Windows 上对非 ASCII 网卡名（如“以太网 2”）会按 Latin-1 误解 UTF-8 字节，
// vite 启动横幅照打就出现乱码（ä»¥å¤ªç½）。这里识别并修复后再交给 vite 打印。
const looksMojibake = (s: string) => /[^\x00-\x7f]/.test(s) && !/[^\x00-\xff]/.test(s);
const networkInterfaces = os.networkInterfaces.bind(os);
os.networkInterfaces = (...args: Parameters<typeof networkInterfaces>) => {
  const result = networkInterfaces(...args);
  for (const name of Object.keys(result)) {
    if (!looksMojibake(name)) continue;
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (fixed !== name && !fixed.includes('\ufffd')) {
      result[fixed] = result[name];
      delete result[name];
    }
  }
  return result;
};

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
      strictPort: true, // 端口被占用时直接报错退出，而不是自动切到 5174 等其它端口
      proxy: {
        // 开发时把管理 API 代理到网关端口；延迟探测类长请求需放宽代理超时
        '/admin/api': {
          target: 'http://127.0.0.1:8787',
          proxyTimeout: 180000,
          timeout: 180000,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
