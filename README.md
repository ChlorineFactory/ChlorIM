# ChiorIM

自托管小群协作与多 Agent 工作台：单域 Discord 三栏布局、深林松石主题、文件夹驱动的频道目录路由，支持云端模型 Provider 与本机 Bridge Agent（Codex / Claude Code / Antigravity `agy` / Hermes）以及 MCP Server。

## 核心特性

- **单域文件夹频道路由**：在左侧栏按本地项目文件夹分组管理频道（如 `ChiorIM` → `#frontend [apps/web]`、`#backend [apps/server]`），在频道中 `@Agent` 时自动切到对应目录执行，并由 `chior-bridge` 通过 `allowed_roots` 白名单校验边界。
- **低内存与高密度存储**：
  - 浏览器侧：LRU 频道消息缓存（最多保留 8 个活跃视图、非活跃频道自动裁剪至最近 80 条并保留分页游标）、单条消息详情上限、Markdown/代码高亮 LRU 渲染缓存与 vendor 分包。
  - 服务端：SQLite WAL 限流（8 MiB 页缓存、8 MiB WAL 上限、`INCREMENTAL` 自动回收、定时过期会话清理与优雅停机 `TRUNCATE`）、上传/下载零整文件堆拷贝流式传输、静态资源 `.br`/`.gz` 预压缩直出、Agent 上下文派发后即时释放。
- **单端口部署与多形态交付**：支持 Docker Compose（`node:22-alpine` 多阶段构建 + 非 root 用户 + `/api/health` 探活）以及 Bun 编译的独立原生二进制（`chiorim-server`、`chior-bridge`、`chior-mcp`）。

## 方式一：Docker Compose 一键部署（推荐）

```bash
cp .env.example .env
# 按需修改 .env 中的 CORS_ORIGINS / COOKIE_SECURE / BRIDGE_PUBLIC_URL
docker compose up -d --build
```

默认监听 `http://127.0.0.1:3000`，SQLite 数据库与上传文件持久化在命名卷 `chiorim_data`（`/data`），容器内存上限默认 `384m`（`NODE_OPTIONS=--max-old-space-size=256`）。

## 方式二：打包与运行原生二进制

需要本机已安装 [Bun](https://bun.sh) 与 pnpm：

```bash
pnpm install
pnpm build:binaries
```

产物输出在 `release/<platform>-<arch>/`：

- `chiorim-server` + `web/`：服务端主程序与预压缩前端静态目录，直接运行 `./chiorim-server` 即可启动（支持 `PORT`、`HOST`、`DATA_DIR`、`WEB_DIST_DIR` 等环境变量）。
- `chior-bridge`：零依赖本机 Agent 守护进程二进制，支持 `add`、`run`、`service install`（自动识别独立二进制，无需系统安装 Node.js）。
- `chior-mcp`：零依赖 stdio MCP Server 二进制。
- `SHA256SUMS.txt`：产物校验和。

## 方式三：源码开发与生产运行

```bash
pnpm install
pnpm dev            # 同时启动后端 (3000) 与前端 (5173)
pnpm typecheck      # 全仓库 TypeScript + Svelte 检查
pnpm test           # 全量 Vitest 测试
pnpm build          # 构建后端、CLI、前端并生成 .br / .gz 预压缩资源
pnpm --filter @chiorim/server start
```

## 本机多文件夹 Agent 接入

```bash
chior-bridge add \
  --url 'ws://127.0.0.1:3000' \
  --token 'chior_bot_<Token>' \
  --driver 'codex' \
  --name 'codex' \
  --cwd '~/Documents/Codes' \
  --allowed-roots '~/Documents/Codes'

chior-bridge service install
chior-bridge status
```

## 作为 Hermes Agent 原生聊天平台接入

如果你使用 [Hermes Agent](https://github.com/NousResearch/hermes-agent)，可以直接把 ChlorIM 安装为 `hermes gateway` 的原生平台适配器（与 Telegram / Discord / Slack 平级）：

```bash
bash packages/hermes-adapter/install.sh
export CHLORIM_URL='http://127.0.0.1:3000'
export CHLORIM_BOT_TOKEN='chior_bot_<Token>'
export CHLORIM_ALLOWED_ROOTS='~/Documents/Codes'
hermes plugins enable chlorim
hermes gateway status
```

详见 [packages/hermes-adapter/README.md](./packages/hermes-adapter/README.md)。

更多接口、WebSocket 协议与环境变量说明见 [docs/BACKEND_API.md](./docs/BACKEND_API.md)。
