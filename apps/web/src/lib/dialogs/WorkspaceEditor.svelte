<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { ArrowUp, Check, ChevronRight, Folder, FolderOpen, HardDrive, RefreshCw, Trash2 } from 'lucide-svelte'
  import { workspaceCreateSchema, workspacePatchSchema, workspaceSchema } from '@chiorim/shared'
  import type { BridgeDevice, BridgeFsList, Workspace as FolderGroup } from '@chiorim/shared'
  import { api, errorText, listBridgeDevices, listBridgeFs, remove } from '$lib/api'
  import { shortPath } from '$lib/format'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, initial, close }: {
    workspace: Workspace
    initial?: FolderGroup
    close: () => void
  } = $props()

  const canDelete = $derived(Boolean(initial && (workspace.user?.is_admin || workspace.user?.id === initial.created_by) && workspace.workspaces.length > 1))

  let devices = $state<BridgeDevice[]>([])
  let hostBotId = $state(untrack(() => initial?.host_bot_id ?? ''))
  let workDir = $state(untrack(() => initial?.work_dir ?? ''))
  let name = $state(untrack(() => initial?.name ?? ''))
  let nameTouched = $state(untrack(() => Boolean(initial?.name)))
  let description = $state(untrack(() => initial?.description ?? ''))
  let createDefault = $state(true)
  let busy = $state(false)
  let error = $state('')

  let fsData = $state<BridgeFsList | null>(null)
  let fsLoading = $state(false)
  let fsError = $state('')

  const selectedDevice = $derived(devices.find(item => item.bot_id === hostBotId) ?? null)

  onMount(() => {
    void listBridgeDevices().then(list => {
      devices = list
      const current = list.find(item => item.bot_id === hostBotId)
      if (current?.online) void browse(workDir || undefined)
    }).catch(() => {})
  })

  function applyPath(nextPath: string) {
    workDir = nextPath
    if (nameTouched) return
    const cleaned = nextPath.trim().replace(/[\\/]+$/, '')
    const base = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    if (base) name = base
  }

  function handlePathInput() {
    if (nameTouched) return
    const cleaned = workDir.trim().replace(/[\\/]+$/, '')
    name = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  }

  async function browse(targetPath?: string) {
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
    if (selectedDevice?.online) void browse()
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
  {#if devices.length}
    <label>
      <span class="label-with-icon"><HardDrive size={13} /> 来源设备（可选，在线时可直接浏览文件夹）</span>
      <select bind:value={hostBotId} onchange={onDeviceChange}>
        <option value="">不绑定特定设备（手动输入路径）</option>
        {#each devices as dev (dev.bot_id)}
          <option value={dev.bot_id}>
            {dev.online ? '● 在线' : '○ 离线'} · {dev.hostname ?? dev.display_name} (@{dev.username})
          </option>
        {/each}
      </select>
    </label>
  {/if}

  {#if hostBotId && selectedDevice}
    {#if selectedDevice.online}
      <div class="remote-browser">
        <div class="remote-browser-head">
          <span class="remote-path" title={fsData?.path || '已授权根目录'}>
            <FolderOpen size={13} />
            {fsData?.path ? shortPath(fsData.path) : `${selectedDevice.hostname ?? selectedDevice.display_name} · 已授权目录`}
          </span>
          <div class="remote-browser-actions">
            {#if fsData && fsData.parent !== null}
              <button type="button" class="button quiet compact" disabled={fsLoading} onclick={() => void browse(fsData?.parent || undefined)}>
                <ArrowUp size={12} /> 上一级
              </button>
            {/if}
            {#if fsData?.path}
              <button type="button" class="button primary compact" onclick={() => applyPath(fsData!.path)}>
                <Check size={12} /> 选当前目录
              </button>
            {/if}
            <button type="button" class="icon-button" title="刷新目录" aria-label="刷新目录" disabled={fsLoading}
              onclick={() => void browse(fsData?.path || undefined)}>
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {#if fsLoading}
          <div class="remote-browser-empty"><span class="spinner"></span> 正在读取设备文件夹…</div>
        {:else if fsError}
          <div class="remote-browser-empty danger-text">{fsError}</div>
        {:else if fsData?.entries.length}
          <div class="remote-browser-list">
            {#each fsData.entries as item (item.path)}
              <div class="remote-dir-row" class:selected={workDir === item.path}>
                <button type="button" class="remote-dir-pick" onclick={() => applyPath(item.path)} title={`选中 ${item.path}`}>
                  <Folder size={13} />
                  <span>{item.name}</span>
                  {#if !fsData.path}<small>{shortPath(item.path)}</small>{/if}
                </button>
                <button type="button" class="icon-button" title="进入子目录" aria-label={`进入 ${item.name}`}
                  onclick={() => void browse(item.path)}>
                  <ChevronRight size={14} />
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div class="remote-browser-empty">当前目录下暂无可选子文件夹</div>
        {/if}
      </div>
    {:else}
      <p class="muted">设备「{selectedDevice.hostname ?? selectedDevice.display_name}」当前离线，无法浏览目录；你仍可手动输入路径，离线期间 @该设备 Agent 的任务会自动排队。</p>
    {/if}
  {/if}

  <label>
    <span class="label-with-icon"><FolderOpen size={13} /> 本机文件夹路径</span>
    <input bind:value={workDir} oninput={handlePathInput} maxlength={4096} spellcheck={false}
      placeholder="/Users/你的用户名/Documents/Codes/ChiorIM" />
    <small>分组下所有频道的本地 Agent 默认在此目录工作；子频道还可填子路径如 <code>apps/web</code>。</small>
  </label>

  <label>分组名称
    <input bind:value={name} oninput={() => { nameTouched = true }} required maxlength={100} placeholder="自动取自文件夹名，也可自定义" />
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
    <button type="submit" class="button primary" disabled={busy}>{initial ? '保存设置' : '添加文件夹'}</button>
  </div>
</form>
