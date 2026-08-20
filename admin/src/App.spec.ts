import { describe, expect, test, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import AppRoot from './AppRoot.vue';

const mockConfig = {
  port: 8787,
  host: '127.0.0.1',
  default_model: 'fast',
  timeout_seconds: 60,
  access_log: true,
  keys: ['sk-****oke'],
  providers: { mock: { base_url: 'http://127.0.0.1:9999/v1', api_key: 'sk-****ock', models: ['mock-model'] } },
  aliases: { fast: ['mock:mock-model'] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App 挂载', () => {
  test('n-message-provider 包装下挂载成功（useMessage 有祖先）', async () => {
    // stub fetch，让 onMounted 的 getConfig() 正常返回，避免 happy-dom 下未处理的 abort
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mockConfig), { status: 200 })));
    const wrapper = mount(AppRoot);
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 10)); // 等 onMounted 的 fetch 完成
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.text()).toContain('model-gate 配置');
  });
});
