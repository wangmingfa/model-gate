# ADR 0003: 对外只暴露模型别名（model alias）

- 状态：已接受（Accepted）
- 日期：2026-08-19

## 背景（Context）

用户痛点：机器上有多个 coding agent，每个都要单独配置多家厂商的 base_url、api_key、模型名；上游换模型或换厂商时要在每个 agent 处改配置。核心诉求是"统一入口、agent 配置一次永不改"。如果对外直接暴露各家真实模型名，则 agent 配置与上游强耦合，痛点未解决。

## 决策（Decision）

- 对外**只暴露别名**：`/v1/models` 列出的是别名；agent 请求的 `model` 字段必须是别名（否则 400，错误消息列出可用别名）
- 配置中的 `aliases` 把别名映射到有序的 `provider:model` 列表（结合 ADR 0002 的 failover）
- 网关在所有对外可见处把 model 统一改写为别名：非流式响应体的 `model` 字段、流式 SSE 每个 chunk 的 `model` 字段
- `default_model` 兜底：agent 未传 `model` 时使用
- agent 传的 `temperature`、`tools`、`max_tokens`、`stream` 等其余参数全部原样透传

## 后果（Consequences）

正面：

- agent 侧配置零改动：换上游、调整模型分配只改网关配置文件，热加载即生效
- 别名充当"语义层"（如 `fast`、`reason`），agent 按用途选模型而非按厂商选
- 请求/响应/流式 chunk 中 agent 永远看到别名，无感知

负面/约束：

- 需要维护一张别名→provider:model 映射表（配置项），有学习成本
- 响应中真实模型信息被隐藏，排查问题时需借助网关日志（access log 记录真实模型）
- 上游返回的 usage 等信息仍原样透传，不受别名改写影响

备选被否决的原因：直接透传真实模型名（别名=原样转发）会让 agent 配置随上游变动而失效，违背本项目初衷。
