<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { ArrowRight, Hash, Paperclip, Search, X } from 'lucide-svelte'
  import type { SearchHit } from '@chiorim/shared'
  import { errorText, searchMessages } from '$lib/api'
  import { formatStamp } from '$lib/format'
  import { markdownSummary } from '$lib/markdown'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import Avatar from './Avatar.svelte'
  import RoomIcon from './RoomIcon.svelte'

  let { workspace, close }: { workspace: Workspace; close: () => void } = $props()

  let query = $state('')
  let channelFilter = $state(untrack(() => workspace.searchChannelFilter))
  let onlyFiles = $state(false)
  let tab = $state<'jump' | 'messages'>(untrack(() => workspace.searchChannelFilter ? 'messages' : 'jump'))
  let hits = $state<SearchHit[]>([])
  let loading = $state(false)
  let error = $state('')
  let input: HTMLInputElement
  let dialog: HTMLDialogElement
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const folderMap = $derived(new Map(workspace.workspaces.map(item => [item.id, item])))
  const dmRooms = $derived(workspace.channels.filter(room => room.type === 'dm'))
  const groupedFilterRooms = $derived.by(() => {
    const known = new Set(workspace.workspaces.map(item => item.id))
    return workspace.workspaces.map((folder, index) => ({
      folder,
      items: workspace.channels.filter(room => room.type !== 'dm' && (room.workspace_id === folder.id || (index === 0 && (!room.workspace_id || !known.has(room.workspace_id))))),
    })).filter(group => group.items.length > 0)
  })

  function folderNameOf(channelId: string) {
    const room = workspace.channels.find(item => item.id === channelId)
    if (!room || room.type === 'dm' || !room.workspace_id) return ''
    return folderMap.get(room.workspace_id)?.name ?? ''
  }

  const quickRooms = $derived(workspace.channels.filter(room => {
    const q = query.trim().toLowerCase()
    const title = room.type === 'dm' ? room.dm_peer?.display_name ?? '' : room.name
    const folderName = room.workspace_id ? (folderMap.get(room.workspace_id)?.name ?? '') : ''
    const dir = room.effective_work_dir ?? ''
    return !q || title.toLowerCase().includes(q) || room.topic.toLowerCase().includes(q)
      || folderName.toLowerCase().includes(q) || dir.toLowerCase().includes(q)
  }).slice(0, 8))

  const quickPeople = $derived(workspace.members.filter(member => {
    if (member.id === workspace.user?.id) return false
    const q = query.trim().replace(/^@/, '').toLowerCase()
    return !q || member.username.includes(q) || member.display_name.toLowerCase().includes(q)
  }).slice(0, 6))

  onMount(() => {
    dialog.showModal()
    input?.focus()
    if (tab === 'messages') void runSearch()
    return () => {
      clearTimeout(timer)
      controller?.abort()
      dialog.close()
    }
  })

  async function runSearch() {
    clearTimeout(timer)
    controller?.abort()
    const trimmed = query.trim()
    if (!trimmed && !onlyFiles && !channelFilter) {
      hits = []
      loading = false
      error = ''
      return
    }
    controller = new AbortController()
    loading = true
    error = ''
    try {
      hits = await searchMessages({
        q: trimmed || undefined,
        channel_id: channelFilter || undefined,
        has_attachments: onlyFiles ? true : undefined,
        limit: 40,
      }, controller.signal)
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) error = errorText(failure)
    } finally { loading = false }
  }

  function onInput() {
    if (tab === 'messages' || query.trim().length >= 2) {
      clearTimeout(timer)
      timer = setTimeout(() => void runSearch(), 220)
    }
  }

  async function jump(hit: SearchHit) {
    close()
    await workspace.jumpToMessage(hit.channel_id, hit.id, hit.thread_root_id)
  }

  async function openDm(id: string) {
    close()
    await workspace.dm(id)
  }
</script>

<dialog bind:this={dialog} class="search-dialog" aria-label="搜索与快速跳转" oncancel={(event) => { event.preventDefault(); close() }}>
  <div class="search-top">
    <Search size={18} />
    <input bind:this={input} bind:value={query} oninput={onInput}
      placeholder={tab === 'jump' ? '输入频道、成员或消息关键词…' : '搜索聊天记录、代码片段或附件…'} />
    <button type="button" class="icon-button" aria-label="关闭搜索" onclick={close}><X size={18} /></button>
  </div>

  <div class="search-bar">
    <div class="search-tabs">
      <button type="button" class:active={tab === 'jump'} onclick={() => { tab = 'jump' }}>快速跳转</button>
      <button type="button" class:active={tab === 'messages'} onclick={() => { tab = 'messages'; void runSearch() }}>搜索消息</button>
    </div>
    {#if tab === 'messages'}
      <div class="search-filters">
        <select bind:value={channelFilter} onchange={() => void runSearch()} aria-label="按频道过滤">
          <option value="">全部频道</option>
          {#each groupedFilterRooms as { folder, items } (folder.id)}
            <optgroup label={folder.name}>
              {#each items as room (room.id)}
                <option value={room.id}># {room.name}{room.work_dir ? ` (${room.work_dir})` : ''}</option>
              {/each}
            </optgroup>
          {/each}
          {#if dmRooms.length}
            <optgroup label="私聊">
              {#each dmRooms as room (room.id)}
                <option value={room.id}>私聊 · {room.dm_peer?.display_name ?? ''}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
        <label class="chip-toggle">
          <input type="checkbox" bind:checked={onlyFiles} onchange={() => void runSearch()} />
          <Paperclip size={13} /> 仅附件
        </label>
      </div>
    {/if}
  </div>

  <div class="search-results">
    {#if tab === 'jump'}
      {#if quickRooms.length}
        <div class="search-section">
          <h4>频道与私聊</h4>
          {#each quickRooms as room (room.id)}
            {@const folder = room.workspace_id ? folderMap.get(room.workspace_id) : undefined}
            <button type="button" class="search-item" onclick={() => { workspace.select(room.id); close() }}>
              <span class="nav-room-icon"><RoomIcon type={room.type} /></span>
              <span class="search-item-main">
                <strong>
                  {room.type === 'dm' ? room.dm_peer?.display_name ?? '私聊' : room.name}
                  {#if folder && room.type !== 'dm'}<span class="search-folder-tag">{folder.name}{room.work_dir ? ` / ${room.work_dir}` : ''}</span>{/if}
                </strong>
                {#if room.topic}<small>{room.topic}</small>{/if}
              </span>
              <ArrowRight size={14} class="muted" />
            </button>
          {/each}
        </div>
      {/if}
      {#if quickPeople.length}
        <div class="search-section">
          <h4>成员与 Bot（回车或点击发私聊）</h4>
          {#each quickPeople as person (person.id)}
            <button type="button" class="search-item" onclick={() => void openDm(person.id)}>
              <Avatar user={person} size={24} online={person.online} status={person.presence_status} />
              <span class="search-item-main">
                <strong>{person.display_name}{#if person.kind === 'bot'} <span class="bot-tag">BOT</span>{/if}</strong>
                <small>@{person.username}</small>
              </span>
              <ArrowRight size={14} class="muted" />
            </button>
          {/each}
        </div>
      {/if}
      {#if query.trim()}
        <button type="button" class="search-item search-promote" onclick={() => { tab = 'messages'; void runSearch() }}>
          <Search size={15} />
          <span>在全部聊天记录中搜索「{query.trim()}」</span>
          <ArrowRight size={14} />
        </button>
      {/if}
    {:else}
      {#if loading}
        <div class="feed-status"><span class="spinner"></span> 正在搜索…</div>
      {:else if error}
        <p class="form-error">{error}</p>
      {:else if !hits.length}
        <div class="feed-status">{query.trim() || onlyFiles || channelFilter ? '没有找到匹配的消息' : '输入关键词或勾选「仅附件」开始搜索'}</div>
      {:else}
        {#each hits as hit (hit.id)}
          {@const groupName = folderNameOf(hit.channel_id)}
          <button type="button" class="search-hit" onclick={() => void jump(hit)}>
            <div class="search-hit-head">
              <Avatar user={hit.author} size={20} />
              <strong>{hit.webhook_name ?? hit.author.display_name}</strong>
              <span class="search-hit-room"><Hash size={11} />{groupName ? `${groupName} / ` : ''}{hit.channel_name || '私聊'}</span>
              <time>{formatStamp(hit.created_at)}</time>
            </div>
            <p>{markdownSummary(hit.content) || hit.blocks.filter(b => b.type === 'attachment').map(b => `[附件: ${b.name}]`).join(' ')}</p>
          </button>
        {/each}
      {/if}
    {/if}
  </div>
</dialog>
