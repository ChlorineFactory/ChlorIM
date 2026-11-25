# ChlorIM Platform Adapter for Hermes Agent

将 **ChlorIM** 直接接入 **Hermes Agent (`hermes gateway`)** 作为原生聊天平台（与 Telegram / Discord / Slack 平级）。

## 支持能力
- **原生聊天体验**：在 ChlorIM 频道、Thread 和私聊中直接与 Hermes 交互，完整使用 Hermes 自身的会话记忆、Skills、工具链、Pairing 权限与斜杠命令。
- **实时流式回复**：通过 `/ws/bridge` 实时流式推送 Hermes 回复到 ChlorIM 气泡，支持中途点击「停止生成」。
- **Hermes Cron 主动投递**：配置 `CHLORIM_HOME_CHANNEL` 后，Hermes 定时任务设置 `deliver=chlorim` 可主动向指定 ChlorIM 频道发消息。
- **设备文件夹浏览与离线排队**：上报 `CHLORIM_ALLOWED_ROOTS` 后，可在 ChlorIM 网页端直接浏览 Hermes 所在设备的项目目录；Hermes 离线时 `@` 任务自动排队，上线后自动执行。
- **零额外依赖**：优先复用 Hermes 环境中的 `websockets` / `httpx`，若未安装则自动回退到 Python 3.10+ 标准库实现。

## 快速安装

在运行 Hermes Agent 的机器上执行：

```bash
bash packages/hermes-adapter/install.sh
```

或直接将本目录复制到 `~/.hermes/plugins/chlorim/`：

```bash
mkdir -p ~/.hermes/plugins/chlorim
cp packages/hermes-adapter/{plugin.yaml,__init__.py,adapter.py,ws_client.py} ~/.hermes/plugins/chlorim/
```

## 配置与启用

1. 在 ChlorIM 网页端打开 **设置中心 → Bots & Agents**，创建一个 **本地 Agent Bot**（驱动选 `hermes`），复制一次性 `chior_bot_...` Token。
2. 在 `~/.hermes/.env`（或环境变量）中配置：

```dotenv
CHLORIM_URL=http://127.0.0.1:3000
CHLORIM_BOT_TOKEN=chior_bot_xxxxxxxxxxxxxxxx
# 可选：授权 ChlorIM 网页端浏览该设备上的项目目录（逗号分隔）
CHLORIM_ALLOWED_ROOTS=~/Documents/Codes
# 可选：Hermes Cron 定时任务默认投递频道 ID（deliver=chlorim）
CHLORIM_HOME_CHANNEL=
```

3. 启用插件并启动/重启 Gateway：

```bash
hermes plugins enable chlorim
hermes gateway status
```
