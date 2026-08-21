import { describe, expect, test, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import AppRoot from './AppRoot.vue';

const mockConfig = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: true,
  keys: [{ name: 'claude', key: 'sk-****oke', created_at: '2026-01-01T00:00:00.000Z' }],
  providers: {
    deepseek: { base_url: 'http://127.0.0.1:9999/v1', api_key: 'sk-****ock', models: ['mock-model'] },
    kimi: { base_url: 'http://127.0.0.1:9998/v1', api_key: 'sk-****kim', models: ['moon'] },
  },
  aliases: { fast: ['deepseek:mock-model'] },
};

function mountApp(): ReturnType<typeof mount> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth-status')) {
        return new Response(JSON.stringify({ passwordConfigured: true, configPath: 'config.json', loggedIn: true }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    }),
  );
  return mount(AppRoot);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider 折叠（n-collapse）', () => {
  test('默认全部展开，点击头部可折叠/再展开', async () => {
    const wrapper = mountApp();
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const items = wrapper.findAll('.n-collapse-item');
    expect(items.length).toBe(2);
    // 默认全部展开：都有 --active 状态类
    expect(items.every((it) => it.classes().includes('n-collapse-item--active'))).toBe(true);

    // 点第一个头部（naive-ui 绑定在 __header-main 子元素上）→ 折叠
    await items[0].find('.n-collapse-item__header-main').trigger('click');
    await wrapper.vm.$nextTick();
    const after = wrapper.findAll('.n-collapse-item');
    expect(after[0].classes().includes('n-collapse-item--active')).toBe(false);
    expect(after[1].classes().includes('n-collapse-item--active')).toBe(true);

    // 再点一次 → 展开
    await after[0].find('.n-collapse-item__header-main').trigger('click');
    await wrapper.vm.$nextTick();
    const restored = wrapper.findAll('.n-collapse-item');
    expect(restored.every((it) => it.classes().includes('n-collapse-item--active'))).toBe(true);
  });
});
