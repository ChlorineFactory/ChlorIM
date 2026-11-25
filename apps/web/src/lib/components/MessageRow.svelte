<script lang="ts">
  import {
    Bookmark, Brain, Check, CheckCircle2, ChevronDown, Circle, Clock, CornerUpLeft, MessageSquare,
    Pencil, Pin, PinOff, Quote, RotateCcw, SmilePlus, Square, Trash2, Webhook, Wrench, X,
  } from 'lucide-svelte'
  import type { Attachment as FileAttachment, Message, User } from '@chiorim/shared'
  import { messagePatchSchema, messageSchema } from '@chiorim/shared'
  import Avatar from './Avatar.svelte'
  import Attachment from './Attachment.svelte'
  import Markdown from './Markdown.svelte'
  import { api, errorText, remove } from '$lib/api'
  import { formatStamp, formatTime } from '$lib/format'
  import { QUICK_EMOJIS } from '$lib/presets'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { message, group = false, workspace, threadRoot = false, isBoard = false, preview }: {
    message: Message
    group?: boolean
    workspace: Workspace
    threadRoot?: boolean
    isBoard?: boolean
    preview: (file: FileAttachment) => void
  } = $props()

  const author: User = $derived(workspace.directory[message.author_id] ?? message.author)
  const isWebhook = $derived(Boolean(message.webhook_name))
  const displayName = $derived(message.webhook_name ?? author.display_name)
  const canEdit = $derived(workspace.user?.id === message.author_id || workspace.user?.is_admin)
  const canPin = $derived(workspace.user?.is_admin || workspace.user?.id === workspace.active?.created_by)
  const isBotMsg = $derived(author.kind === 'bot' && !isWebhook)
  const pinned = $derived(
    workspace.active?.pinned_message_id === message.id || workspace.pins.some(item => item.id === message.id),
  )
  const bookmarked = $derived(workspace.bookmarkIds.has(message.id))
  const highlighted = $derived(workspace.highlightedId === message.id)
  const thinking = $derived(message.blocks.filter(block => block.type === 'thinking').map(block => block.text).join('\n'))
  const hasFiles = $derived(message.blocks.some(block => block.type === 'attachment'))

  let editing = $state(false)
  let emojiOpen = $state(false)
  let content = $state('')
  let busy = $state(false)
  let error = $state('')

  function beginEdit() { content = message.content; error = ''; editing = true }

  async function action(task: () => Promise<unknown>) {
    busy = true
    error = ''
    try { await task() } catch (failure) { error = errorText(failure) } finally { busy = false }
  }

  function edit() {
    return action(async () => {
      const patch = messagePatchSchema.parse({ content })
      const row = await api(`/messages/${message.id}`, messageSchema, 'PATCH', patch)
      workspace.applyMessage(row)
      editing = false
    })
  }

  async function deleteMessage() {
    const ok = await workspace.confirm({
      title: '删除消息',
      description: message.reply_count ? '确定删除这条消息及其全部 Thread 回复吗？此操作无法撤销。' : '确定删除这条消息吗？',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove(`/messages/${message.id}`)
      if (workspace.connection !== 'connected') {
        await workspace.loadFeed(message.channel_id, message.thread_root_id, 'sync')
        if (message.thread_root_id) await workspace.loadDetail(message.thread_root_id, true)
        else if (workspace.threadId === message.id) workspace.closeThread()
      }
    })
  }

  function togglePin() {
    return action(async () => {
      if (pinned) await workspace.unpinMessage(message.channel_id, message.id)
      else await workspace.pinMessage(message.channel_id, message.id)
    })
  }

  function react(emoji: string) {
    emojiOpen = false
    return action(() => workspace.react(message.id, emoji))
  }
</script>

<article class="message-row" data-message-id={message.id} class:grouped={group} class:thread-root={threadRoot} class:highlighted>
  <div class="message-gutter">
    {#if !group}
      <Avatar user={author} size={34} />
    {:else}
      <time class="group-time" datetime={new Date(message.created_at).toISOString()} title={formatStamp(message.created_at)}>{formatTime(message.created_at)}</time>
    {/if}
  </div>

  <div class="message-body">
    {#if message.reply_to}
      <button type="button" class="quote-banner" onclick={() => void workspace.jumpToMessage(message.channel_id, message.reply_to!.id, message.thread_root_id)}>
        <Quote size={12} />
        <strong>{message.reply_to.author_name}</strong>
        <span>{message.reply_to.content || '查看原消息'}</span>
      </button>
    {/if}

    {#if !group}
      <header class="message-byline">
        <strong>{displayName}</strong>
        {#if isWebhook}
          <span class="bot-tag webhook-tag"><Webhook size={10} /> WEBHOOK</span>
        {:else if author.kind === 'bot'}
          <span class="bot-tag">BOT</span>
        {/if}
        {#if author.disabled}
          <span class="archived-tag">已停用</span>
        {/if}
        <time datetime={new Date(message.created_at).toISOString()} title={formatStamp(message.created_at)}>{formatTime(message.created_at)}</time>
        {#if message.updated_at > message.created_at + 1000 && message.status === 'done' && !isBotMsg}
          <span class="edited-tag">(已编辑)</span>
        {/if}
        {#if pinned}<Pin size={12} class="pin-indicator" />{/if}
        {#if isBoard && !message.thread_root_id && message.board_status}
          <button type="button" class="board-chip" class:done={message.board_status === 'done'}
            onclick={() => action(() => workspace.setBoardStatus(message, message.board_status === 'done' ? 'open' : 'done'))}>
            {#if message.board_status === 'done'}<CheckCircle2 size={12} /> 已处理{:else}<Circle size={12} /> 待处理{/if}
          </button>
        {/if}
      </header>
    {/if}

    {#if thinking}
      <details class="thinking">
        <summary><Brain size={14} /> 思考过程 {#if message.status === 'streaming'}<span class="thinking-pulse"></span>{/if}<ChevronDown size={13} /></summary>
        <div>{thinking}</div>
      </details>
    {/if}

    {#each message.blocks.filter(block => block.type === 'tool_call') as block (block.id)}
      <details class="tool-block">
        <summary>
          <Wrench size={13} />
          <code>{block.name}</code>
          <span class="tool-state" class:done={block.status === 'done'} class:failed={block.status === 'error'}>
            {#if block.status === 'running'}<span class="spinner"></span> 运行中
            {:else if block.status === 'done'}<Check size={13} /> 完成
            {:else}<X size={13} /> 失败{/if}
          </span>
          <ChevronDown size={13} />
        </summary>
        <div class="tool-payload">
          {#if block.input !== undefined}<span>输入</span><pre>{JSON.stringify(block.input, null, 2)}</pre>{/if}
          {#if block.output !== undefined}<span>输出</span><pre>{JSON.stringify(block.output, null, 2)}</pre>{/if}
          {#if block.input === undefined && block.output === undefined}<span>暂无工具详情</span>{/if}
        </div>
      </details>
    {/each}

    {#if editing}
      <form class="inline-edit" onsubmit={(event) => { event.preventDefault(); void edit() }}>
        <textarea aria-label="编辑消息" bind:value={content} rows="3" maxlength={60000}></textarea>
        <div class="row-actions">
          <button type="button" class="button quiet" onclick={() => { editing = false; error = '' }}>取消</button>
          <button type="submit" class="button primary" disabled={busy || (!content.trim() && !hasFiles)}>保存</button>
        </div>
      </form>
    {:else if message.content}
      <Markdown content={message.content} />
    {/if}

    {#if hasFiles}
      <div class="attachments">
        {#each message.blocks.filter(block => block.type === 'attachment') as file}
          <Attachment {file} {preview} />
        {/each}
      </div>
    {/if}

    {#if message.status === 'queued'}
      <div class="stream-state queued-state" role="status">
        <Clock size={12} />
        <span>设备离线，已加入待执行队列（上线后自动运行）</span>
        <button class="button quiet stop-button" type="button" disabled={busy}
          onclick={() => action(() => workspace.abort(message.id))}><X size={11} /> 取消排队</button>
      </div>
    {:else if message.status === 'streaming'}
      <div class="stream-state">
        <span class="stream-caret"></span>
        <span>正在生成</span>
        <button class="button quiet stop-button" type="button" disabled={busy}
          onclick={() => action(() => workspace.abort(message.id))}><Square size={11} /> 停止生成</button>
      </div>
    {:else if message.status === 'aborted'}
      <div class="message-status">
        <span>生成已停止{message.error_message ? ` · ${message.error_message}` : ''}</span>
        {#if isBotMsg && !author.disabled}
          <button class="button quiet" type="button" disabled={busy} onclick={() => action(() => workspace.regenerate(message.id))}>
            <RotateCcw size={12} /> 重新生成
          </button>
        {/if}
      </div>
    {:else if message.status === 'error'}
      <div class="message-status danger" role="status">
        <span>生成失败{message.error_message ? ` · ${message.error_message}` : ''}</span>
        {#if isBotMsg && !author.disabled}
          <button class="button quiet" type="button" disabled={busy} onclick={() => action(() => workspace.regenerate(message.id))}>
            <RotateCcw size={12} /> 重试
          </button>
        {/if}
      </div>
    {/if}

    {#if message.reactions.length}
      <div class="reaction-row">
        {#each message.reactions as item (item.emoji)}
          {@const mine = Boolean(workspace.user && item.user_ids.includes(workspace.user.id))}
          <button type="button" class="reaction-pill" class:mine onclick={() => void react(item.emoji)}
            title={item.user_ids.map(id => workspace.directory[id]?.display_name ?? id).join('、')}>
            <span>{item.emoji}</span>
            <small>{item.count}</small>
          </button>
        {/each}
        <button type="button" class="reaction-pill add-react" aria-label="添加表情回应" onclick={() => { emojiOpen = !emojiOpen }}>
          <SmilePlus size={13} />
        </button>
      </div>
    {/if}

    {#if emojiOpen}
      <div class="emoji-popover" role="menu">
        {#each QUICK_EMOJIS as emoji}
          <button type="button" onclick={() => void react(emoji)}>{emoji}</button>
        {/each}
      </div>
    {/if}

    {#if error}<p class="form-error" role="alert">{error}</p>{/if}

    {#if !threadRoot && message.reply_count}
      <button class="reply-link" type="button" onclick={() => workspace.openThread(message.id)}>
        <MessageSquare size={13} /> {message.reply_count} 条回复 <span aria-hidden="true">→</span>
      </button>
    {/if}
  </div>

  {#if !editing}
    <div class="message-actions">
      <button class="icon-button quick-emoji" type="button" title="👍" onclick={() => void react('👍')}>👍</button>
      <button class="icon-button" type="button" title="添加回应" aria-label="添加回应" onclick={() => { emojiOpen = !emojiOpen }}>
        <SmilePlus size={14} />
      </button>
      <button class="icon-button" type="button" title="引用回复" aria-label="引用回复"
        onclick={() => workspace.setReply(message.channel_id, message.thread_root_id, message)}>
        <Quote size={14} />
      </button>
      {#if !message.thread_root_id && !threadRoot}
        <button class="icon-button" type="button" title="回复进 Thread" aria-label="回复进 Thread" onclick={() => workspace.openThread(message.id)}>
          <CornerUpLeft size={14} />
        </button>
      {/if}
      <button class="icon-button" class:bookmarked type="button" title={bookmarked ? '取消收藏' : '收藏消息'} aria-label={bookmarked ? '取消收藏' : '收藏消息'}
        onclick={() => action(() => workspace.toggleBookmark(message))}>
        <Bookmark size={14} />
      </button>
      {#if isBotMsg && message.status !== 'streaming' && !author.disabled}
        <button class="icon-button" type="button" title="重新生成" aria-label="重新生成"
          onclick={() => action(() => workspace.regenerate(message.id))}>
          <RotateCcw size={14} />
        </button>
      {/if}
      {#if canEdit && message.status !== 'streaming'}
        <button class="icon-button" type="button" title="编辑消息" aria-label="编辑消息" onclick={beginEdit}>
          <Pencil size={14} />
        </button>
      {/if}
      {#if canPin}
        <button class="icon-button" type="button" title={pinned ? '取消置顶' : '置顶消息'} aria-label={pinned ? '取消置顶' : '置顶消息'} onclick={togglePin}>
          {#if pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
        </button>
      {/if}
      {#if canEdit}
        <button class="icon-button danger-on-hover" type="button" title="删除消息" aria-label="删除消息" onclick={() => void deleteMessage()}>
          <Trash2 size={14} />
        </button>
      {/if}
    </div>
  {/if}
</article>
