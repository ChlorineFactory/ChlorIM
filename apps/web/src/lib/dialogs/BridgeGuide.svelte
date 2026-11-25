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
        <h3><FolderOpen size={15} /> 多文件夹自动路由</h3>
        <p class="muted">在左侧栏添加文件夹分组并绑定项目目录，分组下的子频道自动继承目录或指定子目录（如 <code>apps/web</code>）。只要目标路径在 <code>allowed_roots</code> 内，同一个 Agent 就能自动切到对应文件夹干活。</p>
      </div>
    </div>
  </section>

  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><Terminal size={15} /> chior-bridge 本机服务</h3>
        <p class="muted">单守护进程托管 Claude Code / Codex / Antigravity (agy) / Hermes。</p>
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
