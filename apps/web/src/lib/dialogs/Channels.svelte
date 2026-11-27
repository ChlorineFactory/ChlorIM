<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { ArrowUp, ChevronRight, Copy, Folder, FolderOpen, LogOut, Plus, Sparkles, Trash2, UserMinus, Users, Webhook as WebhookIcon } from 'lucide-svelte'
  import { addMembersSchema, channelCreateSchema, channelPatchSchema, channelSchema, okResponseSchema } from '@chiorim/shared'
  import type { BridgeFsList, Channel, CreateChannelRequest, CreatedWebhook, Webhook } from '@chiorim/shared'
  import { api, copyText, createWebhook, deleteWebhook, errorText, listBridgeFs, listHostFs, listWebhooks, remove } from '$lib/api'
  import Avatar from '$lib/components/Avatar.svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, room, defaultWorkspaceId, close }: {
    workspace: Workspace
    room?: Channel
    defaultWorkspaceId?: string
    close: () => void
  } = $props()

  const canManage = $derived(!room || workspace.user?.is_admin || workspace.user?.id === room.created_by)
  let tab = $state<'general' | 'members' | 'webhooks'>('general')
  let type = $state<CreateChannelRequest['type']>('public')
  let workspaceId = $state(untrack(() => room?.workspace_id ?? defaultWorkspaceId ?? workspace.active?.workspace_id ?? workspace.workspaces[0]?.id ?? ''))
  let name = $state(untrack(() => room?.name ?? ''))
  let topic = $state(untrack(() => room?.topic ?? ''))
  let workDir = $state(untrack(() => room?.work_dir ?? ''))
  let systemContext = $state(untrack(() => room?.system_context ?? ''))
  let selected = $state<string[]>([])
  let addId = $state('')
  let webhooks = $state<Webhook[]>([])
  let hookName = $state('')
  let createdHook = $state<CreatedWebhook | null>(null)
  let error = $state('')
  let busy = $state(false)
  let pickerOpen = $state(false)
  let fsData = $state<BridgeFsList | null>(null)
  let fsLoading = $state(false)
  let fsError = $state('')

  const selectedWs = $derived(workspace.workspaces.find(ws => ws.id === workspaceId))
  const hostOnline = $derived(Boolean(selectedWs?.host_bot_id && (workspace.presence[selectedWs.host_bot_id]?.online ?? workspace.directory[selectedWs.host_bot_id]?.online)))
  const canBrowseSubfolder = $derived(selectedWs?.host_bot_id ? hostOnline : Boolean(selectedWs))

  async function browseSubfolder(targetPath?: string) {
    if (!selectedWs) return
    if (selectedWs.host_bot_id && !hostOnline) return
    pickerOpen = true
    fsLoading = true
    fsError = ''
    try {
      const initial = targetPath ?? (selectedWs.work_dir || undefined)
      fsData = selectedWs.host_bot_id
        ? await listBridgeFs(selectedWs.host_bot_id, initial)
        : await listHostFs(initial)
    } catch (failure) {
      fsError = errorText(failure)
      fsData = null
    } finally { fsLoading = false }
  }

  function pickSubfolder(fullPath: string) {
    const base = selectedWs?.work_dir?.replace(/[\\/]+$/, '')
    if (base && fullPath.startsWith(base + '/')) {
      workDir = fullPath.slice(base.length + 1)
    } else if (base && fullPath === base) {
      workDir = ''
    } else {
      workDir = fullPath
    }
    if (!room && !name.trim()) {
      name = fullPath.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    }
    pickerOpen = false
  }
  const resolvedPreview = $derived.by(() => {
    const ch = workDir.trim()
    const ws = selectedWs?.work_dir?.trim()
    if (ch) {
      if (ch.startsWith('/') || ch.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(ch)) return ch
      if (ws) return `${ws.replace(/[\\/]+$/, '')}/${ch.replace(/^[\\/]+/, '')}`
      return ch
    }
    return ws || ''
  })

  const available = $derived(workspace.members.filter(member => member.id !== workspace.user?.id))
  const current = $derived(room ? workspace.memberIds[room.id] ?? [] : [])
  const candidates = $derived(available.filter(member => !current.includes(member.id)))

  async function action(task: () => Promise<unknown>) {
    busy = true
    error = ''
    try { await task() } catch (failure) { error = errorText(failure) } finally { busy = false }
  }

  onMount(() => {
    if (room && canManage) {
      void listWebhooks(room.id).then(list => { webhooks = list }).catch(() => {})
    }
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    return action(async () => {
      const channel = room
        ? await api(`/channels/${room.id}`, channelSchema, 'PATCH',
          channelPatchSchema.parse({
            name, topic, system_context: systemContext,
            workspace_id: workspaceId || null,
            work_dir: workDir.trim() || null,
          }))
        : await api('/channels', channelSchema, 'POST', channelCreateSchema.parse({
          type, name, topic, system_context: systemContext,
          workspace_id: workspaceId || null,
          work_dir: workDir.trim() || null,
          member_ids: type === 'private' ? selected : [],
        }))
      workspace.setChannel(channel)
      workspace.select(channel.id)
      workspace.toast(room ? '频道设置已保存' : '频道已创建', 'success')
      close()
    })
  }

  function addMember() {
    if (!room || !addId) return
    return action(async () => {
      const input = { member_ids: [addId] }
      addMembersSchema.parse(input)
      const updated = await api(`/channels/${room.id}/members`, channelSchema, 'POST', input)
      workspace.setChannel(updated)
      await workspace.loadMembers(room.id, true)
      addId = ''
      workspace.toast('成员已加入频道', 'success')
    })
  }

  async function kickMember(id: string, label: string) {
    if (!room) return
    const ok = await workspace.confirm({
      title: `移出 ${label}`,
      description: `确定将 ${label} 移出 #${room.name} 吗？`,
      confirmLabel: '移出',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove(`/channels/${room.id}/members/${id}`)
      await Promise.all([workspace.loadMembers(room.id, true), workspace.syncLists()])
    })
  }

  async function addWebhook(event: SubmitEvent) {
    event.preventDefault()
    if (!room || !hookName.trim()) return
    await action(async () => {
      const hook = await createWebhook(room.id, hookName.trim())
      createdHook = hook
      webhooks = [hook, ...webhooks]
      hookName = ''
      workspace.toast('Webhook 已创建', 'success')
    })
  }

  async function removeWebhook(hook: Webhook) {
    const ok = await workspace.confirm({
      title: `撤销 Webhook「${hook.name}」`,
      description: '撤销后该 URL 将立即失效。',
      confirmLabel: '撤销',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await deleteWebhook(hook.id)
      webhooks = webhooks.filter(item => item.id !== hook.id)
      if (createdHook?.id === hook.id) createdHook = null
    })
  }

  async function leaveChannel() {
    if (!room) return
    const ok = await workspace.confirm({
      title: `退出 #${room.name}`,
      description: '退出后将不再收到该频道消息。',
      confirmLabel: '退出',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await api(`/channels/${room.id}/leave`, okResponseSchema, 'POST')
      await workspace.syncLists()
      workspace.toast(`已退出 #${room.name}`, 'info')
      close()
    })
  }

  async function deleteChannel() {
    if (!room) return
    const ok = await workspace.confirm({
      title: `删除 #${room.name}`,
      description: '将清空该频道内全部消息和 Thread，无法恢复。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove(`/channels/${room.id}`)
      await workspace.syncLists()
      workspace.toast(`频道 #${room.name} 已删除`, 'info')
      close()
    })
  }
</script>

{#if room}
  <div class="sub-tabs">
    <button type="button" class:active={tab === 'general'} onclick={() => { tab = 'general' }}>基本与目录</button>
    <button type="button" class:active={tab === 'members'} onclick={() => { tab = 'members' }}><Users size={14} /> 成员 ({workspace.roomMembers.length})</button>
    {#if canManage}
      <button type="button" class:active={tab === 'webhooks'} onclick={() => { tab = 'webhooks' }}><WebhookIcon size={14} /> Webhooks ({webhooks.length})</button>
    {/if}
  </div>
{/if}

{#if error}<p class="form-error" role="alert">{error}</p>{/if}

{#if !room || tab === 'general'}
  <form class="stack-form" onsubmit={submit}>
    <div class="form-row two">
      {#if !room}
        <label>频道类型
          <select bind:value={type}>
            <option value="public">公开频道</option>
            <option value="board">留言板</option>
            <option value="private">私有频道</option>
          </select>
        </label>
      {/if}
      {#if workspace.workspaces.length}
        <label>所属文件夹分组
          <select bind:value={workspaceId} disabled={Boolean(room && !canManage)}
            onchange={() => { pickerOpen = false; fsData = null; fsError = '' }}>
            {#each workspace.workspaces as ws (ws.id)}
              <option value={ws.id}>{ws.name}{ws.work_dir ? ` (${ws.work_dir})` : ''}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    <label>频道名称<input bind:value={name} required maxlength={100} disabled={Boolean(room && !canManage)} placeholder="例如：frontend" /></label>

    <label>
      <span class="label-row-between">
        <span class="label-with-icon"><FolderOpen size={13} /> 绑定目录 / 子文件夹（可选）</span>
        {#if canBrowseSubfolder && (!room || canManage)}
          <button type="button" class="choice-quick" onclick={() => pickerOpen ? (pickerOpen = false) : void browseSubfolder()}>
            {pickerOpen ? '收起目录' : '浏览子目录'}
          </button>
        {/if}
      </span>
      <input bind:value={workDir} maxlength={4096} spellcheck={false} disabled={Boolean(room && !canManage)}
        placeholder={selectedWs?.work_dir ? '留空继承分组文件夹，或填相对子路径如 apps/web' : '绝对路径如 /Users/you/Codes/project'} />
      {#if resolvedPreview}
        <small>Agent 在此频道的执行目录：<code>{resolvedPreview}</code></small>
      {/if}
    </label>

    {#if pickerOpen}
      <div class="remote-browser">
        <div class="remote-browser-head">
          <span class="remote-path"><FolderOpen size={12} /> {fsData?.path || '文件夹目录'}</span>
          {#if fsData && fsData.parent !== null}
            <button type="button" class="button quiet compact" disabled={fsLoading} onclick={() => void browseSubfolder(fsData?.parent || undefined)}>
              <ArrowUp size={12} /> 上一级
            </button>
          {/if}
        </div>
        {#if fsLoading}
          <div class="remote-browser-empty"><span class="spinner"></span> 读取子目录…</div>
        {:else if fsError}
          <div class="remote-browser-empty danger-text">{fsError}</div>
        {:else if fsData?.entries.length}
          <div class="remote-browser-list">
            {#each fsData.entries as item (item.path)}
              <div class="remote-dir-row">
                <button type="button" class="remote-dir-pick" onclick={() => pickSubfolder(item.path)}>
                  <Folder size={13} />
                  <span>{item.name}</span>
                </button>
                <button type="button" class="icon-button" title="进入下级" aria-label={`进入 ${item.name}`}
                  onclick={() => void browseSubfolder(item.path)}>
                  <ChevronRight size={14} />
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div class="remote-browser-empty">当前目录无子文件夹</div>
        {/if}
      </div>
    {/if}

    <label>Topic<textarea bind:value={topic} maxlength={1000} rows="2" disabled={Boolean(room && !canManage)} placeholder="频道用途"></textarea></label>
    <label>
      <span class="label-with-icon"><Sparkles size={13} /> 频道共享 Agent 上下文（可选）</span>
      <textarea bind:value={systemContext} maxlength={16000} rows="3" disabled={Boolean(room && !canManage)}
        placeholder="技术栈、目录规范或约束，频道内所有 Agent 自动继承。"></textarea>
    </label>

    {#if !room && type === 'private'}
      <fieldset class="choice-list"><legend>初始成员</legend>
        {#each available as member (member.id)}
          <label class="check-row">
            <input type="checkbox" value={member.id} bind:group={selected} />
            <Avatar user={member} size={22} />
            <span>{member.display_name} <small>@{member.username}</small></span>
            {#if member.bot}<span class="bot-tag">BOT</span>{/if}
          </label>
        {:else}<p class="muted">暂无可添加成员</p>{/each}
      </fieldset>
    {/if}

    <div class="dialog-actions">
      {#if room && room.created_by !== workspace.user?.id}
        <button class="button quiet danger-on-hover push-right" type="button" disabled={busy} onclick={() => void leaveChannel()}>
          <LogOut size={14} /> 退出频道
        </button>
      {/if}
      {#if room && canManage}
        <button class="button quiet danger-on-hover push-right" type="button" disabled={busy} onclick={() => void deleteChannel()}>
          <Trash2 size={14} /> 删除频道
        </button>
      {/if}
      <button class="button quiet" type="button" onclick={close}>关闭</button>
      {#if canManage}
        <button class="button primary" type="submit" disabled={busy}>{room ? '保存设置' : '创建频道'}</button>
      {/if}
    </div>
  </form>
{:else if tab === 'members' && room}
  <div class="settings-section-stack">
    {#if canManage}
      <div class="form-row">
        <select bind:value={addId} aria-label="选择要添加的成员">
          <option value="">选择成员或 Bot</option>
          {#each candidates as member (member.id)}
            <option value={member.id}>{member.display_name} (@{member.username}){member.kind === 'bot' ? ' [BOT]' : ''}</option>
          {/each}
        </select>
        <button class="button primary" type="button" disabled={busy || !addId} onclick={addMember}><Plus size={15} /> 添加</button>
      </div>
    {/if}
    <div class="manage-members">
      {#each workspace.roomMembers as member (member.id)}
        <div class="manage-member">
          <Avatar user={member} size={30} online={member.online} status={member.presence_status} />
          <span><strong>{member.display_name}{#if member.kind === 'bot'} <span class="bot-tag">BOT</span>{/if}</strong><small>@{member.username}</small></span>
          {#if member.id === room.created_by}
            <small class="muted">创建者</small>
          {:else if canManage}
            <button class="icon-button danger-on-hover" type="button" title="移出频道" aria-label={'移出 ' + member.display_name}
              disabled={busy} onclick={() => void kickMember(member.id, member.display_name)}><UserMinus size={15} /></button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{:else if tab === 'webhooks' && room && canManage}
  <div class="settings-section-stack">
    <form class="form-row" onsubmit={addWebhook}>
      <input bind:value={hookName} maxlength={100} required placeholder="Webhook 名称（如 GitHub / CI）" />
      <button type="submit" class="button primary" disabled={busy || !hookName.trim()}><Plus size={15} /> 创建</button>
    </form>

    {#if createdHook}
      {@const fullUrl = `${location.origin}${createdHook.url}`}
      <div class="credentials-card">
        <h3>一次性 Incoming Webhook URL</h3>
        <div class="secret-row">
          <code>{fullUrl}</code>
          <button type="button" class="icon-button" aria-label="复制 Webhook URL"
            onclick={() => void copyText(fullUrl).then(() => workspace.toast('URL 已复制', 'success'))}>
            <Copy size={15} />
          </button>
        </div>
        <p class="muted"><code>curl -X POST '{fullUrl}' -H 'Content-Type: application/json' -d '{"{"}"content":"hello"{"}"}'</code></p>
      </div>
    {/if}

    <div class="manage-list">
      {#each webhooks as hook (hook.id)}
        <article class="manage-card">
          <div class="manage-card-top">
            <strong>{hook.name}</strong>
            <button type="button" class="icon-button danger-on-hover" title="撤销" disabled={busy}
              onclick={() => void removeWebhook(hook)}><Trash2 size={15} /></button>
          </div>
        </article>
      {:else}
        <p class="muted">暂无 Webhook。</p>
      {/each}
    </div>
  </div>
{/if}
