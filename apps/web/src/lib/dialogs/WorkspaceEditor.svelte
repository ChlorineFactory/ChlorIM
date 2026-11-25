<script lang="ts">
  import { untrack } from 'svelte'
  import { FolderOpen, Trash2 } from 'lucide-svelte'
  import { workspaceCreateSchema, workspacePatchSchema, workspaceSchema } from '@chiorim/shared'
  import type { Workspace as FolderGroup } from '@chiorim/shared'
  import { api, errorText, remove } from '$lib/api'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, initial, close }: {
    workspace: Workspace
    initial?: FolderGroup
    close: () => void
  } = $props()

  const canDelete = $derived(Boolean(initial && (workspace.user?.is_admin || workspace.user?.id === initial.created_by) && workspace.workspaces.length > 1))

  let workDir = $state(untrack(() => initial?.work_dir ?? ''))
  let name = $state(untrack(() => initial?.name ?? ''))
  let nameTouched = $state(untrack(() => Boolean(initial?.name)))
  let description = $state(untrack(() => initial?.description ?? ''))
  let createDefault = $state(true)
  let busy = $state(false)
  let error = $state('')

  function handlePathInput() {
    if (nameTouched) return
    const cleaned = workDir.trim().replace(/[\\/]+$/, '')
    const base = cleaned.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
    name = base
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const payload = {
        name: name.trim(),
        work_dir: workDir.trim() || null,
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
  <label>
    <span class="label-with-icon"><FolderOpen size={13} /> 本机文件夹路径</span>
    <input bind:value={workDir} oninput={handlePathInput} maxlength={4096} spellcheck={false}
      placeholder="/Users/你的用户名/Documents/Codes/ChiorIM" />
    <small>分组下所有频道的本地 Agent（Codex / Claude / agy）默认在此目录工作；子频道还可填子路径如 <code>apps/web</code>。</small>
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
