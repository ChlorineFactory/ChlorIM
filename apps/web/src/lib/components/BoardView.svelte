<script lang="ts">
  import { CheckCircle2, Circle, MessageSquare, SmilePlus, StickyNote } from 'lucide-svelte'
  import type { Attachment, Channel } from '@chiorim/shared'
  import { formatStamp } from '$lib/format'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import Avatar from './Avatar.svelte'
  import AttachmentView from './Attachment.svelte'
  import Markdown from './Markdown.svelte'

  let { workspace, channel, preview }: {
    workspace: Workspace; channel: Channel; preview: (file: Attachment) => void
  } = $props()

  let filter = $state<'all' | 'open' | 'done'>('all')
  const feed = $derived(workspace.feed(channel.id, null))
  const notes = $derived((feed?.rows ?? []).slice().reverse().filter(item => {
    if (filter === 'open') return (item.board_status ?? 'open') === 'open'
    if (filter === 'done') return item.board_status === 'done'
    return true
  }))
  const counts = $derived({
    all: feed?.rows.length ?? 0,
    open: (feed?.rows ?? []).filter(item => (item.board_status ?? 'open') === 'open').length,
    done: (feed?.rows ?? []).filter(item => item.board_status === 'done').length,
  })
</script>

<div class="board-shell">
  <div class="board-toolbar">
    <div class="board-tabs">
      <button type="button" class:active={filter === 'all'} onclick={() => { filter = 'all' }}>全部 ({counts.all})</button>
      <button type="button" class:active={filter === 'open'} onclick={() => { filter = 'open' }}>待处理 ({counts.open})</button>
      <button type="button" class:active={filter === 'done'} onclick={() => { filter = 'done' }}>已处理 ({counts.done})</button>
    </div>
    {#if feed?.before}
      <button type="button" class="button quiet compact" disabled={feed.loading}
        onclick={() => workspace.loadFeed(channel.id, null, 'older')}>加载更早留言</button>
    {/if}
  </div>

  {#if !feed?.loaded && !feed?.error}
    <div class="feed-status"><span class="spinner"></span> 正在加载留言板…</div>
  {:else if !notes.length}
    <div class="board-empty">
      <StickyNote size={30} />
      <h3>{filter === 'all' ? '留言板还是空的' : filter === 'open' ? '没有待处理留言' : '还没有已处理留言'}</h3>
      <p class="muted">在下方输入框发一条留言，离线好友上线后可以按卡片浏览、点开讨论并标记已处理。</p>
    </div>
  {:else}
    <div class="board-grid">
      {#each notes as note (note.id)}
        {@const author = workspace.directory[note.author_id] ?? note.author}
        {@const done = note.board_status === 'done'}
        <article class="board-card" class:done>
          <header class="board-card-head">
            <div class="member-identity">
              <Avatar user={author} size={28} />
              <span>
                <strong>{note.webhook_name ?? author.display_name}</strong>
                <small>{formatStamp(note.created_at)}</small>
              </span>
            </div>
            <button type="button" class="board-chip" class:done
              onclick={() => void workspace.setBoardStatus(note, done ? 'open' : 'done').catch(e => workspace.report(e))}>
              {#if done}<CheckCircle2 size={13} /> 已处理{:else}<Circle size={13} /> 待处理{/if}
            </button>
          </header>

          <div class="board-card-body">
            {#if note.content}<Markdown content={note.content} />{/if}
            {#if note.blocks.some(b => b.type === 'attachment')}
              <div class="attachments">
                {#each note.blocks.filter(b => b.type === 'attachment') as file}
                  <AttachmentView {file} {preview} />
                {/each}
              </div>
            {/if}
          </div>

          <footer class="board-card-foot">
            <div class="reaction-row">
              {#each note.reactions as item (item.emoji)}
                <button type="button" class="reaction-pill" class:mine={Boolean(workspace.user && item.user_ids.includes(workspace.user.id))}
                  onclick={() => void workspace.react(note.id, item.emoji).catch(e => workspace.report(e))}>
                  <span>{item.emoji}</span><small>{item.count}</small>
                </button>
              {/each}
              <button type="button" class="reaction-pill add-react" title="点赞"
                onclick={() => void workspace.react(note.id, '👍').catch(e => workspace.report(e))}>
                <SmilePlus size={12} />
              </button>
            </div>
            <button type="button" class="board-discuss" onclick={() => workspace.openThread(note.id)}>
              <MessageSquare size={13} />
              {note.reply_count ? `${note.reply_count} 条讨论` : '回复讨论'}
            </button>
          </footer>
        </article>
      {/each}
    </div>
  {/if}
</div>
