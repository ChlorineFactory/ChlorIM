<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { ArrowDown, ArrowUp, Clock3, MessageSquareText, Sparkles, X } from 'lucide-svelte'
  import type { Attachment, Channel } from '@chiorim/shared'
  import { dayKey, formatDay, formatTime } from '$lib/format'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import MessageRow from './MessageRow.svelte'
  import Markdown from './Markdown.svelte'
  import Avatar from './Avatar.svelte'
  import AttachmentView from './Attachment.svelte'

  let { workspace, channel, thread = null, preview }: {
    workspace: Workspace; channel: Channel; thread?: string | null; preview: (file: Attachment) => void
  } = $props()

  const feed = $derived(workspace.feed(channel.id, thread))
  const rows = $derived(feed?.rows ?? [])
  const pending = $derived(workspace.pending.filter(row => row.channel === channel.id && (row.payload.thread_root_id ?? null) === thread))
  const root = $derived(thread ? workspace.findMessage(thread) : undefined)
  const title = $derived(channel.type === 'dm' ? channel.dm_peer?.display_name ?? '私聊' : channel.name)
  const unreadMarker = $derived(!thread ? workspace.unreadStartId[channel.id] : null)
  let viewport: HTMLDivElement
  let content: HTMLDivElement
  let atBottom = $state(true)
  let loadingOlder = false

  const markRead = () => {
    if (!thread && workspace.threadId && window.matchMedia('(max-width: 950px)').matches) return
    const last = rows.at(-1)?.id ?? root?.id
    if (last && atBottom) workspace.markRead(channel.id, last)
  }

  function bottom() {
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    atBottom = true
    markRead()
  }

  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (atBottom && !loadingOlder && !workspace.highlightedId) bottom()
    })
    observer.observe(content)
    const visible = () => { if (document.visibilityState === 'visible') markRead() }
    document.addEventListener('visibilitychange', visible)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', visible)
    }
  })

  $effect(() => {
    const target = workspace.highlightedId
    if (!target || !viewport) return
    const exists = rows.some(row => row.id === target)
    if (!exists) return
    void tick().then(() => {
      const el = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)
      if (el) {
        atBottom = false
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
  })

  $effect(() => {
    const count = rows.length + pending.length
    const latest = rows.at(-1)?.id
    const mainVisible = thread || !workspace.threadId || !window.matchMedia('(max-width: 950px)').matches
    if (mainVisible && (count || latest || root?.id)) untrack(() => {
      if (atBottom && !loadingOlder && !workspace.highlightedId) void tick().then(bottom)
    })
  })

  async function older() {
    if (!viewport || loadingOlder || feed?.loading || !feed?.before) return
    loadingOlder = true
    const height = viewport.scrollHeight
    const offset = viewport.scrollTop
    try {
      await workspace.loadFeed(channel.id, thread, 'older')
      await tick()
      if (viewport.isConnected) viewport.scrollTop = offset + viewport.scrollHeight - height
    } finally { loadingOlder = false }
  }

  function scroll() {
    atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48
    if (atBottom) markRead()
    else if (viewport.scrollTop <= 32 && !feed?.error) void older()
  }

  async function resendPending(nonce: string, ch: string, payload: Workspace['pending'][number]['payload'], state: string) {
    if (state === 'unconfirmed') {
      const ok = await workspace.confirm({
        title: '确认重发',
        description: '服务器可能已收到这条消息，重发可能产生重复。确定仍要重发吗？',
        confirmLabel: '仍要重发',
      })
      if (!ok) return
    }
    workspace.dismissPending(nonce)
    void workspace.submit(ch, payload).catch(error => workspace.report(error))
  }
</script>

<div class="feed-shell">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scroll region is keyboard focusable) -->
  <div class="message-viewport" bind:this={viewport} onscroll={scroll} role="region" aria-label={thread ? 'Thread 回复' : '频道消息'} tabindex="0">
    <div class="message-flow" class:has-top-anchor={Boolean(thread)} bind:this={content}>
      {#if thread && root}
        <div class="thread-origin">
          <div class="kicker"><MessageSquareText size={13} /> 原始消息</div>
          <MessageRow message={root} {workspace} {preview} threadRoot />
        </div>
      {/if}

      {#if feed?.error}
        <div class="feed-status" role="alert">
          {feed.error}
          <button type="button" class="button quiet" onclick={() => workspace.loadFeed(channel.id, thread, 'sync')}>重试</button>
        </div>
      {/if}

      {#if feed?.before}
        <div class="load-earlier">
          <button type="button" class="button quiet" disabled={feed.loading} onclick={older}>
            <ArrowUp size={14} /> {feed.loading ? '加载中…' : '加载更早消息'}
          </button>
        </div>
      {:else if !feed?.loaded && !feed?.error}
        <div class="feed-status"><span class="spinner"></span> 正在加载消息…</div>
      {:else if feed?.loaded && !thread}
        <div class="room-start">
          <h2>{channel.type === 'dm' ? title : `# ${title}`}</h2>
          {#if channel.topic}<p>{channel.topic}</p>{/if}
          {#if channel.system_context}
            <div class="context-pill"><Sparkles size={12} /> 频道共享上下文已启用</div>
          {/if}
        </div>
      {:else if feed?.loaded && thread && !rows.length}
        <div class="feed-status">暂无回复</div>
      {/if}

      {#each rows as row, index (row.id)}
        {@const previous = rows[index - 1]}
        {@const newDay = !previous || dayKey(previous.created_at) !== dayKey(row.created_at)}
        {@const group = !thread && !newDay && !row.reply_to_id && !row.webhook_name && !previous.webhook_name &&
          previous.author_id === row.author_id && row.created_at - previous.created_at <= 300_000 &&
          previous.status === 'done' && row.status === 'done' && channel.type !== 'board'}
        {#if newDay}
          <div class="date-divider"><time datetime={new Date(row.created_at).toISOString()}>{formatDay(row.created_at)}</time></div>
        {/if}
        {#if unreadMarker && row.id === unreadMarker}
          <div class="unread-divider"><span>新消息</span></div>
        {/if}
        <MessageRow message={row} {group} {workspace} {preview} isBoard={channel.type === 'board'} />
      {/each}

      {#each pending as row (row.nonce)}
        <article class="message-row optimistic">
          <div class="message-gutter">{#if workspace.user}<Avatar user={workspace.user} size={34} />{/if}</div>
          <div class="message-body">
            <header class="message-byline">
              <strong>{workspace.user?.display_name}</strong>
              <time datetime={new Date(row.createdAt).toISOString()}>{formatTime(row.createdAt)}</time>
            </header>
            {#if row.payload.content}<Markdown content={row.payload.content} />{/if}
            {#if row.payload.attachments?.length}
              <div class="attachments">
                {#each row.payload.attachments as file (file.url)}<AttachmentView {file} {preview} />{/each}
              </div>
            {/if}
            {#if row.state === 'sending'}
              <div class="message-status"><Clock3 size={13} /> 发送中…</div>
            {:else}
              <div class="message-status danger" role="status">
                <span>{row.error}</span>
                <button class="button quiet" type="button" onclick={() => void resendPending(row.nonce, row.channel, row.payload, row.state)}>重发</button>
                <button class="icon-button" type="button" aria-label="移除本地消息" onclick={() => workspace.dismissPending(row.nonce)}><X size={14} /></button>
              </div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  </div>
  {#if !atBottom}
    <button type="button" class="jump-bottom button" onclick={bottom}><ArrowDown size={14} /> 跳到最新</button>
  {/if}
</div>
