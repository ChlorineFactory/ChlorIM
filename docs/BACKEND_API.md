# ChiorIM v3 后端接口

## 启动

在工作区根目录用 Node.js 20 或更新的 LTS 版本及 pnpm 10 安装和启动。

```bash
pnpm install
pnpm dev:server
```

首次注册自动创建管理员、默认工作区 `客厅`、`general` 和 `留言板`。随后由管理员发放邀请码。SQLite 在启动时自动迁移到 `user_version = 3`，启用 WAL 和外键约束；旧库迁移时自动创建默认工作区并归属孤立频道。默认数据位于根目录的 `data/`。仅构建后端、共享包、Bridge 和 MCP 时可执行 `pnpm exec tsc -b`，再执行 `pnpm --filter @chiorim/server start`。

| 环境变量 | 用途及默认值 |
| --- | --- |
| `HOST` | HTTP 和 WebSocket 共用的监听地址，默认 `127.0.0.1` |
| `PORT` | 监听端口，默认 `3000` |
| `DATA_DIR` | SQLite、上传文件和本地密钥的目录，默认 `data/` |
| `DATABASE_PATH` | SQLite 路径，默认 `<DATA_DIR>/chiorim.db` |
| `APP_SECRET` | Provider 密钥加密材料。省略时生成 `<DATA_DIR>/.secret`。备份数据库时保留同一密钥 |
| `CORS_ORIGINS` | 逗号分隔的前端 Origin，默认 `http://localhost:5173` |
| `COOKIE_SECURE` | 使用 HTTPS 部署时设为 `true` |
| `UPLOAD_MAX_BYTES` | 单文件上限，默认 `10485760` |
| `PUBLIC_UPLOADS` | 默认 `false`，上传文件需要 Cookie 或人类 Bearer。设为 `true` 启用公开下载和缓存 |
| `WEB_DIST_DIR` | 静态 SPA 目录，默认探测 `apps/web/dist/index.html` |
| `BRIDGE_PUBLIC_URL` | 复制连接命令使用的对外 `wss://` 或 `ws://` 地址，默认从请求地址推导 |

反向代理应将 `/api/*`、`/uploads/*`、`/ws/client` 和 `/ws/bridge` 指向同一服务，转发 WebSocket Upgrade。TLS 在代理终止时，将浏览器的 HTTPS Origin 加入 `CORS_ORIGINS`，并设置 `BRIDGE_PUBLIC_URL`。

## REST

以下路径以 `/api` 为前缀，静态上传文件使用 `/uploads/<filename>`。请求和响应字段使用 snake_case，时间为 Unix 毫秒。登录和注册返回 `{ user, token }` 并写入 `chior_session`（HttpOnly、SameSite=Lax、Path=/）。受保护接口也接受 `Authorization: Bearer <token>`。会话有效期为 30 天，距离上次记录超过 5 分钟的有效请求会更新活动时间并延长有效期。错误格式统一为 `{ error: { code, message, details? } }`，删除、确认已读、登出和取消返回 `{ ok: true }`。

| 方法和路径 | 请求与返回 |
| --- | --- |
| GET `/health` | 公开。返回 `{ ok: true, uptime_s }`，用于 Docker `HEALTHCHECK` 与反代探活 |
| GET `/auth/session` | 公开。始终返回 200 和 `{ initialized, user: User \| null }`，用于首页鉴权探测 |
| GET `/auth/bootstrap` | 公开。返回 `{ initialized }` |
| POST `/auth/register` | 公开。接收 `username, display_name, password, invite_code?`。首次注册之后必填有效邀请码。密码 8–256 字符 |
| POST `/auth/login` | 公开。接收 `username, password` |
| POST `/auth/logout` | 撤销当前会话、清 Cookie 并关闭使用同一会话的 WebSocket |
| GET `/auth/me` | 当前 `User` |
| POST `/auth/change-password` | `current_password, new_password, revoke_others?`。默认撤销其他设备 |
| GET `/auth/sessions` | 当前用户有效设备的 `SessionInfo[]`，含设备、来源 IP、活动时间和 `current` |
| DELETE `/auth/sessions/:id` | 撤销自己的指定会话并关闭其 WebSocket |
| POST `/auth/sessions/revoke-others` | 撤销当前以外的会话并关闭其 WebSocket |
| PATCH `/admin/users/:id` | 管理员。更新成员的 `is_admin, disabled`。Bot 仅支持停用，不能成为管理员。停用会撤销会话并广播；管理员不能停用或降级自己 |
| POST `/admin/users/:id/reset-password` | 管理员。接收 `new_password`，撤销目标人类成员的全部会话 |
| PATCH `/users/me` | 更新 `display_name, bio, avatar_url, presence_status, status_text`，返回 `User` |
| GET `/users` | `Member[]`，包含 `online` 和可空的 `bot` 摘要 |
| GET，POST `/invites` | 管理员。列表或创建，创建接收 `max_uses?, expires_at?` |
| DELETE `/invites/:code` | 管理员。撤销邀请码 |
| POST `/uploads` | `multipart/form-data` 的 `file` 字段。返回 `{ url, name, mime, size }`。接受常见位图、文本和源代码。受支持的源码扩展名在 MIME 为空或为 `application/octet-stream` 时按纯文本接收 |
| GET `/uploads/:filename` | 此行无 `/api` 前缀。随机 URL，默认鉴权且不缓存。公开模式启用长期缓存。文本作为下载 |
| GET `/workspaces` | 返回当前成员可见的 `Workspace[]`（绑定文件夹目录的工作区列表） |
| POST `/workspaces` | 接收 `name, work_dir?, description?, icon?, color?, create_default_channel?`。默认自动创建 `#general` |
| PATCH `/workspaces/:id` | 工作区创建者或管理员。更新 `name, work_dir, description, icon, color`，广播 `workspace.updated` 并刷新下属频道的 `effective_work_dir` |
| DELETE `/workspaces/:id` | 工作区创建者或管理员。删除工作区及下属非 DM 频道，广播 `channel.removed` 与 `workspace.removed` |
| GET `/channels` | 当前成员可见的 `Channel[]`，含 `workspace_id, work_dir, effective_work_dir, dm_peer, member_count, unread_count, last_message_at` |
| POST `/channels` | 接收 `type: public \| private \| board, name, workspace_id?, work_dir?, topic?, system_context?, member_ids?`。返回 `Channel` |
| POST `/channels/dm` | 接收 `target_user_id`。返回唯一的双人 `Channel`，`dm_peer` 是对端 |
| PATCH `/channels/:id` | 频道创建者或管理员。更新 `name, workspace_id, work_dir, topic, system_context, pinned_message_id`。旧置顶字段会添加或提升指定消息。传 `null` 清空置顶 |
| DELETE `/channels/:id` | 频道创建者或管理员。删除非 DM 频道，并向成员发送 `channel.removed` |
| POST `/channels/:id/leave` | 退出频道。DM 成员及频道创建者不能退出 |
| PATCH `/channels/:id/preferences` | 接收 `{ muted }`。返回当前用户的 `Channel` |
| POST `/channels/read-all` | 把可见频道的已读游标推进到各自最新消息 |
| GET `/channels/:id/members` | 频道成员可用。返回按 username 排序的 `Member[]`，包含实时在线状态与 Bot 摘要 |
| POST `/channels/:id/members` | 频道创建者或管理员。接收 `{ user_id }` 或 `{ member_ids: string[] }` |
| DELETE `/channels/:id/members/:userId` | 频道创建者或管理员。移除成员。DM 成员固定 |
| GET `/channels/:id/messages` | `before?, around?, limit?=50, thread_root_id?`。返回 `{ messages, next_before }`，按时间倒序，游标为空表示到底。默认主线，指定 Thread 时只返回该 Thread 的回复。`around` 自动使用目标消息所在主线或 Thread 的窗口，与 `before` 互斥 |
| POST `/channels/:id/messages` | 接收 `content, thread_root_id?, reply_to_id?, board_status?, attachments?`。允许仅发送附件。返回新 `Message` |
| POST `/channels/:id/read` | 接收 `last_read_message_id`。游标只向前移动。计数包含主线和 Thread 中游标之后的他人消息 |
| GET `/messages/:id` | 频道成员可用。按 ID 获取完整 `Message`，包括滑出已加载分页的置顶消息 |
| PATCH `/messages/:id` | 更新 `content` 或 `board_status`，返回 `Message`。正文仅作者或管理员可改，留言板顶级消息状态可由频道成员修改 |
| POST `/messages/:id/reactions` | 切换 `{ emoji }`，返回 `{ reactions }` 并广播 |
| GET，POST `/channels/:id/pins` | 获取倒序置顶列表，或由频道创建者/管理员提交 `{ message_id }` 幂等置顶 |
| DELETE `/channels/:id/pins/:messageId` | 移除指定置顶，兼容字段回落到下一条 |
| GET `/channels/:id/files` | 附件画廊，返回最新在前的 `ChannelFile[]` |
| GET `/search` | `q?, channel_id?, author_id?, has_attachments?, limit?`。返回最新在前的 `SearchHit[]`，只搜索可见频道 |
| GET，POST `/bookmarks` | 查看个人收藏或 upsert `{ message_id, note? }` |
| DELETE `/bookmarks/:messageId` | 取消个人收藏 |
| DELETE `/messages/:id` | 作者或管理员。删除消息。删除根消息时一并删除其 Thread |
| POST `/messages/:id/abort` | 触发者、Bot 所有者或管理员。取消流式消息 |
| POST `/messages/:id/regenerate` | 频道成员或管理员重跑 Bot 回复，返回原 ID 的流式消息 |
| POST `/channels/:id/command` | `{ command, thread_root_id? }`。支持 `/reset [@bot]`、`/model @bot <id>`、`/ask @bot1 @bot2 <问题>` 和 `/status` |
| GET `/providers` | `Provider[]`。凭证字段为 `api_key_masked, has_api_key` |
| POST `/providers` | 管理员。接收 `name, type, base_url, api_key?, models?, hermes_session_header?`。返回 `Provider` |
| PATCH，DELETE `/providers/:id` | 管理员。更新或删除。省略 `api_key` 保留密钥，空字符串清除密钥 |
| POST `/providers/:id/test` | 管理员。探测上游 `GET /models`，返回 `{ ok: true, models }` 或 502 |
| GET `/bots` | `Bot[]`，包含 `user, online, runtime_meta` |
| POST `/bots` | 接收 `username, display_name, mode, bio?, avatar_url?, trigger_policy?, channel_ids?`。Provider 模式还需 `provider_id, model`，可设 `system_prompt, temperature, context_limit`。Bridge 模式可设 `driver_hint`，仅本次返回 `bot_token, connect_command` |
| PATCH `/bots/:id` | 所有者或管理员。更新资料、模型、驱动和 `disabled` 等设置。停用时取消运行并关闭 Bridge |
| DELETE `/bots/:id` | 所有者或管理员。关闭 Bridge，删除 Bot 的 DM、配置和会话。保留群聊、原作者与人类 Thread。仅 `?purge=true` 会硬删除历史 |
| DELETE `/bots/:id/sessions` | 可选 `channel_id, thread_root_id`。取消相应运行并清除会话，返回 `{ ok: true, cleared }`。频道成员限共享 scope，管理员可全清 |
| POST `/bots/:id/rotate-token` | 所有者或管理员。只适用于 Bridge Bot，断开旧连接并一次性返回新的 `bot_token, connect_command` |

新建 public 频道时自动纳入现有成员，包括 Bot。新建 board 时默认纳入人类，也可以显式添加 Bot。注册用户自动加入现有 public 和 board。创建 Bot 默认加入 public 频道，传入 `channel_ids` 可明确指定初始频道。频道权限以成员记录为准。

为 Provider 填写 API 根路径。例如 OpenAI 兼容、Anthropic 使用 `https://<host>/v1`，Gemini 使用 `https://generativelanguage.googleapis.com/v1beta`。Hermes 兼容 Provider 可开启 `hermes_session_header`，将频道或 Thread 的 scope 作为 `X-Hermes-Session-Id`。Provider Bot 按配置读取当前 scope 的最近完成消息。配置有效且未停用的 Provider Bot 显示为在线。频道的 `system_context` 会拼接进 Provider system prompt。Provider 会从近期上下文读取实际上传的 PNG、JPEG、WebP 和 GIF，最多 4 张、每张最多 5 MiB。附件保存在消息块中。Provider 与 Bridge 的上下文会附加 `[Attachments: 文件名1, 文件名2]`，Bridge 的当前 prompt 也包含对应文件名。数据库原始正文保持原样。


Bot Bearer Token 可调用 `GET /channels`、`GET /channels/:id/messages`、`POST /channels/:id/messages`、`GET /channels/:id/members`、`GET /search` 和 `GET /users`。消息和搜索仅覆盖 Bot 加入的频道，`GET /users` 仅返回共享频道的成员。Bot 通过 REST 独立发送的消息从第 1 跳计数。有运行中的触发链时继承该运行的跳数，引用 Bot 消息也纳入跳数计算。触发链最多 2 跳。Bot Token 可通过 Bridge Bot 创建或轮换获得。

留言板顶级消息默认 `board_status: "open"`。`reply_to` 用于展示当前引用目标。引用和目标需在同一频道，删除目标后引用会清除。`has_attachments` 支持显式 `true` 和 `false`。搜索按字面匹配 `%` 和 `_`。

注册默认每来源 IP 10 分钟 5 次，登录默认每来源 IP 与用户名组合 5 分钟 10 次。限流返回 `429 RATE_LIMITED` 与秒数 `Retry-After`。来源 IP 使用直接连接地址。

### Incoming Webhooks

| 方法和路径 | 请求与返回 |
| --- | --- |
| GET `/api/channels/:id/webhooks` | 频道创建者或管理员。返回 `Webhook[]` |
| POST `/api/channels/:id/webhooks` | 创建者或管理员。接收 `name, avatar_url?`，仅创建响应返回 `token, url` |
| DELETE `/api/webhooks/:id` | 频道创建者或管理员。撤销 Hook |
| POST `/api/webhooks/in/:token` | 用 URL 中的 Hook token 鉴权。接收 `content, username?, trigger_bots?`，返回新 `Message`（201）。默认不触发 Bot，每个 Hook 每分钟 60 次 |

Webhook token 采用 `chior_wh_<64hex>`，数据库保存其哈希。消息用 `webhook_name` 承载来源名称，`author_id` 对应 Hook 创建者。

## WebSocket

共享包导出 `clientUpSchema`、`clientDownSchema`、`bridgeUpSchema`、`bridgeDownSchema` 和对应 TypeScript 类型。REST DTO 与验证 schema 同样从 `@chiorim/shared` 导入。

### 客户端 `/ws/client`

通过 Cookie 鉴权，支持 `?token=<session_token>`。用文本 JSON 帧传输，每帧一个事件。

| 方向 | 事件及字段 |
| --- | --- |
| 上行 | `message.send` — `channel_id, content, thread_root_id?, reply_to_id?, board_status?, attachments?, client_nonce?` |
| 上行 | `message.abort` — `message_id` |
| 上行 | `read.ack` — `channel_id, last_read_message_id` |
| 上行 | `typing` — `channel_id, thread_root_id?` |
| 上行 | `ping` |
| 下行 | `ready` — `user, online_user_ids, bridge_runtimes`（按 Bot ID 索引） |
| 下行 | `message.created` — `message, client_nonce?` |
| 下行 | `message.delta` — `channel_id, thread_root_id?, message_id, part, delta?, tool?` |
| 下行 | `message.updated` — `message` |
| 下行 | `message.reactions` — `channel_id, message_id, reactions` |
| 下行 | `message.deleted` — `channel_id, message_id` |
| 下行 | `member.updated` — `member`，注册、修改资料、成员账号状态及创建或编辑 Bot 时广播 |
| 下行 | `member.removed` — `user_id`，删除 Bot 时广播 |
| 下行 | `presence.update` — `user_id, online, runtime_meta?` |
| 下行 | `typing` — `channel_id, thread_root_id?, user_id` |
| 下行 | `channel.updated` — `channel`，未读数和 DM 对端按接收方计算 |
| 下行 | `channel.removed` — `channel_id` |
| 下行 | `workspace.updated` — `workspace` |
| 下行 | `workspace.removed` — `workspace_id` |
| 下行 | `error` — `error: { code, message, details? }, client_nonce?` |
| 下行 | `pong` |

SvelteKit 开发服务默认将 `/api`、`/uploads` 和客户端 WebSocket 反代到 `http://127.0.0.1:3000`。可用 `CHIORIM_API_TARGET` 覆盖。浏览器 HTTP 请求和 WebSocket 使用同源 Cookie。上传表单由浏览器生成 multipart Content-Type。

客户端收到 `message.created` 后按消息 ID 合并，可用 `client_nonce` 匹配本地待发项。Delta 的 `part` 为 `text | thinking | tool_start | tool_end`，工具按 `tool.id` 更新。最终用 `message.updated` 的完整记录覆盖本地流式结果。重连后拉取频道、成员和当前频道及 Thread 消息。服务器用 `client_nonce` 回传确认，断线前未确认的发送由用户决定是否重发。


### Bridge `/ws/bridge`

Upgrade 使用 `Authorization: Bearer <bot_token>`。同一 Bot 的新连接替换旧连接。收到 welcome 后发送 hello，再接收任务。

| 方向 | 事件及字段 |
| --- | --- |
| Bridge → Server | `bridge.hello` — `hostname, driver, cwd?, version?` |
| Bridge → Server | `run.delta` — `run_id, part, delta?, tool?` |
| Bridge → Server | `run.done` — `run_id, external_session_id?` |
| Bridge → Server | `run.error` — `run_id, error` |
| Bridge → Server | `pong` |
| Server → Bridge | `bridge.welcome` — `bot_id, username, display_name` |
| Server → Bridge | `run.start` — `run_id, message_id, channel_id, thread_root_id?, scope_key, prompt, context, channel_context?, work_dir?, sender, external_session_id?` |
| Server → Bridge | `run.abort` — `run_id` |
| Server → Bridge | `ping` |

`scope_key` 形如 `channel:<id>` 或 `thread:<root_id>`。同 Bot、同 scope 的任务依次派发，成功后保存上游会话 ID。Bot DM 自动触发。其他频道中，Bot 在被提及或策略为 `always` 时触发，`dm_only` 仅在 DM 触发。发送者不会触发自己，Bot 回复最多传播两跳。

## Bridge CLI

构建后可以直接执行 `node packages/bridge/dist/cli.js`。若要直接执行 API 返回的 `chior-bridge add` 命令，可在根目录创建全局 bin 链接。

```bash
pnpm --dir packages/bridge link
chior-bridge --help
```

`add`、`remove`、`run`、`status`、`logs -f`、`restart`、`service install`、`service uninstall` 共用全局 `--config <path>`，默认 `~/.chiorim/bridge.yaml`，PID、状态和日志位于同目录。编辑 YAML 后可用 `restart` 重启服务或向前台进程发 SIGHUP。不同配置文件可使用独立目录，系统服务名在每个用户下固定。

```yaml
server: ws://localhost:3000
allowed_roots:
  - ~/Documents/Codes
agents:
  - name: local-helper
    token: chior_bot_<从创建响应复制>
    driver: custom
    cwd: /path/to/project
    allowed_roots:
      - /path/to/project
    permission_mode: default
    allowed_users: [alice]
    command: /absolute/path/to/script
    args: []
    env: {}
```

频道或其所属工作区绑定了 `work_dir` 时，服务端在 `run.start.work_dir` 传入解析后的 `effective_work_dir`（频道相对子路径自动拼接工作区目录）。Bridge 通过 `realpath` 校验目标目录存在且位于 `allowed_roots` 白名单内（未配置 `allowed_roots` 时默认仅允许 `cwd` 及其子目录），校验通过后直接在该目录执行本地 Agent，越界则返回明确错误。`chior-bridge add` 支持 `--allowed-roots <dir1,dir2>` 参数。

`allowed_users` 比较每次请求的发送者 username。默认 `["*"]`，空列表拒绝所有发送者。Claude Code 的模式映射为 `plan / default / acceptEdits`，Codex 使用 `read-only / workspace-write` 沙箱，`auto` 在沙箱内运行。Hermes 的端点默认 `http://127.0.0.1:8642/v1/chat/completions`，可配置 `endpoint, api_key, model`。Hermes 的权限由其本地服务控制，custom 的权限由所配置的程序控制。Antigravity 优先调用原生 `agy`。三个权限模式依次映射为 `plan`、`accept-edits`、`auto`，通过 NDJSON stdin 传入 prompt。找不到 `agy` 或 Agent 的 `env.CHIOR_ANTIGRAVITY_BACKEND=python` 时，使用 Python ≥3.10 和 `google-antigravity` SDK。初次运行时把 `channel_context` 加入 prompt。 [Claude CLI](https://code.claude.com/docs/en/cli-reference) · [Codex CLI](https://developers.openai.com/codex/cli/reference) · [Antigravity SDK](https://antigravity.google/docs/sdk/overview)

custom 从 stdin 读取一行 `run.start` JSON。stdout 逐行输出 `{ type: "text" | "thinking", delta }`、`{ type: "tool_start" | "tool_end", tool }`，最后输出 `{ type: "done", external_session_id? }` 并以状态码 0 退出。失败输出 `{ type: "error", error }`。取消通过 SIGTERM 传给进程组，随后强制结束残留进程。自定义程序可将诊断信息写入 stderr。服务安装捕获当前 PATH 和 Node 绝对路径，并使用当前用户的 launchd 或 systemd 服务。

## Web 客户端

根目录执行 `pnpm dev` 同时启动后端和 Web。也可分别运行 `pnpm dev:server` 和 `pnpm dev:web`。打开 `http://localhost:5173` 创建工作区或登录。

`pnpm build` 将 SvelteKit SPA 输出到 `apps/web/dist/`。生产服务启动时若找到该目录的 `index.html`，同一端口可提供静态页面、`/api`、`/uploads` 和 `/ws`。页面路由回退到 `index.html`，`_app/immutable/` 带长期缓存。保留路径使用各自处理器。将外部 `wss://` 地址配置为 `BRIDGE_PUBLIC_URL`，确保页面复制出的本地 Agent 连接命令可用。

Provider 的测试请求使用已保存配置。需先保存新 Provider 或修改，再测试连接。已存在的 Bot 可编辑资料和模式参数。Bot 的用户名及模式在创建时设定，频道归属通过频道成员管理调整。

## ChiorIM MCP Server

`@chiorim/mcp` 通过标准 stdio JSON-RPC 接入，支持初始化、工具列表与调用。构建后可用 `node packages/mcp/dist/cli.js` 启动，或对工作区包建立 `chior-mcp` bin 链接。环境变量 `CHIORIM_URL` 默认 `http://127.0.0.1:3000`，`CHIORIM_TOKEN` 接受人类会话 token 或 Bridge Bot Token。凭据由 MCP 客户端配置注入。stdout 仅输出 JSON-RPC。

| 工具 | 参数与结构化结果 |
| --- | --- |
| `list_channels` | 返回 `{ channels }` |
| `read_messages` | `channel_id, limit?, thread_root_id?`，返回 `{ messages, next_before }` |
| `post_message` | `channel_id, content, thread_root_id?, reply_to_id?`，返回 `{ message }` |
| `search_messages` | `q, channel_id?, limit?`，返回 `{ hits }` |
| `list_members` | `channel_id?`，返回 `{ members }` |

协议参考 [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 与 [Antigravity Headless Mode](https://antigravity.google/docs/cli/headless/)。
