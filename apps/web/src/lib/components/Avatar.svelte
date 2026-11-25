<script lang="ts">
  import { Bot } from 'lucide-svelte'
  import type { PresenceStatus, User } from '@chiorim/shared'
  import { presetById } from '$lib/presets'

  let { user, size = 32, online, status }: {
    user: Pick<User, 'id' | 'display_name' | 'avatar_url' | 'kind'> & { presence_status?: PresenceStatus }
    size?: number
    online?: boolean
    status?: PresenceStatus
  } = $props()

  let failed = $state<string | null>(null)
  const palette = ['#2d333b', '#332d29', '#27332d', '#2b2d38', '#36292e', '#263238']
  const tone = $derived(palette[[...user.id].reduce((h, c) => h + c.charCodeAt(0), 0) % palette.length])
  const initial = $derived([...user.display_name.trim()][0]?.toUpperCase() ?? '?')
  const preset = $derived(presetById(user.avatar_url))
  const effectiveStatus = $derived(status ?? user.presence_status ?? 'online')
</script>

<span class="avatar" class:is-bot={user.kind === 'bot'} style:--avatar-size="{size}px" aria-hidden="true">
  <span class="avatar-face" style:background={preset ? preset.bg : tone}>
    {#if preset}
      <span class="avatar-glyph">{preset.glyph}</span>
    {:else if user.avatar_url && failed !== user.avatar_url}
      <img src={user.avatar_url} alt="" referrerpolicy="no-referrer" onerror={() => { failed = user.avatar_url }} />
    {:else if user.kind === 'bot'}
      <Bot size={Math.round(size * 0.5)} strokeWidth={1.8} />
    {:else}
      {initial}
    {/if}
  </span>
  {#if online !== undefined}
    <span
      class="avatar-presence"
      class:online={online && effectiveStatus === 'online'}
      class:busy={online && effectiveStatus === 'busy'}
      class:away={online && effectiveStatus === 'away'}
    ></span>
  {/if}
</span>
