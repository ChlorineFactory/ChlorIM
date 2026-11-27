<script lang="ts">
  import { Copy, FolderOpen, Server, Terminal } from 'lucide-svelte'
  import { copyText } from '$lib/api'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()

  const origin = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:3000'
  const wsOrigin = origin.replace(/^http/, 'ws')

  const bridgeSnippet = `# 1. 链接 chior-bridge CLI
pnpm --dir packages/bridge link

# 2. 添加本地 Agent 并授权允许访问的项目根目录（allowed-roots）
chior-bridge add --url '${wsOrigin}' --token 'chior_bot_<Token>' --driver 'codex' --name 'codex' --cwd '~/Documents/Codes' --allowed-roots '~/Documents/Codes'

# 3. 安装为本机后台服务（macOS launchd / Linux systemd）
chior-bridge service install
chior-bridge status`

  const hermesPluginSnippet = `# 在运行 Hermes Agent 的设备上安装 ChlorIM 原生平台插件
bash packages/hermes-adapter/install.sh

# 写入凭据到 ~/.hermes/.env 后启用
export CHLORIM_URL='${origin}'
export CHLORIM_BOT_TOKEN='chior_bot_<Token>'
export CHLORIM_ALLOW_ALL_USERS=true
export CHLORIM_ALLOWED_ROOTS='~/Documents/Codes'
hermes plugins enable chlorim
hermes gateway status`

  const mcpSnippet = JSON.stringify({
    mcpServers: {
      chiorim: {
        command: 'chior-mcp',
        env: {
          CHIORIM_URL: origin,
          CHIORIM_TOKEN: 'chior_bot_<BotToken>',
        },
      },
    },
  }, null, 2)

  async function copy(text: string, label: string) {
    try {
      await copyText(text)
      workspace.toast(`${label}已复制`, 'success')
    } catch { workspace.toast('复制失败', 'error') }
  }
</script>

<div class="settings-section-stack">
  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><FolderOpen size={15} /> 本机直连（免装 Bridge）与多文件夹路由</h3>
        <p class="muted">如果 <code>codex</code> / <code>claude</code> / <code>agy</code> 与 ChlorIM 服务端装在<strong>同一台机器</strong>（非 Docker 隔离），在「Bots 与 Agents」直接选「本机直连 Agent」即可开箱即用，无需安装 <code>chior-bridge</code>。可以通过环境变量 <code>LOCAL_ALLOWED_ROOTS</code> 限制可访问目录（默认用户主目录）。</p>
      </div>
    </div>
  </section>

  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><Terminal size={15} /> chior-bridge 远程设备服务</h3>
        <p class="muted">当 Agent 在<strong>另一台电脑</strong>，或 ChlorIM 运行在 <strong>Docker 容器</strong>中而 CLI 在宿主机上时，在目标设备运行 <code>chior-bridge</code> 接入。</p>
      </div>
      <button type="button" class="button quiet compact" onclick={() => void copy(bridgeSnippet, '命令')}>
        <Copy size={13} /> 复制命令
      </button>
    </div>
    <pre class="guide-code">{bridgeSnippet}</pre>
  </section>

  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><Terminal size={15} /> Hermes Gateway 原生平台插件</h3>
        <p class="muted">将 ChlorIM 直接注册为 Hermes Agent 的原生聊天平台（支持流式回复、Cron 推送、远程目录浏览与离线排队）。</p>
      </div>
      <button type="button" class="button quiet compact" onclick={() => void copy(hermesPluginSnippet, 'Hermes 插件命令')}>
        <Copy size={13} /> 复制命令
      </button>
    </div>
    <pre class="guide-code">{hermesPluginSnippet}</pre>
  </section>

  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><Server size={15} /> ChiorIM MCP Server</h3>
        <p class="muted">先运行 <code>pnpm --dir packages/mcp link</code>，再加入客户端 MCP 配置。</p>
      </div>
      <button type="button" class="button quiet compact" onclick={() => void copy(mcpSnippet, 'MCP 配置')}>
        <Copy size={13} /> 复制 JSON
      </button>
    </div>
    <pre class="guide-code">{mcpSnippet}</pre>
  </section>
</div>
