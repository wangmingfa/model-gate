# model-gate

LLM API 中转网关：在一个配置文件里配置多家运营商的模型（DeepSeek、Kimi、通义、智谱……），对外暴露**一个统一的 OpenAI 兼容接口**，供你机器上的多个 coding agent 使用。

**解决什么问题**：你有很多 coding agent（Claude Code、Cursor、各种开源 agent），每个都要单独配置各家厂商的 base_url、api_key、模型名。有了 model-gate，agent 只认一个地址 + 一个 key + 一组**模型别名**；换上游、换模型、加厂商都只改网关的配置文件，热加载即生效，agent 侧零改动。

## 安装

model-gate 基于 [bun](https://bun.sh/) 运行时，推荐用 bun 全局安装（npm 亦可）：

```bash
# 方式一：bun（推荐）
bun install -g @wangmingfa/model-gate

# 方式二：npm
npm install -g @wangmingfa/model-gate
```

> 安装后会得到一个全局命令 `model-gate`（无需 clone 源码、无需 `bun install` 依赖）。

## 使用

```bash
# 1. 生成示例配置（在当前目录创建 config.json）
model-gate init

# 2. 编辑配置，填入你的各家厂商 key（见下文「配置」章节）
vim config.json

# 3. 启动网关（默认监听 127.0.0.1:8787，按 config.json 热加载）
model-gate
```

启动后：

- 网关地址：`http://127.0.0.1:8787`
- OpenAI 兼容接口：`POST http://127.0.0.1:8787/v1/chat/completions`、`GET http://127.0.0.1:8787/v1/models`
- Web 配置界面：`http://127.0.0.1:8787/admin`（本机回环免登录，非本机需 `admin_password`）

agent 侧只需配置一处即可接入：

```jsonc
// 以任意 OpenAI 兼容 client 为例
{
  "base_url": "http://127.0.0.1:8787/v1",
  "api_key": "<你在 /admin 里生成的下游密钥>",
  "model": "fast"   // 模型别名，不暴露真实模型名
}
```

---

## 特性

- **统一 OpenAI 兼容入口**：`POST /v1/chat/completions`（含流式 SSE）+ `GET /v1/models`
- **模型别名**：agent 只认识别名（如 `fast`、`reason`），不感知背后的真实模型；响应与流式 chunk 中的 model 字段统一改写为别名
- **有序 failover**：一个别名可绑多个 `provider:model`（数组，顺序即 failover 顺序）；管理界面里每个别名当前从下拉选一个目标（数组格式仍允许配置多个作为 failover 备选）
- **多下游密钥**：多个 agent 各用一个 key，为按 agent 记账/排查打基础
- **配置热加载**：改 `config.json` 立即生效，无需重启
- **请求日志**：控制台每请求一行摘要 + `access.log`（JSONL）逐请求记录 token 用量，可开关
- **密钥支持环境变量**：`api_key` 可以写 `${ENV_VAR}` 引用环境变量
- **Web 配置界面**：`/admin` 下的 SPA（Vite+Vue3+Naive UI），可视化编辑提供商(provider)/别名/密钥/默认模型，保存即校验并热加载；本机回环免登录，非本机访问需 `admin_password` 密码登录；`api_key` 以密码框遮挡显示

## 快速开始

前置：安装 [bun](https://bun.sh/)（运行时依赖，版本 >= 1.0.0）：

```bash
curl -fsSL https://bun.sh/install | bash
```

```bash
# 1. 安装依赖（会同时安装 admin 子项目依赖）
bun install

# 2. 复制示例配置并编辑（填你的各家 key）
cp config.example.json config.json
vim config.json

# 3. 开发模式（api 热重载 + Vite 前端热更新，开箱即用）
bun run dev

# 3'. 生产构建：内联前端资源并打包成单文件二进制 model-gate.js
bun run build
bun run model-gate.js          # 运行构建产物（等同于 node 跑这个 bun 二进制）

# 指定配置文件（开发/生产均可）:
bun run dev -- --config /path/to/config.json
# 或设环境变量 MODEL_GATE_CONFIG=/path/to/config.json
```

## Web 配置界面（/admin）

不用手改 JSON，浏览器里可视化编辑配置：

```bash
bun run build   # 构建并内联前端资源（Vite 产物 admin/dist/ → src/admin-assets.generated.ts → 打包进二进制）
bun run model-gate.js   # 启动网关（或开发模式 bun run dev）
```

打开浏览器：

- **本机访问**：`http://127.0.0.1:8787/admin`（免登录直接进入）
- **局域网/远程访问**：`host` 配成 `0.0.0.0` 时，启动日志会打印所有 IPv4 入口（如 `http://192.168.1.100:8787/admin`），其他机器用该地址访问并密码登录

- **保存 = 校验通过后原子写回 config.json 并热加载生效**，config.json 始终是唯一真相源
- 可编辑：providers（base_url/api_key/模型列表 + 每个 provider 的"测试连接"按钮）、aliases（别名 → 有序 `provider:model`，顺序即 failover 顺序）、keys（下游密钥）、默认模型
- port / host / timeout 等启动参数只读展示（修改需编辑 config.json 后重启）
- **访问控制**：本机回环（127.0.0.1/::1）免登录直接进入；**非本机访问需密码登录**——在 config.json 顶层配置 `admin_password`（支持 `${ENV_VAR}` 插值，留空 = 未配置）；未配置时登录页会提示去实际配置文件设置。会话为内存态（24 小时过期，重启失效），登录页提供登出；连续 5 次密码错误锁定 60 秒
- **安全**：`api_key` 返回真实值，前端以密码框（type=password）遮挡显示，明文不外露；编辑时留空 = 保持原值（不清空原密钥），填新值即覆盖；`admin_password` 不进界面编辑范围，只在配置文件改
- 开发模式：`bun run dev` 会并行起 Vite dev server（端口 5173，代理 `/admin/api` 到网关）和网关 api，前端改动热更新

启动后服务监听在配置的 `host:port`（默认 `http://127.0.0.1:8787`）。

---

## 配置文件说明（config.json）

所有字段如下，标 ⭐ 的为必填：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `port` ⭐ | number | `8787` | 监听端口（1-65535） |
| `host` | string | `"127.0.0.1"` | 监听地址；本机自用默认即可，远程访问改 `"0.0.0.0"` |
| `default_model` | string | 第一个别名 | agent 请求未指定 `model` 时使用的别名 |
| `timeout_seconds` | number | `60` | 非流式请求的整体超时；流式请求的"空闲超时"（见下文"超时"） |
| `access_log` | boolean | `true` | 是否写 `access.log`（JSONL） |
| `keys` ⭐ | string[] | — | 下游鉴权密钥列表，agent 必须携带其中之一（非空） |
| `providers` ⭐ | object | — | 各上游厂商配置（见下表） |
| `aliases` ⭐ | object | — | 别名 → 有序的 `provider:model` 列表（顺序即 failover 顺序） |

`providers` 中每个 provider 的字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `base_url` ⭐ | string | 厂商的 OpenAI 兼容端点，如 `https://api.deepseek.com/v1`（尾部斜杠自动去掉） |
| `api_key` ⭐ | string | 该厂商的密钥；以 `${VAR}` 开头时从环境变量读取（见"环境变量插值"） |
| `models` ⭐ | string[] | 该 provider 可用的模型 id 列表（非空） |

**启动时校验**：key 非空、base_url 是 http(s) URL、每个别名项必须是 `provider:model` 且引用存在的 provider 和其 models 列表中的模型、`default_model` 必须是已定义别名。任何一项不合法都会报错退出。

### 完整示例

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "default_model": "fast",
  "timeout_seconds": 60,
  "access_log": true,

  "keys": ["sk-local-claude", "sk-local-cursor"],

  "providers": {
    "deepseek": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "${DEEPSEEK_API_KEY}",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    "kimi": {
      "base_url": "https://api.moonshot.cn/v1",
      "api_key": "sk-xxxxxxxxxxxxxxxx",
      "models": ["moonshot-v1-8k", "moonshot-v1-32k"]
    },
    "tongyi": {
      "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api_key": "sk-xxxxxxxxxxxxxxxx",
      "models": ["qwen-plus", "qwen-max"]
    }
  },

  "aliases": {
    "fast":   ["deepseek:deepseek-chat", "kimi:moonshot-v1-8k"],
    "reason": ["deepseek:deepseek-reasoner", "tongyi:qwen-max"],
    "long":   ["kimi:moonshot-v1-32k"]
  }
}
```

- `fast` 别名：先试 DeepSeek 的 `deepseek-chat`，失败自动切 Kimi 的 `moonshot-v1-8k`（failover 顺序）
- `reason` 别名：DeepSeek 推理模型，挂了切通义 qwen-max
- `long` 别名：给长上下文场景用

### 环境变量插值

`api_key` 的值以 `${VAR}` 开头时，启动时从环境变量读取；环境变量不存在则启动报错。否则按字面量使用：

```json
{ "providers": { "deepseek": { "api_key": "${DEEPSEEK_API_KEY}" } } }
```

```bash
export DEEPSEEK_API_KEY=sk-xxxx
bun run dev          # 或 bun run model-gate.js（生产构建后）
```

### 配置热加载

修改 `config.json` 后**最多 1 秒自动生效**（轮询文件 mtime）：新增/删除别名、换 key、改默认模型、改 provider 都不需要重启服务。校验失败时**保留旧配置**并打印错误，不影响服务运行。

---

## API 说明

### 鉴权

所有 `/v1/*` 请求必须携带配置文件 `keys` 列表中的某个 key：

```
Authorization: Bearer sk-local-claude
```

key 不合法返回 `401`。`/health` 不鉴权。

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /v1/models`

返回可用别名列表（agent 通常用它发现模型）：

```json
{ "object": "list", "data": [ { "id": "fast", "object": "model", "created": 1787100000, "owned_by": "model-gate" } ] }
```

### `POST /v1/chat/completions`

与 OpenAI 官方接口完全兼容：

- **请求**：除 `model` 外所有参数（`messages`、`temperature`、`max_tokens`、`tools`、`stream`、`top_p` 等）原样透传
- **model 字段**：填别名；不填则用 `default_model`；填了不存在的别名返回 `400`（错误信息里列出可用别名）
- **响应**：上游响应原样透传，仅 `model` 字段改写为别名；`usage`（token 用量）原样透传
- **流式**：`"stream": true` 时返回 SSE（`text/event-stream`），每个 chunk 的 `model` 也改写为别名，`data: [DONE]` 正常结束

请求示例：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-claude" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 错误格式

统一的 OpenAI 风格错误体：

```json
{ "error": { "message": "……", "type": "……", "code": "……" } }
```

| 场景 | 状态码 | code |
|---|---|---|
| key 缺失/错误 | 401 | `invalid_api_key` |
| 请求体非法 JSON | 400 | `invalid_json` |
| 未知模型别名 | 400 | `model_not_found` |
| 所有 provider 失败 | 502（最后一个失败是 4xx 则沿用其状态码） | `upstream_failed` |
| 未实现的端点（如 `/v1/embeddings`） | 501 | `not_implemented` |

### failover 行为

- 按 `aliases` 中 `provider:model` 的**顺序**逐个尝试；网络错误、超时、任何非 2xx 状态都切下一个
- 4xx 也参与切换：不同厂商上下文窗口不同（如 64k vs 128k），A 家报 context 超长会自动落到窗口更大的 B 家
- 全部失败时：错误消息聚合列出每个目标及失败原因（`provider:model: 原因`）
- **网关不自动重试**同一目标（避免重复计费），重试决策交给 agent
- **流式**：只有"未拿到上游 200 之前"的失败才切换；一旦开始推流即提交，流中途不切换（断了由 agent 重试）

### 超时

- 非流式请求：`timeout_seconds`（默认 60s）整体超时
- 流式请求：拿到响应头后进入"空闲超时"——超过 `timeout_seconds` 没有新数据就断开下游（防止上游挂死）

---

## 日志

### 控制台

每个请求一行摘要：

```
[2026-08-19T14:51:18.376Z] POST /v1/chat/completions 200 438ms key=sk-local-claude alias=fast model=deepseek:deepseek-chat tokens=523 stream
```

### access.log（JSONL，可开关）

每条请求一行 JSON，字段：

| 字段 | 含义 |
|---|---|
| `ts` | 时间（ISO 8601） |
| `method` / `path` | 请求方法 / 路径 |
| `status` / `ms` | 状态码 / 耗时（毫秒） |
| `key` | 下游密钥（按 agent 审计的依据） |
| `alias` | 请求的别名 |
| `realModel` | 实际命中的 `provider:model` |
| `stream` | 是否流式 |
| `promptTokens` / `completionTokens` / `totalTokens` | token 用量（流式取自最后一个携带 usage 的 chunk；上游没返回则缺省） |

```json
{"ts":"2026-08-19T14:51:18.376Z","method":"POST","path":"/v1/chat/completions","status":200,"ms":438,"key":"sk-local-claude","alias":"fast","realModel":"deepseek:deepseek-chat","totalTokens":523}
```

---

## agent 接入示例

所有 agent 都指向同一个 base_url 和各自的 key，`model` 填别名即可。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=sk-local-claude
```

（Claude Code 会把 `ANTHROPIC_BASE_URL` 当 OpenAI 兼容端点用，`ANTHROPIC_AUTH_TOKEN` 会以 `Authorization: Bearer` 发送；配合 `/v1/models` 返回的别名选择模型。）

### Cursor / 各种带自定义 OpenAI API 配置的 IDE

在设置里把 API Base 填 `http://127.0.0.1:8787/v1`，API Key 填 `sk-local-cursor`，模型名填别名如 `fast`。

### OpenAI SDK

Python：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-local-claude",
)
resp = client.chat.completions.create(
    model="fast",  # 别名
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

Node.js：

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "sk-local-claude" });
const stream = await client.chat.completions.create({
  model: "reason",
  messages: [{ role: "user", content: "写一段快速排序" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### 任意 OpenAI 兼容客户端

只要支持自定义 base_url + api_key + model 的 OpenAI 兼容工具，都填：

```
base_url: http://127.0.0.1:8787/v1
api_key:  <config.json 里 keys 中的任意一个>
model:    <config.json 里 aliases 的任意键>
```

---

## 开发

```bash
bun test        # 单元测试（config 校验 / failover / SSE 改写 / 鉴权路由；默认忽略 admin/ 前端测试）
bun run typecheck   # 见下
```

没有真实上游 key 时，可用仓库自带的本地 mock 做端到端自测：

```bash
bun scripts/mock-upstream.ts   # 起一个 OpenAI 兼容 mock 上游（端口 9999，需 config.json 指向它）
bun scripts/smoke.ts           # 端到端冒烟：health/models/鉴权/chat 转发/流式/failover/热加载
```

目录结构：

```
├── config.example.json   # 配置示例（复制为 config.json 使用）
├── src/
│   ├── index.ts          # 入口：加载配置、热加载、Bun.serve
│   ├── app.ts            # Hono 路由：鉴权、日志中间件、/v1/* 端点
│   ├── admin.ts          # /admin 管理后端 API（配置读写、测试连接等）
│   ├── config.ts         # 配置类型、校验、${ENV} 插值
│   ├── providers.ts      # 上游调用：转发、SSE 改写、failover、超时
│   ├── logger.ts         # 控制台摘要 + access.log
│   └── *.test.ts         # 测试
├── admin/                # Vue3 + Naive UI 管理前端（Vite 构建）
├── docs/adr/             # 架构决策记录
└── CONTEXT.md            # 领域词汇表
```

类型检查（可选）：

```bash
bun run typecheck
```

## 限制与路线图

- 上游仅支持 OpenAI 兼容端点（DeepSeek、Kimi、通义、智谱、SiliconFlow 等均兼容）；Anthropic / Gemini 原生协议待加适配层
- 未实现 `/v1/embeddings`、`/v1/completions` 等端点（返回 501）
- 无按 key 限流（本机自用足够；架构上已留身份维度）
- 无成本估算（access.log 已有 token 用量，需要时可直接算）
