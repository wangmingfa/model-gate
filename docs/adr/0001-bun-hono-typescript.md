# ADR 0001: 技术栈选择 bun + hono + TypeScript

- 状态：已接受（Accepted）
- 日期：2026-08-19

## 背景（Context）

model-gate 是一个常驻本机的轻量 HTTP 中转网关：接收 OpenAI 兼容请求、转发到多家上游、流式透传 SSE。核心诉求是开发迭代快、启动快、内存占用低、无重量级运行时依赖。候选方案：Go（单二进制、性能最好）、Rust（性能极佳但开发慢）、Node/TypeScript、Python/FastAPI。

## 决策（Decision）

使用 **bun + hono + TypeScript**：

- bun 作为运行时与包管理器（内置测试运行器 `bun test`、内置 `Bun.serve`）
- hono 作为 HTTP 框架（轻量、中间件模型清晰、直接返回 `Response`，对代理转发友好）
- TypeScript 严格模式保证类型安全

## 后果（Consequences）

正面：

- 单个运行时，无需打包；`bun test` 零配置
- hono 体积小，无繁重依赖树
- TypeScript 类型让 config 结构、上游响应形状有编译期保障

负面/约束：

- 运行时绑定 bun（用户机器需安装 bun）
- bun 生态比 Node 小，个别 Node 兼容 API 需验证
- 本项目不打包 Docker 镜像（决策 Q2：本机跑），部署形态单一

备选被否决的原因：Go 开发周期长且本项目无性能瓶颈；Node 需要额外配置测试与运行时，bun 一次到位。
