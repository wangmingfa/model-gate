import { ref, computed, provide, inject, reactive } from 'vue';
import { useMessage, useDialog } from 'naive-ui';
import type { InjectionKey, UnwrapNestedRefs } from 'vue';
import {
  getConfig,
  saveConfig,
  testConnection,
  fetchModels,
  generateKey,
  checkConfig,
  type ConfigDraft,
  type ClientKeyDraft,
  type ConfigIssue,
} from './api';
import { copyText } from './utils';

// ---- 编辑态（键值对象转成可编辑行）----
export interface ProviderRow {
  /** 行级稳定 ID（本地生成，与 name 无关）：用作 v-for :key 与折叠面板 name，
   *  避免编辑 name 时 key 变化导致 Vue 重建 DOM、输入框每敲一个字符就失焦 */
  _id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}
export interface AliasRow {
  /** 行级稳定 ID（本地生成，与 name 无关）：折叠面板 name 与 v-for key，防改名失焦 */
  _id: string;
  name: string;
  targets: string[];
}

/** 检查结果里的错误 target -> 所属版块：查出错误后自动跳过去看标红 */
export function sectionOfTarget(target?: string): string | null {
  if (!target) return null;
  if (target.startsWith('provider:')) return 'providers';
  if (target.startsWith('alias:')) return 'aliases';
  if (target === 'default_model') return 'basic';
  if (target === 'keys') return 'keys';
  return null;
}

/** 配置编辑核心 store：所有版块共享的编辑态 + 自动保存 + 体检逻辑。
 *  message/dialog 依赖 naive-ui provider，只能在 setup 中创建（见 provideConfigStore）。 */
function createConfigStore(message: ReturnType<typeof useMessage>, dialog: ReturnType<typeof useDialog>) {
  const startup = ref<{ port: number; host: string; timeout_seconds: number; access_log: boolean }>({
    port: 8787,
    host: '127.0.0.1',
    timeout_seconds: 60,
    access_log: true,
  });
  const defaultModel = ref('');
  const keys = ref<ClientKeyDraft[]>([]);
  const newKeyName = ref(''); // 添加密钥时填写的名称
  // 新密钥弹窗（完整密钥只在弹窗中展示一次）
  const showNewKeyModal = ref(false);
  const pendingKeyName = ref('');
  const pendingKeyValue = ref('');
  const providers = ref<ProviderRow[]>([]);
  const aliases = ref<AliasRow[]>([]);
  const loading = ref(true);
  const saving = ref(false);
  const loadError = ref('');

  // 配置体检：检查结果的错误/告警列表；checkIssues 非空即代表已做过检查
  const checking = ref(false);
  const checkIssues = ref<ConfigIssue[] | null>(null);
  // 由检查结果推导出的「需要标红的字段集合」
  const erroredProviders = computed(
    () => new Set((checkIssues.value ?? []).filter((i) => i.target?.startsWith('provider:')).map((i) => i.target!.slice('provider:'.length))),
  );
  const erroredAliases = computed(
    () => new Set((checkIssues.value ?? []).filter((i) => i.target?.startsWith('alias:')).map((i) => i.target!.slice('alias:'.length))),
  );
  const defaultModelError = computed(() => (checkIssues.value ?? []).some((i) => i.target === 'default_model'));

  const aliasOptions = computed(() => aliases.value.map((a) => ({ label: a.name, value: a.name })));
  const defaultModelOptions = computed(() => aliasOptions.value);

  /** agent 用的 Base URL：admin 与网关同源部署，取浏览器 hostname + 配置端口（开发模式下
   *  页面跑在 5173，但 API 在配置端口上，不能用 location.port）；scheme 跟随当前页面
   *  （本机直连是 http，若经 https 反代访问则用 https） */
  const apiBaseUrl = computed(() => {
    const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
    return `${scheme}://${window.location.hostname}:${startup.value.port}/v1`;
  });

  // 测试连接状态：providerName -> { testing, result }
  const testStates = ref<Record<string, { testing: boolean; result: string; ok: boolean }>>({});
  // 拉取模型状态：providerName -> { fetching, result }（与 testStates 共用错误展示区）
  const fetchStates = ref<Record<string, { fetching: boolean; result: string; ok: boolean }>>({});

  // 行级 ID 生成器（仅前端追踪用，不进配置草稿；provider/alias 共用一个序列即可）
  let rowSeq = 0;
  function nextRowId(): string {
    return `row-${++rowSeq}`;
  }

  async function load(): Promise<void> {
    loading.value = true;
    loadError.value = '';
    try {
      const cfg = await getConfig();
      startup.value = {
        port: cfg.port,
        host: cfg.host,
        timeout_seconds: cfg.timeout_seconds,
        access_log: cfg.access_log,
      };
      defaultModel.value = cfg.default_model;
      keys.value = [...cfg.keys];
      providers.value = Object.entries(cfg.providers).map(([name, p]) => ({
        _id: nextRowId(),
        name,
        base_url: p.base_url,
        // 直接回填真实 api_key：输入框是 password 类型，明文被遮挡不可见；
        // 清空框保存时后端 resolveApiKey 仍按「保持原值」处理（不会误删），填新值则覆盖。
        api_key: p.api_key,
        models: [...p.models],
      }));
      // 服务端 aliases 的 value 是单个 "provider:model" 字符串（兼容个别历史数组写法）
      aliases.value = Object.entries(cfg.aliases).map(([name, targets]) => ({
        _id: nextRowId(),
        name,
        targets: Array.isArray(targets) ? [...targets] : [targets],
      }));
    } catch (e) {
      loadError.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function addProvider(): void {
    providers.value.push({ _id: nextRowId(), name: '', base_url: '', api_key: '', models: [] });
  }
  function addAlias(): void {
    aliases.value.push({ _id: nextRowId(), name: '', targets: [] });
  }

  async function copyApiBaseUrl(): Promise<void> {
    if (await copyText(apiBaseUrl.value)) message.success('API 地址已复制到剪贴板');
    else message.error('复制失败，请手动选择复制');
  }

  /** 添加密钥：填名称 → 自动生成 sk- + 32 位随机十六进制密钥，并立即保存（完整密钥只在弹窗中展示一次） */
  async function addKey(): Promise<void> {
    const name = newKeyName.value.trim();
    if (!name) {
      message.warning('请先填写密钥名称');
      return;
    }
    if (keys.value.some((k) => k.name === name)) {
      message.warning(`名称 "${name}" 已存在`);
      return;
    }
    const newKey: ClientKeyDraft = { name, key: generateKey(), created_at: new Date().toISOString() };
    keys.value.push(newKey);
    newKeyName.value = '';
    await autoSave({ successMsg: `已生成密钥 ${name} 并保存` });
    // 保存失败时 autoSave 已回滚；成功则弹窗展示完整密钥（一次性，供复制）
    if (!keys.value.includes(newKey)) return;
    pendingKeyName.value = newKey.name;
    pendingKeyValue.value = newKey.key;
    showNewKeyModal.value = true;
  }

  /** 弹窗中的"复制"按钮 */
  async function copyPendingKey(): Promise<void> {
    if (await copyText(pendingKeyValue.value)) message.success('完整密钥已复制到剪贴板');
    else message.error('复制失败，请手动选择复制');
  }

  /** 复制完整密钥到剪贴板（后端返回原始值；列表显示时掩码，复制时用完整值） */
  async function copyKey(key: string): Promise<void> {
    if (await copyText(key)) message.success('完整密钥已复制到剪贴板');
    else message.error('复制失败，请手动选择复制');
  }

  /** 删除密钥（已有密钥只读，只能删除），并立即保存 */
  async function removeKey(index: number): Promise<void> {
    const removed = keys.value[index];
    dialog.warning({
      title: '确认删除',
      content: `确认删除密钥「${removed.name}」吗？此操作不可撤销。`,
      positiveText: '删除',
      negativeText: '取消',
      async onPositiveClick() {
        keys.value.splice(index, 1);
        await autoSave({ successMsg: `已删除密钥 ${removed.name} 并保存` });
      },
    });
  }

  /** 删除 provider：仅弹确认框，实际删除 + 保存由版块 onSave 负责（删除已存在行不会触发空壳校验） */
  function removeProviderConfirm(name: string, onConfirm: () => void | Promise<void>): void {
    dialog.warning({
      title: '确认删除',
      content: `确认删除 provider「${name}」吗？此操作不可撤销。`,
      positiveText: '删除',
      negativeText: '取消',
      async onPositiveClick() {
        await onConfirm();
      },
    });
  }

  /** 删除别名：仅弹确认框，实际删除 + 保存由版块 onSave 负责 */
  function removeAliasConfirm(name: string, onConfirm: () => void | Promise<void>): void {
    dialog.warning({
      title: '确认删除',
      content: `确认删除别名「${name}」吗？此操作不可撤销。`,
      positiveText: '删除',
      negativeText: '取消',
      async onPositiveClick() {
        await onConfirm();
      },
    });
  }

  async function onTest(provider: ProviderRow): Promise<void> {
    const firstModel = provider.models[0];
    if (!firstModel) {
      message.warning('该 provider 还没有模型，先添加模型');
      return;
    }
    testStates.value[provider.name] = { testing: true, result: '', ok: false };
    try {
      // 把当前草稿（未保存的 base_url / api_key）一并传过去：优先测草稿值，空则后端回退服务端真实配置
      const r = await testConnection(provider.name, firstModel, {
        base_url: provider.base_url,
        api_key: provider.api_key,
      });
      testStates.value[provider.name] = {
        testing: false,
        ok: r.ok,
        result: r.ok ? `连接成功（${r.ms}ms，模型 ${firstModel}）` : `失败：${r.error ?? `HTTP ${r.status}`}`,
      };
    } catch (e) {
      testStates.value[provider.name] = { testing: false, ok: false, result: (e as Error).message };
    }
  }

  /** 一键拉取上游模型列表并回填到该 provider 的 models 字段（草稿优先、服务端回退；
   *  与现有手动添加项去重合并，不覆盖用户已填内容）。无需先保存配置。 */
  async function onFetchModels(provider: ProviderRow): Promise<void> {
    if (!provider.base_url.trim()) {
      message.warning('请先填写 base_url（留空无法拉取）');
      return;
    }
    fetchStates.value[provider.name] = { fetching: true, result: '', ok: false };
    try {
      const r = await fetchModels(provider.name, {
        base_url: provider.base_url,
        api_key: provider.api_key,
      });
      if (!r.ok || !r.models) {
        fetchStates.value[provider.name] = {
          fetching: false,
          ok: false,
          result: `拉取失败：${r.error ?? `HTTP ${r.status}`}`,
        };
        return;
      }
      // 去重合并：保留已有 + 追加上游返回的新 id（顺序：已有在前，新查到的在后）
      const seen = new Set(provider.models);
      let added = 0;
      for (const m of r.models) {
        if (!seen.has(m)) {
          seen.add(m);
          provider.models.push(m);
          added++;
        }
      }
      fetchStates.value[provider.name] = {
        fetching: false,
        ok: true,
        result: added > 0 ? `已拉取并新增 ${added} 个模型（共 ${provider.models.length}）` : `无新增（${provider.models.length} 个模型均已存在）`,
      };
    } catch (e) {
      fetchStates.value[provider.name] = { fetching: false, ok: false, result: (e as Error).message };
    }
  }

  /** 由当前编辑态构造完整配置草稿（保存用） */
  function buildDraft(): ConfigDraft {
    const providerMap: ConfigDraft['providers'] = {};
    for (const p of providers.value) {
      if (!p.name) throw new Error('provider 名称不能为空');
      providerMap[p.name] = { base_url: p.base_url, api_key: p.api_key, models: p.models };
    }
    const aliasMap: ConfigDraft['aliases'] = {};
    for (const a of aliases.value) {
      if (!a.name) throw new Error('别名名称不能为空');
      // 服务端 aliases 的 value 是 "provider:model" 字符串数组（顺序即 failover 顺序）；
      // 前端用「单选 select + 添加按钮」可加多个目标，数组顺序即 failover 优先级。
      aliasMap[a.name] = a.targets;
    }
    return {
      ...startup.value,
      default_model: defaultModel.value,
      keys: keys.value,
      providers: providerMap,
      aliases: aliasMap,
    };
  }

  /** 任意字段变更后自动保存（失焦/变更触发）；成功即落盘，失败仅报错、保留本地编辑
   *  （不 load() 回滚：后端是原子写，校验失败不会改动磁盘，服务端仍是旧值；
   *   若回滚会用旧值覆盖用户正在编辑的内容，导致白改。让用户改完错误再保存即可） */
  async function autoSave(opts?: { silent?: boolean; successMsg?: string }): Promise<void> {
    saving.value = true;
    try {
      await saveConfig(buildDraft());
      if (opts?.successMsg) message.success(opts.successMsg);
      checkIssues.value = null; // 配置已变动，上一轮体检结果作废（重新检查才更新标红）
      // 成功不重新拉取：避免覆盖用户正在进行的其他编辑（连续输入/多字段同时改）
    } catch (e) {
      // 失败不回滚本地编辑（保留用户当前屏幕内容）；仅展示错误
      if (!opts?.silent) message.error(`保存失败：${(e as Error).message}`);
    } finally {
      saving.value = false;
    }
  }

  // 高频变更（动态列表逐项输入）用 400ms debounce，避免逐字符并发 PUT 造成的竞态/覆盖
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutoSave(opts?: { silent?: boolean; successMsg?: string }): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void autoSave(opts);
    }, 400);
  }

  /** 版块显式保存：由各版块「保存」按钮调用。由调用方先把本地草稿写回 store 再调用，
   *  这里统一走 buildDraft + saveConfig；失败仅报错、不回滚（保留本地编辑，让用户改完再存）。
   *  调用方在失败时也不应再用 store 覆盖自己的草稿。 */
  async function saveSection(opts?: { successMsg?: string }): Promise<void> {
    saving.value = true;
    try {
      await saveConfig(buildDraft());
      if (opts?.successMsg) message.success(opts.successMsg);
      checkIssues.value = null; // 配置已变动，上一轮体检结果作废（重新检查才更新标红）
    } catch (e) {
      // 失败不 load() 回滚：后端原子写，校验失败不动磁盘，服务端仍是旧值；
      // 回滚会用旧值覆盖用户编辑内容。仅展示错误，保留当前屏幕内容。
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      saving.value = false;
    }
  }

  /** 检查配置正确性：对服务端当前运行配置体检，结果用于页面标红与报告；返回 error 级问题（供导航跳转） */
  async function runCheck(): Promise<ConfigIssue[]> {
    checking.value = true;
    try {
      const r = await checkConfig();
      checkIssues.value = r.issues;
      const errors = r.issues.filter((i) => i.level === 'error');
      if (errors.length === 0) {
        if (r.issues.length === 0) message.success('配置完全正确');
        else message.success('未发现错误（仅有提示项）');
      } else {
        message.error(`发现 ${errors.length} 个错误，已在页面中标红`);
      }
      return errors;
    } catch (e) {
      message.error(`检查失败：${(e as Error).message}`);
      return [];
    } finally {
      checking.value = false;
    }
  }

  return {
    // 编辑态
    startup,
    defaultModel,
    keys,
    newKeyName,
    showNewKeyModal,
    pendingKeyName,
    pendingKeyValue,
    providers,
    aliases,
    loading,
    saving,
    loadError,
    // 体检
    checking,
    checkIssues,
    erroredProviders,
    erroredAliases,
    defaultModelError,
    // 派生
    aliasOptions,
    defaultModelOptions,
    apiBaseUrl,
    testStates,
    fetchStates,
    // 动作
    load,
    addProvider,
    addAlias,
    copyApiBaseUrl,
    addKey,
    copyPendingKey,
    copyKey,
    removeKey,
    removeProviderConfirm,
    removeAliasConfirm,
    onTest,
    onFetchModels,
    autoSave,
    scheduleAutoSave,
    saveSection,
    runCheck,
  };
}

/** reactive 包装后的 store 类型（refs 已解包，模板/子组件直接用 store.xxx） */
export type ConfigStore = UnwrapNestedRefs<ReturnType<typeof createConfigStore>>;

export const configStoreKey: InjectionKey<ConfigStore> = Symbol('config-store');

/** 在 App.vue setup 中调用：创建 store（含 message/dialog 绑定）并 provide 给各版块子组件 */
export function provideConfigStore(): ConfigStore {
  const store = reactive(createConfigStore(useMessage(), useDialog()));
  provide(configStoreKey, store);
  return store;
}

/** 各版块子组件取共享编辑态 */
export function useConfigStore(): ConfigStore {
  const s = inject(configStoreKey);
  if (!s) throw new Error('config store 未 provide（需在 App.vue setup 中调用 provideConfigStore）');
  return s;
}
