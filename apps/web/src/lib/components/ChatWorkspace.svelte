<script lang="ts">
  import {
    Bell, BellOff, Bookmark, FolderOpen, LayoutGrid, List, Menu, MessageSquare, MessageSquarePlus,
    PanelRightClose, PanelRightOpen, Pin, Plus, Search, Settings2, UsersRound, X,
  } from 'lucide-svelte'
  import type { Attachment, Workspace as FolderGroup } from '@chiorim/shared'
  import { copyText, errorText } from '$lib/api'
  import { shortPath } from '$lib/format'
  import { PRESENCE_META } from '$lib/presets'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import Avatar from './Avatar.svelte'
  import Sidebar from './Sidebar.svelte'
  import RoomIcon from './RoomIcon.svelte'
  import MessageFeed from './MessageFeed.svelte'
  import BoardView from './BoardView.svelte'
  import Composer from './Composer.svelte'
  import MemberList from './MemberList.svelte'
  import RightDrawerContent from './RightDrawerContent.svelte'
  import SearchModal from './SearchModal.svelte'
  import Dialog from './Dialog.svelte'
  import Channels from '$lib/dialogs/Channels.svelte'
  import WorkspaceEditor from '$lib/dialogs/WorkspaceEditor.svelte'
  import SettingsCenter from '$lib/dialogs/SettingsCenter.svelte'

  type Modal = 'new-channel' | 'dm' | 'channel-settings' | 'member' | 'attachment' | 'new-folder' | 'edit-folder'

  let { workspace }: { workspace: Workspace } = $props()
  let modal = $state<Modal | null>(null)
  let memberId = $state('')
  let targetFolderId = $state('')
  let editingFolder = $state<FolderGroup | null>(null)
  let previewFile = $state<Attachment | null>(null)
  let drawer = $state(false)
  let rightOpen = $state(true)
  let mobileRight = $state(false)
  let boardCardMode = $state(true)
  let dmSearch = $state('')
  let actionError = $state('')
  let actionBusy = $state(false)

  const channel = $derived(workspace.active)
  const canManage = $derived(workspace.user?.is_admin || workspace.user?.id === channel?.created_by)
  const peer = $derived(channel?.dm_peer ? workspace.allMembers.find(member => member.id === channel?.dm_peer?.id) ?? channel.dm_peer : null)
  const channelTitle = $derived(channel?.type === 'dm' ? peer?.display_name ?? '私聊' : channel?.name ?? '')
  const thread = $derived(workspace.threadId)
  const showingSpecialRight = $derived(workspace.rightMode !== 'members')
  const openRight = $derived(rightOpen || showingSpecialRight)
  const selectedMember = $derived(workspace.allMembers.find(member => member.id === memberId))
  const dmCandidates = $derived(workspace.members.filter(member => {
    if (member.id === workspace.user?.id) return false
    const query = dmSearch.trim().replace(/^@/, '').toLowerCase()
    return member.username.includes(query) || member.display_name.toLowerCase().includes(query)
  }))

  const rightTitle = $derived({
    members: '频道成员',
    thread: 'Thread',
    pins: '置顶消息',
    files: '频道文件',
    bookmarks: '收藏夹',
  }[workspace.rightMode])

  function openModal(next: Modal) {
    dmSearch = ''
    actionError = ''
    drawer = false
    modal = next
  }
  function closeModal() { modal = null; previewFile = null; editingFolder = null; targetFolderId = ''; actionError = '' }
  function openMember(id: string) { memberId = id; openModal('member') }
  function openNewChannel(folderId?: string) {
    targetFolderId = folderId ?? channel?.workspace_id ?? workspace.workspaces[0]?.id ?? ''
    openModal('new-channel')
  }
  function openEditFolder(folder: FolderGroup) {
    editingFolder = folder
    openModal('edit-folder')
  }
  function preview(file: Attachment) { previewFile = file; openModal('attachment') }

  function closeRight() {
    if (workspace.rightMode !== 'members') workspace.openRightPanel('members')
    else rightOpen = false
    mobileRight = false
  }

  function toggleRightMode(mode: Workspace['rightMode']) {
    if (workspace.rightMode === mode && openRight) {
      if (mode === 'members') rightOpen = false
      else workspace.openRightPanel('members')
      mobileRight = false
      return
    }
    rightOpen = true
    mobileRight = true
    workspace.openRightPanel(mode)
  }

  function toggleRight() {
    if (window.matchMedia('(max-width: 900px)').matches) {
      if (mobileRight || showingSpecialRight) closeRight()
      else mobileRight = true
    } else if (showingSpecialRight) {
      workspace.openRightPanel('members')
    } else {
      rightOpen = !rightOpen
    }
  }

  async function launchDm(id: string) {
    actionBusy = true
    actionError = ''
    try { await workspace.dm(id); closeModal(); mobileRight = false }
    catch (failure) { actionError = errorText(failure) }
    finally { actionBusy = false }
  }
</script>

<div class="discord-shell" class:right-hidden={!openRight} class:has-thread={showingSpecialRight}>
  <Sidebar {workspace} open={drawer} close={() => { drawer = false }}
    openNewFolder={() => openModal('new-folder')}
    {openEditFolder}
    {openNewChannel}
    openDmPicker={() => openModal('dm')} />

  {#if drawer}
    <button class="drawer-shade left-shade" type="button" aria-label="收起侧栏" onclick={() => { drawer = false }}></button>
  {/if}

  <main class="chat-main">
    <header class="chat-header">
      <button class="icon-button mobile-only" type="button" aria-label="打开频道列表" onclick={() => { drawer = true }}>
        <Menu size={20} />
      </button>

      {#if channel}
        {#if peer}
          <Avatar user={peer} size={28} online={workspace.presence[peer.id]?.online ?? workspace.directory[peer.id]?.online ?? false}
            status={peer.presence_status} />
        {:else}
          <span class="room-icon"><RoomIcon type={channel.type} size={18} /></span>
        {/if}

        <div class="channel-title">
          <h1>
            <span>{channelTitle}</span>
            {#if peer?.kind === 'bot'}<span class="bot-tag">BOT</span>{/if}
          </h1>
          {#if channel.effective_work_dir}
            <button type="button" class="header-dir-pill" title={`Agent 执行目录：${channel.effective_work_dir}（点击复制）`}
              onclick={() => void copyText(channel.effective_work_dir!).then(() => workspace.toast('已复制目录路径', 'success'))}>
              <FolderOpen size={12} />
              <span>{shortPath(channel.effective_work_dir)}</span>
            </button>
          {/if}
          {#if channel.topic}
            <p title={channel.topic}>{channel.topic}</p>
          {:else if peer}
            <p>@{peer.username}{peer.status_text ? ` · ${peer.status_text}` : ''}</p>
          {/if}
        </div>

        <div class="header-actions">
          {#if channel.type === 'board'}
            <button type="button" class="icon-button" class:active-icon={boardCardMode}
              title={boardCardMode ? '切换为聊天流' : '切换为卡片墙'}
              onclick={() => { boardCardMode = !boardCardMode }}>
              {#if boardCardMode}<List size={17} />{:else}<LayoutGrid size={17} />{/if}
            </button>
          {/if}

          <button type="button" class="icon-button badge-button" class:active-icon={workspace.rightMode === 'pins'}
            title="置顶消息" aria-label="置顶消息" onclick={() => toggleRightMode('pins')}>
            <Pin size={16} />
            {#if channel.pinned_count > 0}<span>{channel.pinned_count}</span>{/if}
          </button>

          <button type="button" class="icon-button" class:active-icon={workspace.rightMode === 'files'}
            title="频道文件" aria-label="频道文件" onclick={() => toggleRightMode('files')}>
            <FolderOpen size={16} />
          </button>

          <button type="button" class="icon-button" title={channel.muted ? '取消静音' : '静音此频道'} aria-label="切换静音"
            onclick={() => void workspace.toggleMute(channel.id).catch(e => workspace.report(e))}>
            {#if channel.muted}<BellOff size={16} />{:else}<Bell size={16} />{/if}
          </button>

          <button type="button" class="icon-button" title="搜索频道消息" aria-label="搜索此频道消息"
            onclick={() => workspace.openSearch(channel.id)}>
            <Search size={16} />
          </button>

          {#if channel.type !== 'dm'}
            <button type="button" class="icon-button" title="频道设置" aria-label="频道设置"
              onclick={() => { void workspace.loadMembers(channel.id, true); openModal('channel-settings') }}>
              <Settings2 size={16} />
            </button>
          {/if}

          <button type="button" class="icon-button right-toggle" title="切换成员栏" aria-label="切换右侧栏" onclick={toggleRight}>
            {#if openRight}<PanelRightClose size={17} class="desktop-panel-icon" />{:else}<PanelRightOpen size={17} class="desktop-panel-icon" />{/if}
            <UsersRound size={17} class="mobile-panel-icon" />
          </button>
        </div>
      {:else}
        <div class="channel-title"><h1>ChiorIM</h1></div>
      {/if}
    </header>

    {#if channel}
      {#key channel.id}
        {#if channel.type === 'board' && boardCardMode}
          <BoardView {workspace} {channel} {preview} />
        {:else}
          <MessageFeed {workspace} {channel} {preview} />
        {/if}
        <Composer {workspace} channel={channel.id}
          placeholder={channel.type === 'board' ? '写一条留言…' : channel.type === 'dm' ? `消息 @${peer?.username ?? ''}` : `发送消息到 #${channelTitle}`}
          {preview} />
      {/key}
    {:else}
      <div class="workspace-empty">
        <MessageSquare size={26} />
        <h2>选择一个频道或添加文件夹分组开始协作</h2>
        <button class="button primary" type="button" onclick={() => openNewChannel()}><Plus size={15} /> 新建频道</button>
      </div>
    {/if}
  </main>

  {#if channel}
    {#if mobileRight || showingSpecialRight}
      <button type="button" class="drawer-shade right-shade" aria-label="收起右栏" onclick={closeRight}></button>
    {/if}
    <aside class="right-panel" class:desktop-visible={openRight} class:mobile-visible={mobileRight || showingSpecialRight} aria-label={rightTitle}>
      <header class="panel-header">
        <div>
          {#if workspace.rightMode === 'thread'}<MessageSquare size={15} />
          {:else if workspace.rightMode === 'pins'}<Pin size={15} />
          {:else if workspace.rightMode === 'files'}<FolderOpen size={15} />
          {:else if workspace.rightMode === 'bookmarks'}<Bookmark size={15} />
          {:else}<UsersRound size={15} />{/if}
          <h2>{rightTitle}</h2>
          {#if workspace.rightMode === 'members'}<span class="panel-count">{channel.member_count}</span>{/if}
        </div>
        <button class="icon-button" type="button" aria-label="关闭右栏" title="关闭" onclick={closeRight}><X size={16} /></button>
      </header>

      {#if workspace.rightMode === 'thread' && thread}
        {#key thread}
          <MessageFeed {workspace} {channel} {thread} {preview} />
          <Composer {workspace} channel={channel.id} {thread} placeholder="回复 Thread…" {preview} />
        {/key}
      {:else if workspace.rightMode === 'members'}
        <MemberList members={workspace.roomMembers} open={openMember} />
      {:else}
        <RightDrawerContent {workspace} {channel} {canManage} {preview} />
      {/if}
    </aside>
  {/if}
</div>

{#if workspace.settingsTab}
  <SettingsCenter {workspace} close={() => { workspace.settingsTab = null }} />
{/if}

{#if workspace.searchOpen}
  <SearchModal {workspace} close={() => { workspace.searchOpen = false }} />
{/if}

{#if modal}
  {#key modal}
    <Dialog
      title={modal === 'attachment' ? (previewFile?.name ?? '图片预览')
        : modal === 'new-folder' ? '添加文件夹分组'
        : modal === 'edit-folder' ? `文件夹设置 · ${editingFolder?.name ?? ''}`
        : modal === 'new-channel' ? '新建频道'
        : modal === 'channel-settings' ? `频道设置 · #${channel?.name ?? ''}`
        : modal === 'dm' ? '发起私聊' : '成员资料'}
      close={closeModal}
      wide={['channel-settings', 'attachment'].includes(modal)}>
      {#if modal === 'new-folder'}
        <WorkspaceEditor {workspace} close={closeModal} />
      {:else if modal === 'edit-folder' && editingFolder}
        <WorkspaceEditor {workspace} initial={editingFolder} close={closeModal} />
      {:else if modal === 'new-channel'}
        <Channels {workspace} defaultWorkspaceId={targetFolderId} close={closeModal} />
      {:else if modal === 'channel-settings' && channel}
        <Channels {workspace} room={channel} close={closeModal} />
      {:else if modal === 'attachment' && previewFile}
        <div class="lightbox">
          <img src={previewFile.url} alt={previewFile.name} />
          <a class="button quiet" href={previewFile.url} download={previewFile.name}>下载原图</a>
        </div>
      {:else if modal === 'dm'}
        <label class="search-field">
          <Search size={16} />
          <input bind:value={dmSearch} placeholder="搜索好友或 Bot（名称 / @username）" aria-label="搜索成员" />
        </label>
        {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
        <div class="dm-picker">
          {#each dmCandidates as person (person.id)}
            <button class="member-row" type="button" disabled={actionBusy} onclick={() => launchDm(person.id)}>
              <Avatar user={person} size={34} online={person.online} status={person.presence_status} />
              <span class="member-text">
                <strong>{person.display_name}{#if person.kind === 'bot'}<span class="bot-tag">BOT</span>{/if}</strong>
                <small>@{person.username}{person.status_text ? ` · ${person.status_text}` : ''}</small>
              </span>
              <MessageSquarePlus size={16} class="dm-picker-icon" />
            </button>
          {:else}
            <p class="muted">没有匹配的成员。</p>
          {/each}
        </div>
      {:else if modal === 'member'}
        {#if selectedMember}
          <div class="profile-detail">
            <Avatar user={selectedMember} size={58} online={selectedMember.online} status={selectedMember.presence_status} />
            <div>
              <h3>
                {selectedMember.display_name}
                {#if selectedMember.kind === 'bot'}<span class="bot-tag">{selectedMember.bot?.mode === 'bridge' ? 'AGENT' : 'BOT'}</span>{/if}
                {#if selectedMember.is_admin}<span class="bot-tag admin-tag">ADMIN</span>{/if}
              </h3>
              <p class="muted">
                @{selectedMember.username} · {selectedMember.online ? PRESENCE_META[selectedMember.presence_status].label : '离线'}
              </p>
              {#if selectedMember.status_text}<p class="status-quote">{selectedMember.status_text}</p>{/if}
            </div>
          </div>
          <p class="profile-bio">{selectedMember.bio || '暂无简介。'}</p>
          {#if selectedMember.bot?.model}<p class="muted">模型：{selectedMember.bot.model}</p>{/if}
          {#if selectedMember.bot?.runtime_meta}
            <p class="muted break-text">运行环境：{selectedMember.bot.runtime_meta.driver} · {selectedMember.bot.runtime_meta.cwd ?? selectedMember.bot.runtime_meta.hostname}</p>
          {/if}
          {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
          {#if selectedMember.id !== workspace.user?.id && !selectedMember.disabled}
            <div class="dialog-actions">
              <button class="button primary" type="button" disabled={actionBusy} onclick={() => launchDm(selectedMember.id)}>
                <MessageSquarePlus size={15} /> 发起私聊
              </button>
            </div>
          {/if}
        {:else}
          <p class="muted">成员已离开。</p>
        {/if}
      {/if}
    </Dialog>
  {/key}
{/if}
