<script setup lang="ts">
import { ref, watch } from 'vue';
import { NCard, NButton, NSpace, NCollapse, NCollapseItem, NForm, NFormItem, NInput, NTag, NIcon, NInputNumber, NTooltip } from 'naive-ui';
import { ServerOutline, SaveOutline, SwapVerticalOutline } from '@vicons/ionicons5';
import { useConfigStore, type ProviderRow } from '../../configStore';
import ItemCard from '../ItemCard.vue';
import SortableList from '../SortableList.vue';
import { type ProviderLatency } from '../../api';

const store = useConfigStore();

// 本地草稿：深拷贝，编辑不实时落盘；点「保存」才写回 store 并落盘
const draft = ref<ProviderRow[]>(JSON.parse(JSON.stringify(store.providers)));
// 折叠状态用本地驱动（默认全展开）
const expandedNames = ref<string[]>(draft.value.map((p) => p._id));

// 行级 ID 生成器（与 store 同款，仅前端追踪用）
let rowSeq = 0;
function nextRowId(): string {
  return `row-${++rowSeq}`;
}

function addProvider(): void {
  const id = nextRowId();
  draft.value.push({ _id: id, name: '', base_url: '', api_key: '', models: [], modelRowIds: [] });
  expandedNames.value.push(id); // 新行默认展开
}

// store.providers 由 load() 异步填充；首次有数据时把草稿同步过来（用户尚未编辑则覆盖，
// 已编辑则不覆盖，避免丢失进行中的改动）。解决「setup 时 store 还是空数组」的竞态。
watch(
  () => store.providers,
  (val) => {
    if (val.length && draft.value.length === 0) {
      draft.value = JSON.parse(JSON.stringify(val));
      expandedNames.value = draft.value.map((p) => p._id);
    }
  },
  { deep: false },
);
function removeProvider(index: number): void {
  const name = draft.value[index].name || `#${index + 1}`;
  store.removeProviderConfirm(name, async () => {
    draft.value.splice(index, 1);
    await onSave();
  });
}

async function onSave(): Promise<void> {
  // 写回 store（深拷贝，避免草稿与 store 共享引用）
  store.providers = JSON.parse(JSON.stringify(draft.value));
  await store.saveSection({ successMsg: '提供商已保存' });
  // 同步草稿：失败也不丢内容——saveSection 不再 load 回滚，store.providers 仍是刚写入的草稿拷贝
  draft.value = JSON.parse(JSON.stringify(store.providers));
}

/** 初始化该 provider 的单价表（按当前模型列表建 {prompt,completion}），保留已有值 */
function initPricing(p: ProviderRow): void {
  const next: Record<string, { prompt: number; completion: number }> = {};
  for (const m of p.models) {
    next[m] = { prompt: p.pricing?.[m]?.prompt ?? 0, completion: p.pricing?.[m]?.completion ?? 0 };
  }
  p.pricing = next;
}
function clearPricing(p: ProviderRow): void {
  p.pricing = undefined;
}
/** 取某模型在当前 provider 逐模型测试中的结果；结果一到达即返回（即便整批仍在测试中），
 *  以便已完成行实时露出可用/不可用标签。无结果返回 undefined。 */
function modelResult(p: ProviderRow, model: string): ProviderLatency | undefined {
  const entry = store.modelTests[p.name];
  if (!entry) return undefined;
  return entry.results.find((r) => r.model === model);
}

/** 该 provider 是否正在「测试所有模型」（整批探测进行中）。仅此态锁定列表编辑与操作。 */
function listTesting(p: ProviderRow): boolean {
  return !!store.modelTests[p.name]?.testing;
}

/** 正在探测、尚未返回结果的模型集合（用于 SortableList 的 pendingItems，给这些行铺缓冲条）。
 *  已返回结果的模型不在其中，立即展示标签。 */
function pendingModels(p: ProviderRow): string[] {
  if (!listTesting(p)) return [];
  const done = new Set(store.modelTests[p.name]!.results.map((r) => r.model));
  return p.models.filter((m) => !done.has(m));
}

/** 按「测试所有模型」的延迟结果对模型列表排序：延迟升序（快→慢），未测/不可用的模型沉到末尾（保持原有相对顺序）。
 *  同时按相同置换重排 modelRowIds，保证行 key 与模型对齐，排序动画（FLIP）正确跟手。 */
function onSortByLatency(p: ProviderRow): void {
  const results = store.modelTests[p.name]?.results;
  if (!results || !results.length) return;
  const msOf = new Map<string, number>();
  for (const r of results) {
    // 不可用（ok:false）/ 缺 ms 的记为 +∞，沉到末尾
    msOf.set(r.model, r.ok && typeof r.ms === 'number' ? r.ms : Number.POSITIVE_INFINITY);
  }
  const INF = Number.POSITIVE_INFINITY;
  const order = p.models
    .map((_, i) => i)
    .sort((a, b) => (msOf.get(p.models[a]) ?? INF) - (msOf.get(p.models[b]) ?? INF));
  const ids = p.modelRowIds ?? [];
  p.models = order.map((i) => p.models[i]);
  p.modelRowIds = order.map((i) => ids[i]);
}

// 基于实测结果给出友好解读（不靠模型名猜测类型，完全依据上游真实返回）
function friendlyReason(r: ProviderLatency): string {
  if (r.ok) return '可用';
  // 网络层不可达 / 超时：pingOnce 已把 message 写成可读中文
  if (r.status == null) return r.error || '未知错误';
  switch (r.status) {
    case 404:
      return 'chat 接口返回 404：该模型在此端点不可用。可能是图像生成 / embeddings 等非对话模型，也可能是模型名拼写有误。';
    case 401:
    case 403:
      return '鉴权失败（401/403）：API Key 无效，或该 Key 无此模型权限。';
    case 429:
      return '触发限流（429）：请求过于频繁或配额已耗尽，稍后重试。';
    case 400:
      return '请求被拒（400）：模型名或参数可能不被该端点接受。';
    default:
      if (r.status >= 500) return `上游服务异常（${r.status}），可稍后重试。`;
      return `请求失败（${r.status}）。`;
  }
}
</script>

<template>
  <n-card size="small" class="soft-card has-sticky-actions">
    <template #header>
      <span class="card-title"><n-icon :size="16"><ServerOutline /></n-icon> 提供商（providers）</span>
    </template>
    <n-space vertical>
      <n-collapse v-model:expanded-names="expandedNames">
        <n-collapse-item v-for="(p, i) in draft" :key="p._id" :name="p._id" arrow-placement="left">
          <template #header>
            <span style="font-weight: 600">
              provider #{{ i + 1 }}
              <span v-if="p.name" style="font-weight: 400; color: #666">（{{ p.name }}）</span>
            </span>
          </template>
          <ItemCard
            :error="store.erroredProviders.has(p.name)"
            remove-tooltip="删除该提供商"
            @remove="removeProvider(i)"
          >
            <div style="display: flex; align-items: baseline; gap: 12px" class="provider-name-row">
              <div style="width: 160px; flex-shrink: 0">
                <n-form-item label="名称" style="margin-bottom: 0">
                  <n-input v-model:value="p.name" placeholder="如 deepseek" />
                </n-form-item>
              </div>
              <div style="flex: 1; min-width: 0" class="provider-base-url">
                <n-form-item label="base_url" style="margin-bottom: 0">
                  <n-input v-model:value="p.base_url" placeholder="https://api.deepseek.com/v1" style="width: 100%" />
                </n-form-item>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px">
              <div style="flex: 1; min-width: 0">
                <n-form-item label="api_key（留空保持原值，填新值覆盖）" style="margin-bottom: 0">
                  <n-input
                    v-model:value="p.api_key"
                    type="password"
                    show-password-on="click"
                    placeholder="留空保持原值，填新值覆盖"
                    style="width: 100%"
                  />
                </n-form-item>
              </div>
              <div style="flex-shrink: 0">
                <n-button
                  size="small"
                  :loading="store.testStates[p.name]?.testing"
                  :type="store.testStates[p.name]?.ok ? 'success' : 'default'"
                  @click="store.onTest(p)"
                >
                  测试连接
                </n-button>
              </div>
            </div>
            <div v-if="store.testStates[p.name]?.result" style="font-size: 12px">
              <n-tag :type="store.testStates[p.name]?.ok ? 'success' : 'error'" size="small">
                {{ store.testStates[p.name]?.result }}
              </n-tag>
            </div>
            <n-form-item class="model-list-item" style="margin-bottom: 0">
              <template #label>
                <span class="model-list-label">
                  模型列表
                  <n-button
                    size="tiny"
                    type="primary"
                    secondary
                    :loading="store.fetchStates[p.name]?.fetching"
                    :disabled="listTesting(p)"
                    @click="store.onFetchModels(p)"
                    style="pointer-events: auto"
                  >
                    拉取模型
                  </n-button>
                  <n-button
                    size="tiny"
                    type="info"
                    secondary
                    :loading="store.modelTests[p.name]?.testing"
                    :disabled="!p.models.length"
                    @click="store.onTestAllModels(p)"
                    style="pointer-events: auto"
                  >
                    测试所有模型
                  </n-button>
                  <n-button
                    size="tiny"
                    :disabled="!store.modelTests[p.name]?.results.length || listTesting(p)"
                    @click="onSortByLatency(p)"
                    style="pointer-events: auto"
                  >
                    <template #icon><n-icon><SwapVerticalOutline /></n-icon></template>
                    按延迟排序
                  </n-button>
                  <span
                    v-if="store.modelTests[p.name] && !store.modelTests[p.name]!.testing && store.modelTests[p.name]!.results.length"
                    class="model-test-summary"
                  >
                    {{ store.modelTests[p.name]!.results.filter((r) => r.ok).length }}/{{
                      store.modelTests[p.name]!.results.length
                    }}
                    可用
                  </span>
                </span>
              </template>
              <SortableList
                v-model:items="p.models"
                v-model:rowIds="p.modelRowIds"
                :disabled="listTesting(p)"
                :pending-items="pendingModels(p)"
                add-label="+ 添加模型"
              >
                <template #item="{ items, index, disabled }">
                  <n-input v-model:value="items[index]" :disabled="disabled" placeholder="模型 id，如 deepseek-chat" style="flex: 1; min-width: 0" />
                  <!-- 该模型逐模型测试结果：输入框右侧标签，hover 显示详情 -->
                  <n-tooltip v-if="modelResult(p, items[index])" trigger="hover" placement="left">
                    <template #trigger>
                      <n-tag
                        :type="modelResult(p, items[index])!.ok ? 'success' : 'error'"
                        size="small"
                        :bordered="false"
                        class="model-result-tag"
                      >
                        {{ modelResult(p, items[index])!.ok ? `可用 ${modelResult(p, items[index])!.ms}ms` : '不可用' }}
                      </n-tag>
                    </template>
                    <div class="model-result-tip">
                      <div><b>模型</b>：{{ modelResult(p, items[index])!.model }}</div>
                      <div>
                        <b>延迟</b>：{{
                          modelResult(p, items[index])!.ok ? `${modelResult(p, items[index])!.ms}ms` : '—'
                        }}
                      </div>
                      <div v-if="modelResult(p, items[index])!.status != null">
                        <b>状态码</b>：{{ modelResult(p, items[index])!.status }}
                      </div>
                      <div v-if="!modelResult(p, items[index])!.ok">
                        <b>提示</b>：{{ friendlyReason(modelResult(p, items[index])!) }}
                      </div>
                      <div v-if="!modelResult(p, items[index])!.ok && modelResult(p, items[index])!.error" class="model-result-raw">
                        <b>原始返回</b>：{{ modelResult(p, items[index])!.error }}
                      </div>
                    </div>
                  </n-tooltip>
                </template>
              </SortableList>
            </n-form-item>
            <div v-if="store.fetchStates[p.name]?.result" style="font-size: 12px">
              <n-tag :type="store.fetchStates[p.name]?.ok ? 'success' : 'error'" size="small">
                {{ store.fetchStates[p.name]?.result }}
              </n-tag>
            </div>
            <div v-if="p.models.length" class="pricing-block">
              <div class="trend-title" style="display: flex; justify-content: space-between; align-items: center">
                <span>计费单价（每 1M tokens；输入/输出分别计价）</span>
                <n-button v-if="!p.pricing" size="tiny" tertiary @click="initPricing(p)">配置单价</n-button>
                <n-button v-else size="tiny" tertiary @click="clearPricing(p)">清除</n-button>
              </div>
              <template v-if="p.pricing">
                <div class="pricing-header">
                  <span class="pricing-col-model">模型</span>
                  <span class="pricing-col-num">输入单价/1M</span>
                  <span class="pricing-col-num">输出单价/1M</span>
                </div>
                <div v-for="(price, m) in p.pricing" :key="m" class="pricing-row">
                  <span class="pricing-model">{{ m }}</span>
                  <n-input-number v-model:value="price.prompt" :min="0" :step="0.01" placeholder="输入单价/1M" size="small" style="width: 120px" />
                  <n-input-number v-model:value="price.completion" :min="0" :step="0.01" placeholder="输出单价/1M" size="small" style="width: 120px" />
                </div>
                <div style="font-size: 12px; color: #9ca3af">单价 = 每 1M tokens 价格；货币单位自定（网关仅做乘法，不联网取价）。模型有调整？点「清除」再「配置单价」按当前模型刷新</div>
              </template>
              <div v-else style="font-size: 12px; color: #9ca3af">未配置，用量统计不计入成本</div>
            </div>
          </ItemCard>
        </n-collapse-item>
      </n-collapse>

    </n-space>
  </n-card>
  <!-- 保存栏移出 n-card：fixed 钉在视口底部，长页面任何位置都可直接点保存；
       留在卡片内会被卡片 hover 的 transform 触发 containing block 而错位 -->
  <div class="sticky-actions">
    <n-button size="small" @click="addProvider">+ 添加 provider</n-button>
    <n-button type="primary" :loading="store.saving" @click="onSave">
      <template #icon><n-icon><SaveOutline /></n-icon></template>
      保存
    </n-button>
  </div>
</template>

<style lang="scss">
@use '../../styles/breakpoint' as *;

.trend-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 10px;
}
.model-list-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
/* 拉取模型按钮贴在 label 文字后面，但禁用 label 整体穿透激活，
   只在按钮本身（pointer-events:auto）可点，点 label 空白不再误触发拉取 */
.model-list-item .n-form-item-label {
  pointer-events: none;
}

/* 每模型测试结果标签：紧贴输入框右侧；flex-shrink:0 防止被输入框挤压 */
.model-result-tag {
  flex-shrink: 0;
  cursor: default;
}
/* tooltip 内的详情排版 */
.model-result-tip {
  font-size: 12px;
  line-height: 1.7;
  max-width: 320px;
  word-break: break-word;
  white-space: normal;
}
.model-result-tip b {
  color: #cbd5e1;
  font-weight: 600;
}
/* 原始上游返回：弱化显示，细节备查 */
.model-result-raw {
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.85;
}
/* 按钮旁「x/y 可用」汇总 */
.model-test-summary {
  font-size: 12px;
  color: #6b7280;
}

.pricing-block {
  margin-top: 12px;
  padding: 10px 12px;
  background: #f7f8fa;
  border: 1px solid #eef0f3;
  border-radius: 10px;
}
.pricing-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e5e7eb;
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
}
.pricing-header .pricing-col-model {
  flex: 1;
  min-width: 0;
}
.pricing-header .pricing-col-num {
  width: 120px;
  flex-shrink: 0;
  text-align: center;
}
.pricing-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.pricing-model {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: $mg-breakpoint) {
  /* provider 编辑区：移动端名称和 base_url 竖排，base_url 独占一行 */
  .provider-name-row {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .provider-name-row > div {
    width: 100% !important;
  }
}
</style>
