<script lang="ts">
  import { tick } from 'svelte'
  import { ArrowUp, AtSign, Paperclip, Quote, Terminal, X } from 'lucide-svelte'
  import { sendMessageSchema } from '@chiorim/shared'
  import type { Attachment as FileAttachment, Member } from '@chiorim/shared'
  import { upload, errorText } from '$lib/api'
  import { formatSize, imageMime } from '$lib/format'
  import { SLASH_COMMANDS } from '$lib/presets'
  import type { SlashCommandItem } from '$lib/presets'
  import { scopeKey } from '$lib/stores/workspace.svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'
  import Avatar from './Avatar.svelte'

  let { workspace, channel, thread = null, placeholder, preview }: {
    workspace: Workspace; channel: string; thread?: string | null; placeholder: string; preview: (file: FileAttachment) => void
  } = $props()

  const key = $derived(scopeKey(channel, thread))
  const empty = { text: '', attachments: [] as FileAttachment[] }
  const draft = $derived(workspace.drafts.get(key) ?? empty)
  const reply = $derived(workspace.replyingTo[key] ?? null)
  const typers = $derived((workspace.typing[key] ?? []).map(id => workspace.directory[id]?.display_name).filter(Boolean))

  let input: HTMLTextAreaElement
  let picker: HTMLInputElement
  let caret = $state(0)
  let highlighted = $state(0)
  let focused = $state(false)
  let composing = $state(false)
  let dismissed = $state('')
  let error = $state('')
  let uploading = $state(0)
  let drag = $state(false)

  const slashMatch = $derived(!draft.attachments.length && focused && !composing && dismissed !== draft.text
    ? /^\/([a-z]*)$/i.exec(draft.text.slice(0, caret))
    : null)
  const slashItems = $derived(slashMatch
    ? SLASH_COMMANDS.filter(item => item.name.slice(1).startsWith(slashMatch[1].toLowerCase()))
    : [])

  const mention = $derived(!slashItems.length ? /(?:^|\s)@([a-z0-9_-]*)$/i.exec(draft.text.slice(0, caret)) : null)
  const matches = $derived(!focused || !mention || dismissed === draft.text || composing ? [] :
    workspace.roomMembers.filter(member => {
      const query = mention?.[1].toLowerCase() ?? ''
      return member.username.includes(query) || member.display_name.toLowerCase().includes(query)
    }).slice(0, 8))

  const menuCount = $derived(slashItems.length || matches.length)
  const selected = $derived(Math.min(highlighted, Math.max(0, menuCount - 1)))

  function fit(node: HTMLTextAreaElement, _value: string) {
    if (CSS.supports('field-sizing', 'content')) return
    const resize = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight}px`
    }
    resize()
    return { update: resize }
  }

  function updateText(text: string, position: number) {
    workspace.drafts.set(key, { ...draft, text })
    caret = position
    highlighted = 0
    dismissed = ''
    if (text.trim() && !text.trim().startsWith('/')) workspace.announceTyping(channel, thread)
  }

  async function chooseMention(member: Member) {
    if (!mention) return
    const start = caret - mention[1].length - 1
    const end = caret + (draft.text.slice(caret).match(/^[a-z0-9_-]*/i)?.[0].length ?? 0)
    const inserted = '@' + member.username + ' '
    updateText(draft.text.slice(0, start) + inserted + draft.text.slice(end), start + inserted.length)
    await tick()
    input.focus()
    input.setSelectionRange(caret, caret)
  }

  async function chooseSlash(item: SlashCommandItem) {
    updateText(item.insert, item.insert.length)
    await tick()
    input.focus()
    input.setSelectionRange(caret, caret)
  }

  async function attach(list: File[]) {
    if (!list.length) return
    const origin = key
    const userId = workspace.user?.id
    const remaining = Math.max(0, 20 - draft.attachments.length - uploading)
    if (!remaining) { error = '每条消息最多附加 20 个文件。'; return }
    error = list.length > remaining ? '每条消息最多附加 20 个文件。' : ''
    const accepted = list.slice(0, remaining)
    uploading += accepted.length
    await Promise.all(accepted.map(async file => {
      try {
        const attachment = await upload(file)
        if (workspace.user?.id !== userId) return
        const current = workspace.drafts.get(origin) ?? empty
        workspace.drafts.set(origin, { ...current, attachments: [...current.attachments, attachment] })
      } catch (failure) {
        error = errorText(failure)
      } finally { uploading-- }
    }))
  }

  async function send() {
    if (uploading || (!draft.text.trim() && !draft.attachments.length)) return
    error = ''
    const parsed = sendMessageSchema.safeParse({
      content: draft.text,
      thread_root_id: thread,
      reply_to_id: reply?.id ?? null,
      attachments: draft.attachments,
    })
    if (!parsed.success) { error = parsed.error.issues[0]?.message ?? '消息格式有误。'; return }
    try {
      const textBackup = draft.text
      const pending = workspace.submit(channel, parsed.data)
      workspace.drafts.delete(key)
      workspace.setReply(channel, thread, null)
      caret = 0
      await pending
      if (textBackup.trim().startsWith('/')) input?.focus()
    } catch (failure) { error = errorText(failure) }
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || composing || event.keyCode === 229) return
    if (menuCount > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        highlighted = (selected + (event.key === 'ArrowDown' ? 1 : -1) + menuCount) % menuCount
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        if (slashItems.length) void chooseSlash(slashItems[selected])
        else if (matches.length) void chooseMention(matches[selected])
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); dismissed = draft.text; return }
    }
    if (event.key === 'Escape' && reply) {
      event.preventDefault()
      workspace.setReply(channel, thread, null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
  }

  async function insertPrefix(symbol: '@' | '/') {
    const position = input.selectionStart
    const before = draft.text.slice(0, position)
    const insert = symbol === '/' ? (before ? before : '/') : (before && !/\s$/.test(before) ? ' @' : '@')
    if (symbol === '/') {
      updateText('/', 1)
    } else {
      updateText(before + insert + draft.text.slice(input.selectionEnd), position + insert.length)
    }
    await tick()
    input.focus()
    input.setSelectionRange(caret, caret)
  }
</script>

<div class="composer-wrap">
  {#if typers.length}
    <div class="typing-indicator" role="status">
      <span></span><span></span><span></span>
      {typers.slice(0, 3).join('、')}{typers.length > 3 ? ' 等' : ''}正在输入
    </div>
  {/if}
  {#if error}
    <div class="form-error composer-error" role="alert">
      <span>{error}</span>
      <button class="icon-button" aria-label="关闭提示" onclick={() => { error = '' }}><X size={14} /></button>
    </div>
  {/if}

  {#if slashItems.length}
    <div class="mention-menu" role="listbox" aria-label="斜杠命令">
      <div class="mention-menu-title">快捷命令</div>
      {#each slashItems as item, position (item.name)}
        <button type="button" role="option" aria-selected={selected === position} class:selected={selected === position}
          onpointerdown={(event) => event.preventDefault()} onclick={() => chooseSlash(item)}>
          <Terminal size={15} class="muted" />
          <span><strong>{item.usage}</strong><small>{item.description}</small></span>
        </button>
      {/each}
    </div>
  {:else if matches.length}
    <div class="mention-menu" role="listbox" aria-label="提及成员">
      <div class="mention-menu-title">提及频道成员 / Agent</div>
      {#each matches as member, position (member.id)}
        <button type="button" role="option" aria-selected={selected === position} class:selected={selected === position}
          onpointerdown={(event) => event.preventDefault()} onclick={() => chooseMention(member)}>
          <Avatar user={member} size={26} online={member.online} status={member.presence_status} />
          <span><strong>{member.display_name}</strong><small>@{member.username}</small></span>
          {#if member.kind === 'bot'}<span class="bot-tag">{member.bot?.mode === 'provider' ? 'BOT' : 'AGENT'}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <form class="composer" class:drag onsubmit={(event) => { event.preventDefault(); void send() }}
    ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); drag = true } }}
    ondragleave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) drag = false }}
    ondrop={(event) => { event.preventDefault(); drag = false; void attach(Array.from(event.dataTransfer?.files ?? [])) }}>
    {#if reply}
      <div class="composer-reply">
        <Quote size={13} />
        <span>回复 <strong>{reply.webhook_name ?? reply.author.display_name}</strong>：{reply.content.slice(0, 80) || '[附件]'}</span>
        <button type="button" class="icon-button" aria-label="取消引用" onclick={() => workspace.setReply(channel, thread, null)}>
          <X size={14} />
        </button>
      </div>
    {/if}
    {#if draft.attachments.length || uploading}
      <div class="draft-attachments">
        {#each draft.attachments as file, index (file.url)}
          <span class="draft-file">
            {#if imageMime(file.mime)}
              <button type="button" title={file.name} onclick={() => preview(file)}><img src={file.url} alt={file.name} /></button>
            {/if}
            <span><strong title={file.name}>{file.name}</strong><small>{formatSize(file.size)}</small></span>
            <button class="icon-button" type="button" aria-label={'移除 ' + file.name} onclick={() => {
              workspace.drafts.set(key, { ...draft, attachments: draft.attachments.filter((_, position) => position !== index) })
            }}><X size={14} /></button>
          </span>
        {/each}
        {#if uploading}<span class="uploading"><span class="spinner"></span> 正在上传 {uploading} 个文件</span>{/if}
      </div>
    {/if}
    <div class="composer-main">
      <textarea bind:this={input} use:fit={draft.text} value={draft.text} {placeholder} aria-label={placeholder} maxlength={60000}
        rows="1"
        oninput={(event) => updateText(event.currentTarget.value, event.currentTarget.selectionStart)}
        onfocus={() => { focused = true; caret = input.selectionStart }}
        onblur={() => { focused = false }}
        onclick={() => { caret = input.selectionStart }}
        onselect={() => { caret = input.selectionStart }}
        onkeyup={() => { caret = input.selectionStart }}
        oncompositionstart={() => { composing = true }}
        oncompositionend={() => { composing = false }}
        onkeydown={keydown}
        onpaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter(file => imageMime(file.type))
          if (files.length) { event.preventDefault(); void attach(files) }
        }}></textarea>
    </div>
    <div class="composer-controls">
      <button type="button" class="icon-button" title="附件" aria-label="添加附件" onclick={() => picker.click()}><Paperclip size={16} /></button>
      <button type="button" class="icon-button" title="@提及" aria-label="提及成员" onclick={() => void insertPrefix('@')}><AtSign size={16} /></button>
      <button type="button" class="icon-button" title="斜杠命令" aria-label="斜杠命令" onclick={() => void insertPrefix('/')}><Terminal size={15} /></button>
      <button type="submit" class="send-button" title="发送" aria-label="发送消息"
        disabled={uploading > 0 || (!draft.text.trim() && !draft.attachments.length)}><ArrowUp size={16} strokeWidth={2.4} /></button>
    </div>
    <input bind:this={picker} type="file" multiple hidden onchange={(event) => {
      void attach(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''
    }} />
  </form>
</div>
