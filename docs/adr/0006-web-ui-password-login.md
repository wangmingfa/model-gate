# ADR 0006: Web UI 密码登录——修订 ADR-0005（回环免密 + 非回环密码登录）

- 状态：已接受（Accepted，修订 ADR-0005 的一部分）
- 日期：2026-08-20

## 背景（Context）

ADR-0005 决定管理界面仅本机回环访问、免密码。用户现在要支持**非本机也能访问 Web UI**（如 `host: 0.0.0.0` 暴露给局域网/公网），因此需要引入密码。但完全推翻 ADR-0005 的"本机即信任"模型没必要。

## 决策（Decision）

- **回环（127.0.0.1 / ::1）仍免登录**：延续 ADR-0005 的信任模型，本机访问直接进入，与 host 配置无关。
- **非回环访问需密码登录**：
  - config.json 顶层新增 `admin_password` 字段，支持 `${ENV_VAR}` 插值；**留空 = 未配置**（此时非回环访问登录页显示提示，指引去实际配置文件路径配置）
  - 登录页 + 内存会话：`POST /api/login`（请求体 `{password}`）校验通过后签发随机 session token（内存 Map），Set-Cookie；**24 小时过期**；登录页提供"登出"按钮（`POST /api/logout`）
  - **登录限流**：按来源 IP 记失败次数，连续 5 次错误锁定 60 秒（429），内存实现、重启清零
- **API 联动**：非回环请求必须带有效会话 cookie 才放行 `/api/config`（GET/PUT）与 `/api/test`；`/api/auth-status`、`/api/login`、`/api/logout` 永远放行；未登录的非回环请求返回 401（`code: 'auth_required'`），前端据此切到登录页
- **`admin_password` 不进 config 的编辑范围**：GET/PUT `/api/config` 不涉及密码字段（UI 不提供改密码功能，密码只在配置文件改，热加载生效）
- `GET /api/auth-status` 返回 `{ passwordConfigured, configPath, loggedIn }`，供登录页三态渲染（未配密码→提示去文件配 / 配了未登录→登录表单 / 已登录→直接进入）

## 后果（Consequences）

正面：

- 本机零负担（保持免登录），远程访问有密码保护，两全
- 内存会话 + 重启失效 + 登录限流，密码与 token 都不落盘，安全基线足够
- `admin_password` 支持 `${ENV}`，与 api_key 语义一致，配置心智统一

负面/约束：

- 非回环访问的密码登录是单密码（无多用户/角色），够用但无审计区分
- 会话是内存态，多实例/重启会失效（单进程本机工具无此问题）
- 若将来要远程多人协作，需升级为多用户 + 持久会话（届时另立 ADR）

备选被否决的原因：HTTP Basic（无自定义登录页，无法做"未配密码"引导）；bcrypt hash 存储（引入依赖 + 每次改密码要重新生成 hash，对单机工具过重）；持久化会话（密码/token 落盘增加泄露面）。
