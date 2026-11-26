<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Bot as BotIcon, Copy, Eye, EyeOff, KeyRound, Pause, Play, Plus, RotateCcw, Terminal, Trash2,
  } from 'lucide-svelte'
  import { botCredentialsSchema, botListSchema, botPatchSchema, botSchema, providerListSchema } from '@chiorim/shared'
  import type { Bot, BotCredentials, BotWriteResponse, Provider } from '@chiorim/shared'
  import { api, clearBotSessions, copyText, errorText, remove } from '$lib/api'
  import { BOT_TEMPLATES } from '$lib/presets'
  import type { BotTemplate } from '$lib/presets'
  import Avatar from '$lib/components/Avatar.svelte'
  import BotEditor from './BotEditor.svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()
  let bots = $state<Bot[]>([])
  let providers = $state<Provider[]>([])
  let form = $state<Bot | 'new' | null>(null)
  let template = $state<BotTemplate | undefined>(undefined)
  let credentials = $state<BotCredentials | null>(null)
  let reveal = $state(false)
  let busy = $state(false)
  let error = $state('')
  const visibleRooms = $derived(workspace.channels.filter(room => room.type !== 'dm'))

  async function action(task: () => Promise<unknown>) {
    busy = true
    error = ''
    try { await task() } catch (failure) { error = errorText(failure) } finally { busy = false }
  }

  onMount(() => {
    void action(async () => {
      const [botList, providerList] = await Promise.all([api('/bots', botListSchema), api('/providers', providerListSchema)])
      bots = botList
      providers = providerList
    })
  })

  function begin(bot: Bot | 'new', preset?: BotTemplate) {
    form = bot
    template = preset
    credentials = null
    reveal = false
    error = ''
  }

  function saved(result: BotWriteResponse) {
    const { bot_token, connect_command, ...bot } = result
    bots = [...bots.filter(row => row.user_id !== bot.user_id), bot]
    form = null
    template = undefined
    if (bot_token && connect_command) {
      credentials = { bot_token, connect_command }
      reveal = false
      workspace.toast('远程设备 Agent 已创建，请复制下方一次性连接命令', 'success')
    } else if (bot.mode === 'local') {
      workspace.toast('本机直连 Agent 已创建并就绪，无需安装 Bridge', 'success')
    } else {
      workspace.toast('Bot 已保存', 'success')
    }
    if (workspace.connection !== 'connected') void workspace.syncLists().catch(err => workspace.report(err))
  }

  async function toggleDisable(bot: Bot) {
    const nextDisabled = !bot.user.disabled
    const ok = await workspace.confirm({
      title: nextDisabled ? `停用 ${bot.user.display_name}` : `重新启用 ${bot.user.display_name}`,
      description: nextDisabled ? '停用后该 Bot 将不再响应消息，已连接的 Bridge 会断开，但历史聊天记录完整保留。' : '启用后该 Bot 将恢复响应。',
      confirmLabel: nextDisabled ? '停用' : '启用',
      danger: nextDisabled,
    })
    if (!ok) return
    await action(async () => {
      const updated = await api(`/bots/${bot.user_id}`, botSchema, 'PATCH', botPatchSchema.parse({ disabled: nextDisabled }))
      bots = bots.map(row => row.user_id === updated.user_id ? updated : row)
      workspace.toast(nextDisabled ? 'Bot 已停用' : 'Bot 已重新启用', 'info')
    })
  }

  async function resetSessions(bot: Bot) {
    const ok = await workspace.confirm({
      title: `重置 ${bot.user.display_name} 的全部会话`,
      description: '将清除该 Bot 在所有频道和 Thread 中的上游会话 ID（如 Codex / Claude / Hermes / agy 会话记忆）。',
      confirmLabel: '清除会话',
    })
    if (!ok) return
    await action(async () => {
      const result = await clearBotSessions(bot.user_id)
      workspace.toast(`已清除 ${result.cleared} 个上游会话`, 'success')
    })
  }

  async function rotate(bot: Bot) {
    const ok = await workspace.confirm({
      title: '轮换 Bridge Token',
      description: `轮换 ${bot.user.display_name} 的 Token 后，当前本机 Bridge 连接会立即断开，需要使用新命令重新添加。`,
      confirmLabel: '确认轮换',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      credentials = await api(`/bots/${bot.user_id}/rotate-token`, botCredentialsSchema, 'POST')
      reveal = false
      form = null
      workspace.toast('新 Token 已签发', 'success')
    })
  }

  async function deleteBot(bot: Bot) {
    const ok = await workspace.confirm({
      title: `移除 ${bot.user.display_name}`,
      description: '将删除此 Bot 配置、Bridge 凭据和私聊频道，但群聊中的历史消息和人类 Thread 会安全保留。',
      confirmLabel: '确认移除',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove(`/bots/${bot.user_id}`)
      bots = bots.filter(row => row.user_id !== bot.user_id)
      form = null
      credentials = null
      await workspace.syncLists()
      workspace.toast('Bot 已移除（群聊历史已保留）', 'info')
    })
  }

  async function copy(value: string, label: string) {
    await copyText(value)
    workspace.toast(`${label}已复制`, 'success')
  }
</script>

<div class="settings-section-stack">
  <div class="manager-toolbar">
    <span><BotIcon size={16} /> 共 {bots.length} 个 Bot / Agent</span>
    <button class="button primary" type="button" disabled={busy} onclick={() => begin('new')}>
      <Plus size={15} /> 创建自定义 Bot
    </button>
  </div>

  {#if !form}
    <div class="template-strip">
      <div class="template-label">快速从模板创建</div>
      <div class="template-grid">
        {#each BOT_TEMPLATES as item (item.id)}
          <button type="button" class="template-card" onclick={() => begin('new', item)}>
            <Avatar user={{ id: item.id, display_name: item.display_name, avatar_url: item.avatar_url, kind: 'bot' }} size={28} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  {#if credentials}
    <section class="credentials-card">
      <h3><KeyRound size={16} /> 一次性 Bridge 凭据</h3>
      <p>请立刻复制保存连接命令或 Token（关闭后不可再查看，只可轮换重签）。</p>
      <div class="secret-row">
        <code>{reveal ? credentials.bot_token : 'chior_bot_••••••••••••••••••••••••'}</code>
        <button type="button" class="icon-button" aria-label={reveal ? '隐藏 Token' : '显示 Token'} onclick={() => { reveal = !reveal }}>
          {#if reveal}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
        </button>
        <button type="button" class="icon-button" aria-label="复制 Token" onclick={() => void copy(credentials!.bot_token, 'Token')}>
          <Copy size={15} />
        </button>
      </div>
      <div class="row-actions" style="justify-content: flex-start;">
        <button type="button" class="button primary" onclick={() => void copy(credentials!.connect_command, '连接命令')}>
          <Terminal size={15} /> 复制 chior-bridge 连接命令
        </button>
      </div>
      <p class="muted">可追加 <code>--cwd &lt;项目目录&gt; --allowed-roots &lt;根目录&gt;</code>，然后执行 <code>chior-bridge service install</code> 安装为开机后台服务。</p>
    </section>
  {/if}

  {#if form}
    {#key form === 'new' ? 'new-' + (template?.id ?? 'blank') : form.user_id}
      <BotEditor initial={form === 'new' ? undefined : form} {template} isAdmin={Boolean(workspace.user?.is_admin)} {providers} folders={workspace.workspaces} rooms={visibleRooms}
        close={() => { form = null; template = undefined }} {saved} />
    {/key}
  {/if}

  <div class="manage-list">
    {#each bots as bot (bot.user_id)}
      {@const member = workspace.allMembers.find(row => row.id === bot.user_id)}
      {@const editable = workspace.user?.is_admin || bot.owner_id === workspace.user?.id}
      {@const isDisabled = member?.disabled ?? bot.user.disabled}
      <article class="manage-card">
        <div class="manage-card-top">
          <div class="member-identity">
            <Avatar user={member ?? bot.user} size={36} online={member?.online ?? bot.online} />
            <span>
              <strong>
                {member?.display_name ?? bot.user.display_name}
                {#if isDisabled}<span class="archived-tag">已停用</span>{/if}
              </strong>
              <small>@{bot.user.username} · {bot.mode === 'provider' ? (bot.model ?? '未配模型') : (member?.bot?.runtime_meta?.driver ?? bot.driver_hint ?? bot.mode)}</small>
            </span>
          </div>
          <span class="bot-tag">{bot.mode === 'local' ? 'LOCAL DIRECT' : bot.mode === 'bridge' ? 'BRIDGE AGENT' : 'MODEL BOT'}</span>
        </div>

        {#if member?.bot?.runtime_meta?.cwd}
          <p class="muted break-text">工作目录：{member.bot.runtime_meta.cwd}</p>
        {/if}

        {#if editable}
          <div class="row-actions">
            <button type="button" class="button quiet compact" disabled={busy} onclick={() => begin(bot)}>编辑</button>
            <button type="button" class="button quiet compact" disabled={busy} onclick={() => void toggleDisable(bot)}>
              {#if isDisabled}<Play size={13} /> 启用{:else}<Pause size={13} /> 停用{/if}
            </button>
            <button type="button" class="button quiet compact" disabled={busy} onclick={() => void resetSessions(bot)}>
              <RotateCcw size={13} /> 重置会话
            </button>
            {#if bot.mode === 'bridge'}
              <button type="button" class="button quiet compact" disabled={busy} onclick={() => void rotate(bot)}>
                <KeyRound size={13} /> 轮换 Token
              </button>
            {/if}
            <button type="button" class="icon-button danger-on-hover" disabled={busy} aria-label={'移除 ' + bot.user.display_name}
              onclick={() => void deleteBot(bot)}><Trash2 size={15} /></button>
          </div>
        {/if}
      </article>
    {:else}
      <p class="muted">暂无 Bot。</p>
    {/each}
  </div>
</div>
