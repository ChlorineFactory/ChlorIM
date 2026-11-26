<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    ArrowUp, Check, ChevronRight, Folder, FolderOpen, FolderPlus, GitBranch, HardDrive, RefreshCw, Trash2, X,
  } from 'lucide-svelte'
  import { workspaceCreateSchema, workspacePatchSchema, workspaceSchema } from '@chiorim/shared'
  import type { BridgeDevice, BridgeFsList, Workspace as FolderGroup } from '@chiorim/shared'
  import {
    api, cloneHostRepo, deleteHostFs, errorText, listBridgeDevices, listBridgeFs, listHostFs, mkdirHostFs, remove,
  } from '$lib/api'
  import { shortPath } from '$lib/format'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, initial, close }: {
    workspace: Workspace
    initial?: FolderGroup
    close: () => void
  } = $props()

  const isAdmin = $derived(Boolean(workspace.user?.is_admin))
  const canDelete = $derived(Boolean(initial && (isAdmin || workspace.user?.id === initial.created_by) && workspace.workspaces.length > 1))

  let devices = $state<BridgeDevice[]>([])
  let hostBotId = $state(untrack(() => initial?.host_bot_id ?? ''))
  let workDir = $state(untrack(() => initial?.work_dir ?? ''))
  let name = $state(untrack(() => initial?.name ?? ''))
  let nameTouched = $state(untrack(() => Boolean(initial?.name)))
  let description = $state(untrack(() => initial?.description ?? ''))
  let createDefault = $state(true)
  let busy = $state(false)
  let error = $state('')

  let homePath = $state('')
  let fsData = $state<BridgeFsList | null>(null)
  let fsLoading = $state(false)
  let fsError = $state('')

  let activeTool = $state<'none' | 'mkdir' | 'clone'>('none')
  let newFolderName = $state('')
  let cloneRepo = $state('')
  let cloneDirName = $state('')
  let toolBusy = $state(false)
  let toolError = $state('')

  const remoteDevices = $derived(devices.filter(item => {
    const member = workspace.allMembers.find(m => m.id === item.bot_id)
    return member?.bot?.mode === 'bridge'
  }))
  const selectedDevice = $derived(devices.find(item => item.bot_id === hostBotId) ?? null)
  const browsingHost = $derived(!hostBotId || workspace.allMembers.find(m => m.id === hostBotId)?.bot?.mode === 'local')
  const canModifyFs = $derived(isAdmin && browsingHost && Boolean(fsData?.path))

  function formatDisplayPath(value?: string | null) {
    if (!value) return '~'
    if (homePath) {
      if (value === homePath) return '~'
      if (value.startsWith(homePath + '/')) return '~/' + value.slice(homePath.length + 1)
    }
    return shortPath(value)
  }

  onMount(() => {
    void listBridgeDevices().then(list => {
      devices = list
      if (hostBotId) {
        const current = list.find(item => item.bot_id === hostBotId)
        const isLocal = workspace.allMembers.find(m => m.id === hostBotId)?.bot?.mode === 'local'
        if (isLocal) {
          void browseHost(workDir || undefined)
        } else if (current?.online) {
          void browse(workDir || undefined)
        }
      } else {
        void browseHost(workDir || undefined)
      }
    }).catch(() => {
      void browseHost(workDir || undefined)
    })
  })

  function applyPath(nextPath: string) {
    workDir = nextPath
    if (nameTouched) return
    const cleaned = nextPath.trim().replace(/[\\/]+$/, '')
    const base = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    if (base) name = base
  }

  async function browseHost(targetPath?: string) {
    fsLoading = true
    fsError = ''
    try {
      if (!homePath) {
        const homeListing = await listHostFs()
        homePath = homeListing.path
        if (!targetPath) {
          fsData = homeListing
          return
        }
      }
      fsData = await listHostFs(targetPath)
    } catch (failure) {
      if (targetPath && homePath) {
        try {
          fsData = await listHostFs()
          return
        } catch { /* fall through */ }
      }
      fsError = errorText(failure)
      fsData = null
    } finally { fsLoading = false }
  }

  async function browse(targetPath?: string) {
    if (browsingHost) return browseHost(targetPath)
    if (!hostBotId) return
    fsLoading = true
    fsError = ''
    try {
      fsData = await listBridgeFs(hostBotId, targetPath)
    } catch (failure) {
      fsError = errorText(failure)
      fsData = null
    } finally { fsLoading = false }
  }

  function onDeviceChange() {
    fsData = null
    fsError = ''
    activeTool = 'none'
    toolError = ''
    if (browsingHost) void browseHost()
    else if (selectedDevice?.online) void browse()
  }

  function openTool(tool: 'mkdir' | 'clone') {
    activeTool = activeTool === tool ? 'none' : tool
    toolError = ''
    if (tool === 'mkdir') newFolderName = ''
    if (tool === 'clone') { cloneRepo = ''; cloneDirName = '' }
  }

  async function createNewFolder() {
    if (!fsData?.path || !newFolderName.trim()) return
    toolBusy = true
    toolError = ''
    try {
      const created = await mkdirHostFs(fsData.path, newFolderName.trim())
      activeTool = 'none'
      newFolderName = ''
      await browseHost(fsData.path)
      applyPath(created.path)
      workspace.toast(`已创建文件夹「${created.name}」`, 'success')
    } catch (failure) {
      toolError = errorText(failure)
    } finally { toolBusy = false }
  }

  async function removeFolderEntry(targetPath: string, folderName: string) {
    const ok = await workspace.confirm({
      title: `删除磁盘文件夹「${folderName}」`,
      description: `将永久删除磁盘上的目录 ${formatDisplayPath(targetPath)} 及其全部内容，此操作无法撤销。`,
      confirmLabel: '确认删除',
      danger: true,
    })
    if (!ok) return
    toolBusy = true
    fsError = ''
    try {
      await deleteHostFs(targetPath)
      if (workDir === targetPath || workDir.startsWith(targetPath + '/')) {
        workDir = ''
        if (!nameTouched) name = ''
      }
      await browseHost(fsData?.path || undefined)
      workspace.toast(`已删除文件夹「${folderName}」`, 'info')
    } catch (failure) {
      fsError = errorText(failure)
    } finally { toolBusy = false }
  }

  async function runClone() {
    if (!fsData?.path || !cloneRepo.trim()) return
    toolBusy = true
    toolError = ''
    try {
      const cloned = await cloneHostRepo(fsData.path, cloneRepo.trim(), cloneDirName.trim() || undefined)
      activeTool = 'none'
      cloneRepo = ''
      cloneDirName = ''
      await browseHost(fsData.path)
      applyPath(cloned.path)
      workspace.toast(`已克隆仓库到「${cloned.name}」`, 'success')
    } catch (failure) {
      toolError = errorText(failure)
    } finally { toolBusy = false }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const payload = {
        name: name.trim(),
        work_dir: workDir.trim() || null,
        host_bot_id: hostBotId || null,
        host_name: hostBotId ? (selectedDevice?.hostname ?? selectedDevice?.display_name ?? initial?.host_name ?? null) : null,
        description: description.trim(),
      }
      const saved = initial
        ? await api(`/workspaces/${initial.id}`, workspaceSchema, 'PATCH', workspacePatchSchema.parse(payload))
        : await api('/workspaces', workspaceSchema, 'POST', workspaceCreateSchema.parse({ ...payload, create_default_channel: createDefault }))
      await workspace.syncLists()
      if (!initial) {
        const first = workspace.channels.find(c => c.type !== 'dm' && c.workspace_id === saved.id)
        if (first) workspace.select(first.id)
      }
      workspace.toast(initial ? '文件夹分组已更新' : `已添加文件夹「${saved.name}」`, 'success')
      close()
    } catch (failure) { error = errorText(failure) }
    finally { busy = false }
  }

  async function deleteFolder() {
    if (!initial) return
    const ok = await workspace.confirm({
      title: `删除文件夹分组「${initial.name}」`,
      description: '将删除该分组下的全部频道和聊天记录（不会删除你电脑上的本地文件）。此操作不可撤销。',
      confirmLabel: '确认删除',
      danger: true,
    })
    if (!ok) return
    busy = true
    error = ''
    try {
      await remove(`/workspaces/${initial.id}`)
      await workspace.syncLists()
      workspace.toast(`已删除分组「${initial.name}」`, 'info')
      close()
    } catch (failure) { error = errorText(failure) }
    finally { busy = false }
  }
</script>

<form class="stack-form" onsubmit={submit}>
  {#if remoteDevices.length}
    <label>
      <span class="label-with-icon"><HardDrive size={13} /> 来源设备</span>
      <select bind:value={hostBotId} onchange={onDeviceChange}>
        <option value="">● 本机（默认 ~ 目录）</option>
        {#each remoteDevices as dev (dev.bot_id)}
          <option value={dev.bot_id}>
            {dev.online ? '● 在线' : '○ 离线'} · {dev.hostname ?? dev.display_name} (@{dev.username})
          </option>
        {/each}
      </select>
    </label>
  {/if}

  {#if browsingHost || selectedDevice?.online}
    <div class="remote-browser">
      <div class="remote-browser-head">
        <span class="remote-path" title={fsData?.path || '~'}>
          <FolderOpen size={13} />
          {browsingHost ? formatDisplayPath(fsData?.path) : (fsData?.path ? shortPath(fsData.path) : `${selectedDevice?.hostname ?? selectedDevice?.display_name} · 已授权目录`)}
        </span>
        <div class="remote-browser-actions">
          {#if fsData && fsData.parent !== null}
            <button type="button" class="button quiet compact" disabled={fsLoading || toolBusy} onclick={() => void browse(fsData?.parent || undefined)}>
              <ArrowUp size={12} /> 上一级
            </button>
          {/if}
          {#if fsData?.path}
            <button type="button" class="button primary compact" disabled={toolBusy} onclick={() => applyPath(fsData!.path)}>
              <Check size={12} /> 选当前目录
            </button>
          {/if}
          <button type="button" class="icon-button" title="刷新目录" aria-label="刷新目录" disabled={fsLoading || toolBusy}
            onclick={() => void browse(fsData?.path || undefined)}>
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {#if canModifyFs}
        <div class="fs-toolbar">
          <button type="button" class="button quiet compact" class:active-tool={activeTool === 'mkdir'} disabled={toolBusy}
            onclick={() => openTool('mkdir')}>
            <FolderPlus size={13} /> 新建文件夹
          </button>
          <button type="button" class="button quiet compact" class:active-tool={activeTool === 'clone'} disabled={toolBusy}
            onclick={() => openTool('clone')}>
            <GitBranch size={13} /> Clone GitHub 仓库
          </button>
        </div>

        {#if activeTool === 'mkdir'}
          <div class="fs-inline-panel">
            <div class="fs-inline-row">
              <input bind:value={newFolderName} placeholder="输入新文件夹名称，例如 my-project" maxlength={128}
                spellcheck={false} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createNewFolder() } }} />
              <button type="button" class="button primary compact" disabled={toolBusy || !newFolderName.trim()} onclick={() => void createNewFolder()}>
                {#if toolBusy}<span class="spinner"></span>{:else}创建{/if}
              </button>
              <button type="button" class="icon-button" aria-label="取消" onclick={() => { activeTool = 'none'; toolError = '' }}>
                <X size={14} />
              </button>
            </div>
            {#if toolError}<p class="form-error" role="alert">{toolError}</p>{/if}
          </div>
        {:else if activeTool === 'clone'}
          <div class="fs-inline-panel">
            <div class="fs-inline-row">
              <input bind:value={cloneRepo} placeholder="GitHub 仓库，如 owner/repo 或 https://github.com/..." maxlength={512}
                spellcheck={false} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runClone() } }} />
            </div>
            <div class="fs-inline-row">
              <input bind:value={cloneDirName} placeholder="可选：自定义目录名（留空使用仓库名）" maxlength={128}
                spellcheck={false} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runClone() } }} />
              <button type="button" class="button primary compact" disabled={toolBusy || !cloneRepo.trim()} onclick={() => void runClone()}>
                {#if toolBusy}<span class="spinner"></span> 克隆中…{:else}开始 Clone{/if}
              </button>
              <button type="button" class="icon-button" aria-label="取消" disabled={toolBusy} onclick={() => { activeTool = 'none'; toolError = '' }}>
                <X size={14} />
              </button>
            </div>
            {#if toolError}<p class="form-error" role="alert">{toolError}</p>{/if}
          </div>
        {/if}
      {/if}

      {#if fsLoading}
        <div class="remote-browser-empty"><span class="spinner"></span> 正在读取目录…</div>
      {:else if fsError}
        <div class="remote-browser-empty danger-text">{fsError}</div>
      {:else if fsData?.entries.length}
        <div class="remote-browser-list">
          {#each fsData.entries as item (item.path)}
            <div class="remote-dir-row" class:selected={workDir === item.path}>
              <button type="button" class="remote-dir-pick" onclick={() => applyPath(item.path)}
                ondblclick={() => void browse(item.path)} title={`单击选中，双击进入 ${item.path}`}>
                <Folder size={13} />
                <span>{item.name}</span>
                {#if !fsData.path}<small>{shortPath(item.path)}</small>{/if}
              </button>
              {#if canModifyFs}
                <button type="button" class="icon-button danger-on-hover" title={`删除文件夹 ${item.name}`} aria-label={`删除 ${item.name}`}
                  disabled={toolBusy} onclick={() => void removeFolderEntry(item.path, item.name)}>
                  <Trash2 size={13} />
                </button>
              {/if}
              <button type="button" class="icon-button" title="进入子目录" aria-label={`进入 ${item.name}`}
                disabled={toolBusy} onclick={() => void browse(item.path)}>
                <ChevronRight size={14} />
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="remote-browser-empty">当前目录下暂无子文件夹</div>
      {/if}
    </div>
  {:else if selectedDevice}
    <p class="muted">设备「{selectedDevice.hostname ?? selectedDevice.display_name}」当前离线，无法浏览目录；请切换回本机或等待设备上线。</p>
  {/if}

  <div class="selected-dir-bar">
    <FolderOpen size={13} />
    {#if workDir}
      <span class="selected-dir-label">已选目录：<code>{formatDisplayPath(workDir)}</code></span>
      <button type="button" class="icon-button" title="清除目录选择" aria-label="清除目录选择" onclick={() => { workDir = ''; if (!nameTouched) name = '' }}>
        <X size={13} />
      </button>
    {:else}
      <span class="muted">单击上方文件夹选中目录，或点「选当前目录」（留空则创建普通聊天分组）</span>
    {/if}
  </div>

  <label>分组名称
    <input bind:value={name} oninput={() => { nameTouched = true }} required maxlength={100} placeholder="选中文件夹后自动填充，也可自定义" />
  </label>

  <label>备注说明（可选）
    <textarea bind:value={description} rows="2" maxlength={1000} placeholder="项目说明或备注"></textarea>
  </label>

  {#if !initial}
    <label class="check-row"><input type="checkbox" bind:checked={createDefault} /> 同时创建默认 <code>#general</code> 频道</label>
  {/if}

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  <div class="dialog-actions">
    {#if canDelete}
      <button type="button" class="button quiet danger-on-hover push-right" disabled={busy} onclick={() => void deleteFolder()}>
        <Trash2 size={14} /> 删除分组
      </button>
    {/if}
    <button type="button" class="button quiet" onclick={close}>取消</button>
    <button type="submit" class="button primary" disabled={busy || toolBusy}>{initial ? '保存设置' : '添加文件夹'}</button>
  </div>
</form>
