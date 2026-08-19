# ADR 0002: 上游仅接 OpenAI 兼容端点，alias 绑定有序 provider 列表做 failover

- 状态：已接受（Accepted）
- 日期：2026-08-19

## 背景（Context）

目标是为多家国产 LLM 厂商（DeepSeek、Kimi、通义、智谱、SiliconFlow 等）做统一入口。这些厂商几乎都提供 OpenAI 兼容端点，协议一致；Anthropic、Gemini 的原生协议不同。用户要求"暂时先支持 openai 兼容接口就行"。同时需要处理上游不稳定：网络错误、5xx、429、超时。

## 决策（Decision）

- 第一版上游只接 **OpenAI 兼容端点**（`{base_url}/chat/completions`），但路由层按 provider 抽象，为将来 Anthropic/Gemini 协议适配器预留位置
- `aliases` 中的每个别名绑定一个**有序**的 `provider:model` 列表，顺序即尝试顺序
- **failover 规则**：网络错误、超时、任何非 2xx 状态码都会切换到下一个目标；全部失败时返回 502（若最后一个失败是 4xx 则沿用其状态码），错误消息聚合列出各目标失败原因
- 网关层**不做自动重试**（同一目标重试有重复计费风险，重试决策交给 agent 自己）
- 流式请求一旦上游返回 200 并开始推流即视为提交成功，**流中途不切换 provider**

## 后果（Consequences）

正面：

- 一个 alias 挂多个厂商，某家宕机或限流时自动切换，agent 无感知
- 4xx 也参与切换：不同厂商上下文窗口不同（如 64k vs 128k），A 家报 context 超长时自动落到窗口更大的 B 家
- 不做自动重试，避免重复计费与请求放大

负面/约束：

- 上游错误信息需要透传/聚合，错误格式要 OpenAI 兼容（见 ADR 0003 相关设计）
- 流式中途故障无法切换，只能断开，agent 自行重试
- 未来接入 Anthropic/Gemini 需要新增协议适配层

备选被否决的原因：接原生多协议（Anthropic/Gemini）首版收益低、复杂度高；对同一目标自动重试会放大计费风险。
