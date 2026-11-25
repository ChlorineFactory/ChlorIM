<script lang="ts">
  import {
    BellOff, Bookmark, CheckCheck, ChevronDown, ChevronRight, Copy, Folder, FolderOpen,
    FolderPlus, Plus, Search, Settings, Settings2, X,
  } from 'lucide-svelte'
  import { profilePatchSchema, userSchema } from '@chiorim/shared'
  import type { Channel, PresenceStatus, Workspace as FolderGroup } from '@chiorim/shared'
  import { api, copyText } from '$lib/api'
  import { shortPath } from '$lib/format'
  import { PRESENCE_META } from '$lib/presets'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import RoomIcon from './RoomIcon.svelte'
  import Avatar from './Avatar.svelte'

  let { workspace, open, close, openNewFolder, openEditFolder, openNewChannel, openDmPicker }: {
    workspace: Workspace
    open: boolean
    close: () => void
    openNewFolder: () => void
    openEditFolder: (folder: FolderGroup) => void
    openNewChannel: (folderId?: string) => void
    openDmPicker: () => void
  } = $props()

  let collapsed = $state<Record<string, boolean>>({})
  let dmOpen = $state(true)
  let statusMenu = $state(false)
  let statusDraft = $state('')
  let savingStatus = $state(false)

  const knownFolderIds = $derived(new Set(workspace.workspaces.map(item => item.id)))
  const dms = $derived(workspace.channels.filter(room => room.type === 'dm')
    .sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at)))
  const dmPeerIds = $derived(new Set(dms.map(room => room.dm_peer?.id).filter((id): id is string => Boolean(id))))
  const quickBots = $derived(workspace.members.filter(member => member.kind === 'bot' && !dmPeerIds.has(member.id)))
  const hasBoundFolder = $derived(workspace.workspaces.some(group => Boolean(group.work_dir)))
  const dmUnreadTotal = $derived(dms.reduce((sum, room) => sum + (room.muted ? 0 : room.unread_count), 0))

  function roomsFor(folder: FolderGroup, index: number) {
    return workspace.channels.filter(room => {
      if (room.type === 'dm') return false
      if (room.workspace_id === folder.id) return true
      return index === 0 && (!room.workspace_id || !knownFolderIds.has(room.workspace_id))
    })
  }

  function canManageFolder(folder: FolderGroup) {
    return Boolean(workspace.user?.is_admin || workspace.user?.id === folder.created_by)
  }

  function toggleFolder(id: string) {
    collapsed[id] = !collapsed[id]
  }

  function go(channel: Channel) {
    workspace.select(channel.id)
    close()
  }

  function toggleStatusMenu() {
    statusDraft = workspace.user?.status_text ?? ''
    statusMenu = !statusMenu
  }

  async function savePresence(nextStatus?: PresenceStatus) {
    if (!workspace.user) return
    savingStatus = true
    try {
      const patch = profilePatchSchema.parse({
        presence_status: nextStatus ?? workspace.user.presence_status,
        status_text: statusDraft.trim(),
      })
      const updated = await api('/users/me', userSchema, 'PATCH', patch)
      workspace.user = updated
      if (workspace.directory[updated.id]) {
        workspace.directory[updated.id] = { ...workspace.directory[updated.id], ...updated }
      }
      statusMenu = false
    } catch (error) { workspace.report(error) }
    finally { savingStatus = false }
  }
</script>

<aside class="sidebar" class:drawer-open={open} aria-label="频道与文件夹">
  <header class="workspace-brand">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" />
          <path d="M9 10h6" />
        </svg>
      </span>
      <strong>ChiorIM</strong>
      <i class:online={workspace.connection === 'connected'} title={workspace.connection === 'connected' ? '实时连接中' : '重连中'}></i>
    </div>
    <button type="button" class="icon-button" title="添加文件夹分组" aria-label="添加文件夹分组"
      onclick={() => { close(); openNewFolder() }}>
      <FolderPlus size={16} />
    </button>
    <button type="button" class="icon-button mobile-only" aria-label="收起侧栏" onclick={close}><X size={17} /></button>
  </header>

  <div class="sidebar-search">
    <button type="button" class="quick-jump" onclick={() => { close(); workspace.openSearch() }}>
      <Search size={13} />
      <span>搜索消息或频道…</span>
      <kbd>⌘K</kbd>
    </button>
  </div>

  <nav class="channels-nav" aria-label="文件夹与频道列表">
    {#each workspace.workspaces as folder, index (folder.id)}
      {@const isOpen = !collapsed[folder.id]}
      {@const rooms = roomsFor(folder, index)}
      {@const unread = workspace.folderUnread(folder.id)}
      <section class="nav-group folder-group">
        <div class="nav-heading folder-head">
          <button type="button" class="cat-toggle" onclick={() => toggleFolder(folder.id)}
            title={folder.work_dir ? `${folder.name} · ${folder.work_dir}` : folder.name}>
            {#if isOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
            {#if folder.work_dir}
              <span class="folder-icon">
                {#if isOpen}<FolderOpen size={13} />{:else}<Folder size={13} />{/if}
              </span>
            {/if}
            <span class="cat-label">{folder.name}</span>
          </button>

          {#if !isOpen && unread > 0}
            <span class="unread">{unread > 99 ? '99+' : unread}</span>
          {/if}

          <div class="folder-head-actions">
            {#if canManageFolder(folder)}
              <button class="icon-button" type="button" aria-label={`编辑 ${folder.name}`} title="文件夹分组设置"
                onclick={() => { close(); openEditFolder(folder) }}>
                <Settings2 size={13} />
              </button>
            {/if}
            <button class="icon-button" type="button" aria-label={`在 ${folder.name} 新建频道`} title={`在「${folder.name}」下新建频道`}
              onclick={() => { close(); openNewChannel(folder.id) }}>
              <Plus size={14} />
            </button>
          </div>
        </div>

        {#if isOpen}
          {#if folder.work_dir}
            <button type="button" class="folder-path-chip" title={`点击复制路径：${folder.work_dir}`}
              onclick={() => void copyText(folder.work_dir!).then(() => workspace.toast('已复制文件夹路径', 'success'))}>
              <span>{shortPath(folder.work_dir)}</span>
              <Copy size={10} />
            </button>
          {/if}

          {#each rooms as room (room.id)}
            <button class="nav-room" class:active={workspace.activeId === room.id}
              class:has-unread={room.unread_count > 0 && !room.muted} class:is-muted={room.muted}
              type="button" aria-current={workspace.activeId === room.id ? 'page' : undefined}
              title={room.effective_work_dir ? `#${room.name} · 📁 ${room.effective_work_dir}` : `#${room.name}`}
              onclick={() => go(room)}>
              <span class="nav-room-icon"><RoomIcon type={room.type} /></span>
              <span class="nav-room-main">
                <span class="nav-room-name">{room.name}</span>
                {#if room.work_dir}<small class="sub-dir-tag">{room.work_dir}</small>{/if}
              </span>
              {#if room.muted}<BellOff size={12} class="muted-icon" />{/if}
              {#if room.unread_count > 0 && !room.muted}
                <span class="unread">{room.unread_count > 99 ? '99+' : room.unread_count}</span>
              {/if}
            </button>
          {:else}
            <button class="nav-room empty-dm" type="button" onclick={() => { close(); openNewChannel(folder.id) }}>
              <Plus size={13} /> 新建频道
            </button>
          {/each}
        {/if}
      </section>
    {/each}

    {#if !hasBoundFolder}
      <button type="button" class="add-folder-cta" onclick={() => { close(); openNewFolder() }}>
        <FolderPlus size={14} />
        <span>添加项目文件夹分组</span>
      </button>
    {/if}

    <section class="nav-group dm-section">
      <div class="nav-heading folder-head">
        <button type="button" class="cat-toggle" onclick={() => { dmOpen = !dmOpen }}>
          {#if dmOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
          <span class="cat-label">私聊</span>
        </button>
        {#if !dmOpen && dmUnreadTotal > 0}
          <span class="unread">{dmUnreadTotal > 99 ? '99+' : dmUnreadTotal}</span>
        {/if}
        <button class="icon-button" type="button" aria-label="发起私聊" title="发起私聊" onclick={() => { close(); openDmPicker() }}>
          <Plus size={14} />
        </button>
      </div>

      {#if dmOpen}
        {#each dms as room (room.id)}
          {@const peerMember = workspace.allMembers.find(member => member.id === room.dm_peer?.id)}
          {@const peer = peerMember ?? room.dm_peer}
          <button class="nav-room dm-room" class:active={workspace.activeId === room.id}
            class:has-unread={room.unread_count > 0 && !room.muted} class:is-muted={room.muted}
            type="button" aria-current={workspace.activeId === room.id ? 'page' : undefined} onclick={() => go(room)}>
            {#if peer}
              <Avatar user={peer} size={24} online={workspace.presence[peer.id]?.online ?? workspace.directory[peer.id]?.online ?? false}
                status={peer.presence_status} />
            {:else}
              <span class="nav-room-icon"><RoomIcon type="dm" /></span>
            {/if}
            <span class="dm-meta">
              <span class="nav-room-name">{peer?.display_name ?? '私聊'}</span>
              {#if peer?.status_text}<small>{peer.status_text}</small>{/if}
            </span>
            {#if peer?.kind === 'bot'}<span class="bot-tag">{peerMember?.bot?.mode === 'bridge' ? 'AGENT' : 'BOT'}</span>{/if}
            {#if room.unread_count > 0 && !room.muted}
              <span class="unread">{room.unread_count > 99 ? '99+' : room.unread_count}</span>
            {/if}
          </button>
        {/each}

        {#each quickBots as bot (bot.id)}
          <button class="nav-room dm-room" type="button" onclick={() => { close(); void workspace.dm(bot.id).catch(e => workspace.report(e)) }}>
            <Avatar user={bot} size={24} online={bot.online} />
            <span class="dm-meta">
              <span class="nav-room-name">{bot.display_name}</span>
              <small>{bot.bot?.mode === 'bridge' ? (bot.online ? (bot.bot.runtime_meta?.driver ?? 'bridge') : '离线') : (bot.bot?.model ?? '模型')}</small>
            </span>
            <span class="bot-tag">{bot.bot?.mode === 'bridge' ? 'AGENT' : 'BOT'}</span>
          </button>
        {/each}

        {#if !dms.length && !quickBots.length}
          <button class="nav-room empty-dm" type="button" onclick={() => { close(); openDmPicker() }}>
            <Plus size={13} /> 发起私聊
          </button>
        {/if}
      {/if}
    </section>
  </nav>

  {#if workspace.user}
    <div class="sidebar-user-wrap">
      {#if statusMenu}
        <div class="status-popover" role="dialog" aria-label="在线状态">
          <div class="status-choices">
            {#each (['online', 'busy', 'away'] as const) as item}
              <button type="button" class="status-pill" class:active={workspace.user.presence_status === item}
                disabled={savingStatus} onclick={() => savePresence(item)}>
                <i style:background={PRESENCE_META[item].color}></i>
                {PRESENCE_META[item].label}
              </button>
            {/each}
          </div>
          <form class="status-input-row" onsubmit={(event) => { event.preventDefault(); void savePresence() }}>
            <input bind:value={statusDraft} maxlength={120} placeholder="自定义状态…" />
            <button type="submit" class="button primary compact" disabled={savingStatus}>保存</button>
          </form>
        </div>
      {/if}

      <div class="sidebar-user">
        <button class="profile-trigger" type="button" title="切换在线状态或签名" onclick={toggleStatusMenu}>
          <Avatar user={workspace.user} size={32} online={workspace.connection === 'connected'} status={workspace.user.presence_status} />
          <span>
            <strong>{workspace.user.display_name}</strong>
            <small>{workspace.user.status_text || PRESENCE_META[workspace.user.presence_status].label}</small>
          </span>
        </button>
        {#if workspace.totalUnread > 0}
          <button class="icon-button" type="button" title="全部标为已读" aria-label="全部标为已读"
            onclick={() => void workspace.readAll().catch(error => workspace.report(error))}>
            <CheckCheck size={15} />
          </button>
        {/if}
        <button class="icon-button" class:active-icon={workspace.rightMode === 'bookmarks'} type="button"
          title="收藏夹" aria-label="我的收藏夹" onclick={() => { close(); workspace.openRightPanel('bookmarks') }}>
          <Bookmark size={15} />
        </button>
        <button class="icon-button" type="button" title="设置中心" aria-label="设置中心"
          onclick={() => { close(); statusMenu = false; workspace.openSettings('profile') }}>
          <Settings size={16} />
        </button>
      </div>
    </div>
  {/if}
</aside>
