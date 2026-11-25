<script lang="ts">
  import { Bot, UsersRound } from 'lucide-svelte'
  import type { Member } from '@chiorim/shared'
  import { shortPath } from '$lib/format'
  import Avatar from './Avatar.svelte'

  let { members, open }: { members: Member[]; open: (id: string) => void } = $props()

  const groups = $derived([
    { title: '在线成员', rows: members.filter(member => member.kind === 'human' && member.online) },
    { title: 'Bots & Agents', rows: members.filter(member => member.kind === 'bot') },
    { title: '离线成员', rows: members.filter(member => member.kind === 'human' && !member.online) },
  ])

  function description(member: Member) {
    if (member.kind === 'human') return member.status_text || undefined
    if (member.bot?.mode === 'provider') return member.bot.model ? `模型 · ${member.bot.model}` : '未配置模型'
    if (member.bot?.mode === 'bridge') {
      if (!member.online) return '本地 Bridge 离线'
      const runtime = member.bot.runtime_meta
      if (runtime) return runtime.cwd ? `${runtime.driver} · ${shortPath(runtime.cwd)}` : runtime.driver
      return member.bot.driver_hint ?? '已连接'
    }
    return undefined
  }
</script>

<div class="member-list">
  {#each groups as group (group.title)}
    {#if group.rows.length || group.title === 'Bots & Agents'}
      <section>
        <h3 class="member-heading">
          {#if group.title === 'Bots & Agents'}<Bot size={13} />{/if}
          {group.title}
          <span>{group.rows.length}</span>
        </h3>
        {#each group.rows as member (member.id)}
          {@const detail = description(member)}
          <button type="button" class="member-row" onclick={() => open(member.id)}
            title={member.bot?.runtime_meta?.cwd ?? (member.status_text || member.display_name)}>
            <Avatar user={member} size={34} online={member.online} status={member.presence_status} />
            <span class="member-text">
              <strong>
                <span class="truncate">{member.display_name}</span>
                {#if member.kind === 'bot'}<span class="bot-tag">{member.bot?.mode === 'bridge' ? 'AGENT' : 'BOT'}</span>{/if}
              </strong>
              <small>@{member.username}</small>
              {#if detail}<small class="member-sub" class:agent-offline={detail === '本地 Bridge 离线'}>{detail}</small>{/if}
            </span>
          </button>
        {:else}
          <p class="member-empty">当前频道暂无 Bot</p>
        {/each}
      </section>
    {/if}
  {/each}
  {#if !members.length}
    <div class="feed-status"><UsersRound size={15} /> 正在载入频道成员</div>
  {/if}
</div>
