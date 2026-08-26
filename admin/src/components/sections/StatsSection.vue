<script setup lang="ts">
import { ref, h, onMounted, computed } from 'vue';
import { NCard, NButton, NTag, NSelect, NDataTable, NIcon, NEmpty, NSpace, NGrid, NGridItem, NModal } from 'naive-ui';
import { BarChartOutline, ReloadOutline } from '@vicons/ionicons5';
import { getStats, getStatsDetails, type StatsResponse, type StatsRow, type StatsCall } from '../../api';

const loading = ref(false);
const error = ref('');
const data = ref<StatsResponse | null>(null);
const rangeDays = ref(30);

const rangeOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 365 天', value: 365 },
];

const fmtNum = (n: number) => n.toLocaleString('en-US');
const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};
const fmtCost = (n: number) => `¥${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
// 下游密钥掩码：保留前 4 + 后 4，中间 ****；(unknown) 与空值原样/占位显示
const maskKey = (k: string): string => {
  if (!k) return '—';
  if (k === '(unknown)') return k;
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
};

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    data.value = await getStats(rangeDays.value);
  } catch (e) {
    error.value = (e as Error).message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const ov = computed(() => data.value?.overview);

// 按天趋势：取最大请求数做归一化，纯 CSS 柱状
const maxDayReq = computed(() =>
  (data.value?.byDay ?? []).reduce((m, d) => Math.max(m, d.requests), 0),
);
const dayBars = computed(() =>
  (data.value?.byDay ?? []).map((d: StatsRow) => ({
    ...d,
    pct: maxDayReq.value > 0 ? Math.max(2, (d.requests / maxDayReq.value) * 100) : 0,
  })),
);

const aliasColumns = [
  { title: '模型别名', key: 'key', width: 160 },
  { title: '请求数', key: 'requests', width: 100, render: (r: StatsRow) => fmtNum(r.requests) },
  { title: '失败', key: 'failures', width: 80, render: (r: StatsRow) => r.failures },
  { title: '成功率', key: 'successRate', width: 100, render: (r: StatsRow) => `${r.successRate}%` },
  { title: 'Tokens', key: 'tokens', width: 120, render: (r: StatsRow) => fmtTokens(r.tokens) },
  { title: '估算成本', key: 'cost', width: 120, render: (r: StatsRow) => fmtCost(r.cost) },
  { title: 'P95(ms)', key: 'p95Ms', width: 100, render: (r: StatsRow) => Math.round(r.p95Ms) },
];
const keyColumns = [
  { title: '下游密钥', key: 'key', width: 360, render: (r: StatsRow) => maskKey(r.key) },
  { title: '请求数', key: 'requests', width: 100, render: (r: StatsRow) => fmtNum(r.requests) },
  { title: '失败', key: 'failures', width: 80, render: (r: StatsRow) => r.failures },
  { title: '成功率', key: 'successRate', width: 100, render: (r: StatsRow) => `${r.successRate}%` },
  { title: 'Tokens', key: 'tokens', width: 120, render: (r: StatsRow) => fmtTokens(r.tokens) },
  { title: '估算成本', key: 'cost', width: 120, render: (r: StatsRow) => fmtCost(r.cost) },
  { title: 'P95(ms)', key: 'p95Ms', width: 100, render: (r: StatsRow) => Math.round(r.p95Ms) },
];

const hasData = computed(() => (data.value?.overview.requests ?? 0) > 0);

// ---- 行点击查看每次调用明细 ----
const detailShow = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detailCalls = ref<StatsCall[]>([]);
const detailScope = ref<'alias' | 'key'>('alias');
const detailValue = ref('');

const detailTitle = computed(
  () =>
    `调用明细 · ${detailScope.value === 'alias' ? '别名' : '下游密钥'} = ${
      detailScope.value === 'key' ? maskKey(detailValue.value) : detailValue.value
    }`,
);

/** 给数据表用的 rowProps：整行可点击、鼠标手型 */
function makeRowProps(scope: 'alias' | 'key') {
  return (row: StatsRow) => ({
    style: 'cursor: pointer',
    onClick: () => openDetail(scope, row.key),
  });
}

async function openDetail(scope: 'alias' | 'key', value: string): Promise<void> {
  detailScope.value = scope;
  detailValue.value = value;
  detailShow.value = true;
  detailLoading.value = true;
  detailError.value = '';
  detailCalls.value = [];
  try {
    const r = await getStatsDetails(scope, value, rangeDays.value);
    detailCalls.value = r.calls;
  } catch (e) {
    detailError.value = (e as Error).message;
    detailCalls.value = [];
  } finally {
    detailLoading.value = false;
  }
}

const callColumns = [
  { title: '时间', key: 'ts', width: 170, render: (r: StatsCall) => new Date(r.ts).toLocaleString() },
  { title: '别名', key: 'alias', width: 130, render: (r: StatsCall) => r.alias || '—' },
  { title: '下游密钥', key: 'key', width: 140, render: (r: StatsCall) => maskKey(r.key) },
  { title: '实际模型', key: 'realModel', width: 260, render: (r: StatsCall) => r.realModel || '—' },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render: (r: StatsCall) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: r.status >= 200 && r.status < 400 ? 'success' : 'error' },
        { default: () => r.status || '—' },
      ),
  },
  { title: '延迟', key: 'ms', width: 90, render: (r: StatsCall) => `${r.ms}ms` },
  { title: '提示Token', key: 'promptTokens', width: 100, render: (r: StatsCall) => fmtTokens(r.promptTokens) },
  { title: '补全Token', key: 'completionTokens', width: 100, render: (r: StatsCall) => fmtTokens(r.completionTokens) },
  { title: '总Token', key: 'totalTokens', width: 100, render: (r: StatsCall) => fmtTokens(r.totalTokens) },
  { title: '流式', key: 'stream', width: 70, render: (r: StatsCall) => (r.stream ? '是' : '否') },
];
</script>

<template>
  <n-card size="small" class="soft-card">
    <template #header>
      <span class="card-title"><n-icon :size="16"><BarChartOutline /></n-icon> 用量统计（仅 /v1/chat/completions 真实流量）</span>
    </template>
    <template #header-extra>
      <n-space align="center" :size="8">
        <n-select
          v-model:value="rangeDays"
          :options="rangeOptions"
          size="small"
          style="width: 110px"
          @update:value="load"
        />
        <n-button size="small" :loading="loading" @click="load">
          <template #icon><n-icon><ReloadOutline /></n-icon></template>
          刷新
        </n-button>
      </n-space>
    </template>

    <n-empty v-if="error" description="加载失败" />
    <n-empty v-else-if="!loading && !hasData" :description="`最近 ${rangeDays} 天没有 chat 流量记录`" />

    <template v-else>
      <!-- 总览卡片 -->
      <n-grid v-if="ov" :cols="5" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
        <n-grid-item span="5 m:1">
          <div class="stat-box">
            <div class="stat-label">请求总数</div>
            <div class="stat-val">{{ fmtNum(ov.requests) }}</div>
          </div>
        </n-grid-item>
        <n-grid-item span="5 m:1">
          <div class="stat-box">
            <div class="stat-label">成功率</div>
            <div class="stat-val" :style="{ color: ov.successRate >= 99 ? '#18a058' : ov.successRate >= 95 ? '#d97706' : '#e5484d' }">{{ ov.successRate }}%</div>
          </div>
        </n-grid-item>
        <n-grid-item span="5 m:1">
          <div class="stat-box">
            <div class="stat-label">Token 总量</div>
            <div class="stat-val">{{ fmtTokens(ov.totalTokens) }}</div>
            <div class="stat-sub">提示 {{ fmtTokens(ov.promptTokens) }} · 补全 {{ fmtTokens(ov.completionTokens) }}</div>
          </div>
        </n-grid-item>
        <n-grid-item span="5 m:1">
          <div class="stat-box">
            <div class="stat-label">估算成本</div>
            <div class="stat-val">{{ fmtCost(ov.cost) }}</div>
            <div class="stat-sub">按各 provider 单价 × token 汇总</div>
          </div>
        </n-grid-item>
        <n-grid-item span="5 m:1">
          <div class="stat-box">
            <div class="stat-label">P95 延迟</div>
            <div class="stat-val">{{ Math.round(ov.p95Ms) }}ms</div>
          </div>
        </n-grid-item>
      </n-grid>

      <!-- 按天趋势 -->
      <div v-if="dayBars.length" class="trend-block">
        <div class="trend-title">按天请求趋势</div>
        <div class="bars">
          <div v-for="d in dayBars" :key="d.key" class="bar-col" :title="`${d.key}: ${fmtNum(d.requests)} 次`">
            <div class="bar-val">{{ fmtTokens(d.requests) }}</div>
            <div class="bar" :style="{ height: d.pct + '%' }"></div>
            <div class="bar-label">{{ d.key.slice(5) }}</div>
          </div>
        </div>
      </div>

      <!-- 按模型 -->
      <div class="table-block">
        <div class="trend-title">
          按模型别名
          <span class="row-hint">（点击任意行查看每次调用明细）</span>
        </div>
        <n-data-table
          :columns="aliasColumns"
          :data="data?.byAlias ?? []"
          :row-key="(r: StatsRow) => r.key"
          :row-props="makeRowProps('alias')"
          size="small"
          :bordered="false"
          max-height="320"
        />
      </div>

      <!-- 按 key -->
      <div class="table-block">
        <div class="trend-title">
          按下游密钥
          <span class="row-hint">（点击任意行查看每次调用明细）</span>
        </div>
        <n-data-table
          :columns="keyColumns"
          :data="data?.byKey ?? []"
          :row-key="(r: StatsRow) => r.key"
          :row-props="makeRowProps('key')"
          size="small"
          :bordered="false"
          max-height="320"
        />
      </div>

      <div class="gen-time" v-if="data">生成于 {{ new Date(data.generatedAt).toLocaleString() }}</div>
    </template>

    <!-- 单次调用明细弹窗 -->
    <n-modal
      v-model:show="detailShow"
      preset="card"
      :title="detailTitle"
      style="width: 92%; max-width: 1000px"
      :bordered="false"
    >
      <div v-if="detailLoading" class="detail-state">加载中…</div>
      <n-empty v-else-if="detailError" :description="detailError" />
      <n-empty v-else-if="!detailCalls.length" description="该维度在所选时间范围内没有调用记录" />
      <template v-else>
        <n-data-table
          :columns="callColumns"
          :data="detailCalls"
          :row-key="(r: StatsCall) => r.id"
          size="small"
          :bordered="false"
          :max-height="460"
          :pagination="{ pageSize: 50, showSizePicker: true, pageSizes: [50, 100, 200] }"
        />
        <div class="detail-count">共 {{ detailCalls.length }} 次调用（最近 {{ rangeDays }} 天）</div>
      </template>
    </n-modal>
  </n-card>
</template>

<style lang="scss">
@use '../../styles/breakpoint' as *;

.stat-box {
  height: 84px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: linear-gradient(135deg, #eef0ff 0%, #f4ecff 100%);
  color: #1f2937;
  border-radius: 12px;
  padding: 10px 16px;
  box-shadow: 0 6px 18px rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.10);
}
.stat-label {
  font-size: 12px;
  color: #6b7280;
}
.stat-val {
  font-size: 26px;
  font-weight: 700;
  margin-top: 4px;
  line-height: 1.1;
}
.stat-sub {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
}

.trend-block {
  margin-top: 18px;
}
.trend-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 10px;
}
.table-block {
  margin-top: 18px;
}
.row-hint {
  font-size: 11px;
  font-weight: 400;
  color: #9ca3af;
  margin-left: 4px;
}
.detail-state {
  padding: 24px 0;
  text-align: center;
  color: #6b7280;
  font-size: 13px;
}
.detail-count {
  margin-top: 10px;
  font-size: 11px;
  color: #aaa;
  text-align: right;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 120px;
  padding: 6px 0;
  overflow-x: auto;
}
.bar-col {
  flex: 1 1 0;
  min-width: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}
.bar-val {
  font-size: 10px;
  color: #666;
  margin-bottom: 2px;
  white-space: nowrap;
}
.bar {
  width: 70%;
  max-width: 42px;
  min-height: 2px;
  background: linear-gradient(180deg, #8b5cf6, #6366f1);
  border-radius: 4px 4px 0 0;
  transition: height 0.3s ease;
}
.bar-label {
  font-size: 10px;
  color: #999;
  margin-top: 4px;
  white-space: nowrap;
}

.gen-time {
  margin-top: 14px;
  font-size: 11px;
  color: #aaa;
  text-align: right;
}

@media (max-width: $mg-breakpoint) {
  .stat-val {
    font-size: 22px;
  }
}
</style>
