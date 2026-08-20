<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useMessage } from 'naive-ui';
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NButton,
  NSpace,
  NDivider,
  NDynamicInput,
  NAlert,
  NTag,
  NStatistic,
} from 'naive-ui';
import { getConfig, saveConfig, testConnection, type ConfigDraft } from './api';

const message = useMessage();

// ---- 编辑态（键值对象转成可编辑行）----
interface ProviderRow {
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
}
interface AliasRow {
  name: string;
  targets: string[];
}

const startup = ref<{ port: number; host: string; timeout_seconds: number; access_log: boolean }>({
  port: 8787,
  host: '127.0.0.1',
  timeout_seconds: 60,
  access_log: true,
});
const defaultModel = ref('');
const keys = ref<string[]>([]);
const providers = ref<ProviderRow[]>([]);
const aliases = ref<AliasRow[]>([]);
const loading = ref(true);
const saving = ref(false);
const loadError = ref('');

const aliasOptions = computed(() => aliases.value.map((a) => ({ label: a.name, value: a.name })));
const defaultModelOptions = computed(() => aliasOptions.value);

// 测试连接状态：providerName -> { testing, result }
const testStates = ref<Record<string, { testing: boolean; result: string; ok: boolean }>>({});

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
      name,
      base_url: p.base_url,
      api_key: p.api_key,
      models: [...p.models],
    }));
    aliases.value = Object.entries(cfg.aliases).map(([name, targets]) => ({ name, targets: [...targets] }));
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function addProvider(): void {
  providers.value.push({ name: '', base_url: '', api_key: '', models: [] });
}
function addAlias(): void {
  aliases.value.push({ name: '', targets: [] });
}

async function onTest(provider: ProviderRow): Promise<void> {
  const firstModel = provider.models[0];
  if (!firstModel) {
    message.warning('该 provider 还没有模型，先添加模型');
    return;
  }
  testStates.value[provider.name] = { testing: true, result: '', ok: false };
  try {
    const r = await testConnection(provider.name, firstModel);
    testStates.value[provider.name] = {
      testing: false,
      ok: r.ok,
      result: r.ok ? `连接成功（${r.ms}ms，模型 ${firstModel}）` : `失败：${r.error ?? `HTTP ${r.status}`}`,
    };
  } catch (e) {
    testStates.value[provider.name] = { testing: false, ok: false, result: (e as Error).message };
  }
}

async function onSave(): Promise<void> {
  saving.value = true;
  try {
    // 行 -> 键值对象（后端仍会做完整校验，这里只保证结构合法）
    const providerMap: ConfigDraft['providers'] = {};
    for (const p of providers.value) {
      if (!p.name) throw new Error('provider 名称不能为空');
      providerMap[p.name] = { base_url: p.base_url, api_key: p.api_key, models: p.models };
    }
    const aliasMap: ConfigDraft['aliases'] = {};
    for (const a of aliases.value) {
      if (!a.name) throw new Error('别名名称不能为空');
      aliasMap[a.name] = a.targets;
    }
    const draft: ConfigDraft = {
      ...startup.value,
      default_model: defaultModel.value,
      keys: keys.value,
      providers: providerMap,
      aliases: aliasMap,
    };
    await saveConfig(draft);
    message.success('已保存，热加载生效');
    await load(); // 重新拉取（密钥会重新掩码）
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div style="max-width: 900px; margin: 0 auto; padding: 24px">
    <n-space justify="space-between" align="center">
      <h2 style="margin: 0">model-gate 配置</h2>
      <n-button type="primary" :loading="saving" @click="onSave">保存</n-button>
    </n-space>
    <p style="color: #888; font-size: 12px">config.json 是唯一真相源；保存 = 校验通过后原子写回并热加载生效</p>

    <n-alert v-if="loadError" type="error" :title="'加载配置失败'" style="margin-bottom: 16px">
      {{ loadError }}
    </n-alert>

    <template v-if="!loadError">
      <n-card title="基本设置" size="small" style="margin-bottom: 16px">
        <n-space size="large">
          <n-statistic label="端口" :value="startup.port" />
          <n-statistic label="监听地址" :value="startup.host" />
          <n-statistic label="超时（秒）" :value="startup.timeout_seconds" />
          <n-statistic label="access.log" :value="startup.access_log ? '开' : '关'" />
        </n-space>
        <div style="margin-top: 12px; color: #999; font-size: 12px">
          以上为启动参数，只读展示；修改需编辑 config.json 后重启服务。
        </div>
        <n-form-item label="默认模型（agent 未指定 model 时使用）" style="margin-top: 12px">
          <n-select v-model:value="defaultModel" :options="defaultModelOptions" placeholder="选择一个别名" />
        </n-form-item>
      </n-card>

      <n-card title="下游密钥（keys，agent 连入网关用）" size="small" style="margin-bottom: 16px">
        <n-dynamic-input v-model:value="keys" placeholder="sk-xxx" />
      </n-card>

      <n-card title="上游运营商（providers）" size="small" style="margin-bottom: 16px">
        <n-space vertical>
          <div v-for="(p, i) in providers" :key="i" style="border: 1px solid #eee; border-radius: 8px; padding: 12px">
            <n-space vertical>
              <n-space justify="space-between" align="center">
                <span style="font-weight: 600">provider #{{ i + 1 }}</span>
                <n-button size="small" type="error" quaternary @click="providers.splice(i, 1)">删除</n-button>
              </n-space>
              <n-space>
                <n-form-item label="名称" style="margin-bottom: 0">
                  <n-input v-model:value="p.name" placeholder="如 deepseek" style="width: 160px" />
                </n-form-item>
                <n-form-item label="base_url" style="margin-bottom: 0; flex: 1">
                  <n-input v-model:value="p.base_url" placeholder="https://api.deepseek.com/v1" />
                </n-form-item>
              </n-space>
              <n-space align="center">
                <n-form-item label="api_key（留空保持原值）" style="margin-bottom: 0; flex: 1">
                  <n-input
                    v-model:value="p.api_key"
                    type="password"
                    show-password-on="click"
                    placeholder="留空保持原值"
                  />
                </n-form-item>
                <n-button
                  size="small"
                  :loading="testStates[p.name]?.testing"
                  :type="testStates[p.name]?.ok ? 'success' : 'default'"
                  @click="onTest(p)"
                >
                  测试连接
                </n-button>
              </n-space>
              <div v-if="testStates[p.name]?.result" style="font-size: 12px">
                <n-tag :type="testStates[p.name]?.ok ? 'success' : 'error'" size="small">
                  {{ testStates[p.name]?.result }}
                </n-tag>
              </div>
              <n-form-item label="模型列表">
                <n-dynamic-input v-model:value="p.models" placeholder="模型 id，如 deepseek-chat" style="width: 100%" />
              </n-form-item>
            </n-space>
          </div>
          <n-button size="small" @click="addProvider">+ 添加 provider</n-button>
        </n-space>
      </n-card>

      <n-card title="模型别名（aliases，agent 只认别名）" size="small" style="margin-bottom: 16px">
        <n-space vertical>
          <div v-for="(a, i) in aliases" :key="i" style="border: 1px solid #eee; border-radius: 8px; padding: 12px">
            <n-space justify="space-between" align="center">
              <span style="font-weight: 600">alias #{{ i + 1 }}</span>
              <n-button size="small" type="error" quaternary @click="aliases.splice(i, 1)">删除</n-button>
            </n-space>
            <n-space>
              <n-form-item label="别名" style="margin-bottom: 0">
                <n-input v-model:value="a.name" placeholder="如 fast" style="width: 160px" />
              </n-form-item>
            </n-space>
            <n-form-item label="目标（有序，failover 顺序，每行一个 provider:model）">
              <n-dynamic-input
                v-model:value="a.targets"
                placeholder="如 deepseek:deepseek-chat"
                style="width: 100%"
              />
            </n-form-item>
          </div>
          <n-button size="small" @click="addAlias">+ 添加别名</n-button>
        </n-space>
      </n-card>

      <n-divider />
      <n-space justify="center">
        <n-button type="primary" :loading="saving" @click="onSave">保存</n-button>
      </n-space>
    </template>
  </div>
</template>
