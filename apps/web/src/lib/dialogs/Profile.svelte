<script lang="ts">
  import { untrack } from 'svelte'
  import { profilePatchSchema, userSchema } from '@chiorim/shared'
  import type { PresenceStatus, User } from '@chiorim/shared'
  import { api, errorText } from '$lib/api'
  import { PRESENCE_META } from '$lib/presets'
  import AvatarField from '$lib/components/AvatarField.svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, user }: { workspace: Workspace; user: User } = $props()
  let name = $state(untrack(() => user.display_name))
  let avatar = $state(untrack(() => user.avatar_url ?? ''))
  let bio = $state(untrack(() => user.bio))
  let presence = $state<PresenceStatus>(untrack(() => user.presence_status))
  let statusText = $state(untrack(() => user.status_text))
  let uploading = $state(false)
  let busy = $state(false)
  let error = $state('')

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const patch = profilePatchSchema.parse({
        display_name: name,
        bio,
        avatar_url: avatar.trim() || null,
        presence_status: presence,
        status_text: statusText.trim(),
      })
      const updated = await api('/users/me', userSchema, 'PATCH', patch)
      workspace.user = updated
      if (workspace.directory[updated.id]) {
        workspace.directory[updated.id] = { ...workspace.directory[updated.id], ...updated }
      }
      workspace.toast('个人资料已保存', 'success')
    } catch (failure) { error = errorText(failure) }
    finally { busy = false }
  }
</script>

<form class="stack-form" onsubmit={submit}>
  <AvatarField bind:value={avatar} {name} onbusy={(value) => { uploading = value }} />

  <div class="form-row two">
    <label>显示名称<input bind:value={name} maxlength={100} required /></label>
    <label>用户名<input value={'@' + user.username} readonly /></label>
  </div>

  <div class="form-row two">
    <label>在线状态
      <select bind:value={presence}>
        {#each (['online', 'busy', 'away'] as const) as item}
          <option value={item}>{PRESENCE_META[item].label}</option>
        {/each}
      </select>
    </label>
    <label>状态签名<input bind:value={statusText} maxlength={120} placeholder="例如：写代码中、有事留言" /></label>
  </div>

  <label>个人简介<textarea bind:value={bio} maxlength={2000} rows="3" placeholder="介绍一下自己"></textarea></label>

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  <div class="dialog-actions">
    <button class="button primary" disabled={busy || uploading} type="submit">{busy ? '保存中…' : '保存更改'}</button>
  </div>
</form>
