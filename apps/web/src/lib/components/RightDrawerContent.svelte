<script lang="ts">
  import { ArrowUpRight, BookmarkX, Download, FileText, PinOff } from 'lucide-svelte'
  import type { Attachment, Channel } from '@chiorim/shared'
  import { formatSize, formatStamp, imageMime } from '$lib/format'
  import { markdownSummary } from '$lib/markdown'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import Avatar from './Avatar.svelte'

  let { workspace, channel, canManage, preview }: {
    workspace: Workspace
    channel: Channel
    canManage: boolean
    preview: (file: Attachment) => void
  } = $props()

  let fileFilter = $state<'all' | 'image' | 'file'>('all')
  const filteredFiles = $derived(workspace.files.filter(item => {
    if (fileFilter === 'image') return imageMime(item.attachment.mime)
    if (fileFilter === 'file') return !imageMime(item.attachment.mime)
    return true
  }))
</script>

<div class="drawer-scroll">
  {#if workspace.rightMode === 'pins'}
    {#if workspace.pinsLoading}
      <div class="feed-status"><span class="spinner"></span> 正在加载置顶…</div>
    {:else if !workspace.pins.length}
      <div class="feed-status">当前频道暂无置顶消息</div>
    {:else}
      {#each workspace.pins as item (item.id)}
        <article class="drawer-card">
          <div class="drawer-card-head">
            <Avatar user={item.author} size={22} />
            <strong>{item.webhook_name ?? item.author.display_name}</strong>
            <small>{formatStamp(item.created_at)}</small>
          </div>
          <p>{markdownSummary(item.content) || '[附件消息]'}</p>
          <div class="drawer-card-actions">
            <button type="button" class="button quiet compact" onclick={() => void workspace.jumpToMessage(item.channel_id, item.id, item.thread_root_id)}>
              <ArrowUpRight size={13} /> 跳转
            </button>
            {#if canManage}
              <button type="button" class="button quiet compact danger-on-hover"
                onclick={() => void workspace.unpinMessage(channel.id, item.id).catch(e => workspace.report(e))}>
                <PinOff size={13} /> 取消置顶
              </button>
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  {:else if workspace.rightMode === 'files'}
    <div class="drawer-tabs">
      <button type="button" class:active={fileFilter === 'all'} onclick={() => { fileFilter = 'all' }}>全部</button>
      <button type="button" class:active={fileFilter === 'image'} onclick={() => { fileFilter = 'image' }}>图片</button>
      <button type="button" class:active={fileFilter === 'file'} onclick={() => { fileFilter = 'file' }}>文件</button>
    </div>
    {#if workspace.filesLoading}
      <div class="feed-status"><span class="spinner"></span> 正在加载文件…</div>
    {:else if !filteredFiles.length}
      <div class="feed-status">暂无分享文件</div>
    {:else}
      <div class="gallery-list">
        {#each filteredFiles as item (item.message_id + item.attachment.url)}
          {#if imageMime(item.attachment.mime)}
            <button type="button" class="gallery-img" onclick={() => preview(item.attachment)}>
              <img src={item.attachment.url} alt={item.attachment.name} loading="lazy" />
              <span>{item.attachment.name}</span>
            </button>
          {:else}
            <a class="gallery-file" href={item.attachment.url} download={item.attachment.name}>
              <FileText size={16} />
              <span><strong>{item.attachment.name}</strong><small>{item.author.display_name} · {formatSize(item.attachment.size)}</small></span>
              <Download size={14} />
            </a>
          {/if}
        {/each}
      </div>
    {/if}
  {:else if workspace.rightMode === 'bookmarks'}
    {#if workspace.bookmarksLoading}
      <div class="feed-status"><span class="spinner"></span> 正在加载收藏…</div>
    {:else if !workspace.bookmarks.length}
      <div class="feed-status">还没有收藏消息，悬停任意消息点书签即可收藏</div>
    {:else}
      {#each workspace.bookmarks as item (item.message.id)}
        <article class="drawer-card">
          <div class="drawer-card-head">
            <Avatar user={item.message.author} size={22} />
            <strong>{item.message.webhook_name ?? item.message.author.display_name}</strong>
            <small>{formatStamp(item.message.created_at)}</small>
          </div>
          <p>{markdownSummary(item.message.content) || '[附件消息]'}</p>
          <div class="drawer-card-actions">
            <button type="button" class="button quiet compact"
              onclick={() => void workspace.jumpToMessage(item.message.channel_id, item.message.id, item.message.thread_root_id)}>
              <ArrowUpRight size={13} /> 定位原消息
            </button>
            <button type="button" class="button quiet compact danger-on-hover"
              onclick={() => void workspace.toggleBookmark(item.message).catch(e => workspace.report(e))}>
              <BookmarkX size={13} /> 移除
            </button>
          </div>
        </article>
      {/each}
    {/if}
  {/if}
</div>
