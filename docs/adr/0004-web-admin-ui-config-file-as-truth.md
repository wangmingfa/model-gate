# ADR 0004: Web 配置界面——config.json 保持唯一真相源，SPA 只做编辑器

- 状态：已接受（Accepted）
- 日期：2026-08-20

## 背景（Context）

model-gate 目前通过手改 `config.json` + 1s 轮询热加载来配置。用户要增加 Web 配置界面，避免直接编辑 JSON。核心分歧点：配置的"真相源"放哪——继续用 config.json，还是引入独立存储（数据库/专用文件）？UI 形态选 SPA 还是轻量页？

## 决策（Decision）

- **config.json 保持唯一真相源**：Web 界面保存 = 后端跑现有 `validateConfig` 校验通过后，**原子写回 config.json**，现有热加载轮询自动生效。不引入任何数据库或第二存储。
- **UI 只编辑运行期字段**：providers / aliases / keys / default_model（保存即热加载生效）；port / host / timeout 等启动参数在界面只读展示，改它们需重启（提示用户）。
- **UI 形态**：`admin/` 子目录独立工程，Vite + Vue 3 + Naive UI + TypeScript；构建产物 `admin/dist/` 由 hono 静态托管 + SPA fallback；开发时 Vite dev server 代理 `/admin/api` 到网关端口。
- **管理 API**：`GET /admin/api/config`（返回掩码后配置）+ `PUT /admin/api/config`（校验失败 400 带错误列表，成功才写文件）+ `POST /admin/api/test`（用后端持有的 key 发 1-token 请求测连接）。
- **密钥掩码**：`sk-****abc`（前 3 后 3），界面提供显示开关；编辑时留空 = 保持原值。
- **保存冲突**：last-write-wins，不做版本检测（本机单用户）。

## 后果（Consequences）

正面：

- 零迁移、零状态：配置永远只有一个真相源，热加载、校验、备份全部复用现有机制
- 掩码 + 留空不修改：管理界面被攻破也不会直接泄露全部密钥
- SPA 独立工程：前端依赖与后端 bun 依赖隔离，构建产物纯静态

负面/约束：

- 无版本冲突检测：UI 打开期间外部手改 config.json 会被 UI 保存覆盖（本机单用户可接受）
- port/host 不能在界面热改，需重启（界面只读展示缓解困惑）
- 引入前端构建链（Vite/Node 工具链），不再是纯 bun 项目

备选被否决的原因：独立存储（DB）增加状态和迁移成本，收益仅为并发编辑（本机单用户无此需求）；轻量 HTML+JS 页面用户明确选择 SPA。
