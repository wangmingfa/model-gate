# CONTEXT.md

本仓库的领域词汇表。只记录术语及其含义，不含实现细节。

## 术语

- **model-gate**：本仓库构建的 LLM API 中转服务，对外暴露统一的 OpenAI 兼容接口。
- **provider（运营商/上游）**：提供 LLM 模型 API 的厂商，如 DeepSeek、Kimi、通义千问、智谱等。每个 provider 有一个 base_url 和若干模型。
- **model alias（模型别名）**：对外暴露的统一模型名。agent 只认识别名，不感知背后的 provider 和真实模型名；换上游时别名不变。
- **credential（下游密钥）**：使用方（coding agent）连入网关时携带的 API key，在配置文件中列出。key 是后续按使用方记账/限流的身份维度。
- **consumer（使用方）**：通过统一接口调用模型的一方，典型是用户机器上的各种 coding agent。
- **config（配置文件）**：JSON 格式，声明 provider、模型别名映射、下游密钥、默认模型等。
- **OpenAI 兼容接口**：上游与下游都使用的协议形态（`/v1/chat/completions` 等）。第一版上游只接 OpenAI 兼容端点。
- **failover（故障转移）**：一个 alias 可绑定多个 `provider:model`，按配置顺序尝试，上游失败则切下一个。
- **热加载（hot reload）**：config 文件变更后网关自动重载配置，无需重启，agent 侧配置零改动。
- **access log（请求日志）**：JSONL 格式的逐请求记录（时间、key、alias、真实模型、token 用量、耗时、是否流式），可开关。
- **默认模型**：agent 未指定 model 时使用的 alias。
- **上游密钥插值**：api_key 以 `${VAR}` 开头时从环境变量读取，否则按字面量使用。
