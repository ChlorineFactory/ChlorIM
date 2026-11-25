<script lang="ts">
  import { Upload, X } from 'lucide-svelte'
  import { avatarUrlSchema } from '@chiorim/shared'
  import type { User } from '@chiorim/shared'
  import Avatar from './Avatar.svelte'
  import { errorText, upload } from '$lib/api'
  import { AVATAR_PRESETS } from '$lib/presets'

  let { value = $bindable(''), name, kind = 'human', onbusy }: {
    value: string; name: string; kind?: User['kind']; onbusy: (busy: boolean) => void
  } = $props()

  let picker: HTMLInputElement
  let busy = $state(false)
  let error = $state('')
  const preview = $derived(avatarUrlSchema.safeParse(value.trim()))

  async function selected(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) { error = '请选择图片文件。'; return }
    busy = true
    onbusy(true)
    error = ''
    try { value = (await upload(file)).url } catch (failure) { error = errorText(failure) }
    finally { busy = false; onbusy(false) }
  }
</script>

<div class="avatar-picker-block">
  <div class="avatar-field">
    <Avatar user={{ id: name || 'preview', display_name: name || '头像', avatar_url: preview.success ? preview.data : null, kind }} size={54} />
    <div class="avatar-inputs">
      <div class="avatar-actions">
        <button class="button quiet" type="button" disabled={busy} onclick={() => picker.click()}>
          <Upload size={14} /> {busy ? '上传中…' : '上传图片'}
        </button>
        {#if value}
          <button class="button quiet" type="button" onclick={() => { value = '' }}><X size={14} /> 清除</button>
        {/if}
      </div>
      <input type="text" bind:value maxlength={2048} placeholder="或粘贴头像 URL / 点击下方预设" aria-label="头像 URL" />
      <input bind:this={picker} hidden type="file" accept="image/*" onchange={(event) => {
        void selected(event.currentTarget.files?.[0]); event.currentTarget.value = ''
      }} />
    </div>
  </div>
  <div class="preset-grid" role="group" aria-label="内置头像预设">
    {#each AVATAR_PRESETS as item (item.id)}
      <button type="button" class="preset-chip" class:selected={value === item.id}
        title={item.label} style:background={item.bg} onclick={() => { value = item.id }}>
        {item.glyph}
      </button>
    {/each}
  </div>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</div>
