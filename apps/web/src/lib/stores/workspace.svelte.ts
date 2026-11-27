import { SvelteMap } from 'svelte/reactivity'
import {
  authResponseSchema, channelListSchema, channelPreferenceSchema, channelSchema, clientDownSchema,
  clientUpSchema, dmCreateSchema, memberListSchema, messagePatchSchema, messageSchema,
  okResponseSchema, sendMessageSchema, userSchema, workspaceListSchema,
} from '@chiorim/shared'
import type {
  Attachment, BoardStatus, Bookmark, BridgeRuntime, Channel, ChannelFile, ClientDown, ClientUp,
  Member, Message, RegisterRequest, SendMessageRequest, User, Workspace as FolderWorkspace,
} from '@chiorim/shared'
import {
  addPin, api, ApiFailure, errorText, getSession, listBookmarks, listChannelFiles, listPins,
  messages, regenerateMessage, removeBookmark, removePin, runSlashCommand, saveBookmark,
  sendMessage, toggleReaction,
} from '$lib/api'

export const scopeKey = (channel: string, thread?: string | null) => thread ? `${channel}/${thread}` : channel

export type RightPanelMode = 'members' | 'thread' | 'pins' | 'files' | 'bookmarks'
export type SettingsTab = 'profile' | 'security' | 'appearance' | 'bots' | 'providers' | 'members' | 'bridge'

type Feed = {
  rows: Message[]
  before: string | null
  loading: boolean
  loaded: boolean
  error: string
}

export type PendingMessage = {
  nonce: string
  channel: string
  payload: SendMessageRequest
  createdAt: number
  state: 'sending' | 'failed' | 'unconfirmed'
  error?: string
}

export type Toast = { id: number; kind: 'info' | 'success' | 'error'; text: string }

export type ConfirmRequest = {
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

type Presence = { online: boolean; runtime?: BridgeRuntime }
const compareIds = (a: Message, b: Message) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const sorted = (rows: Iterable<Message>) => Array.from(rows).sort(compareIds)
const newFeed = (): Feed => ({ rows: [], before: null, loading: false, loaded: false, error: '' })
const errorOf = (event: Extract<ClientDown, { type: 'error' }>) => event.error.message

export class Workspace {
  phase = $state<'loading' | 'auth' | 'workspace' | 'error'>('loading')
  failure = $state('')
  initialized = $state(false)
  user = $state<User | null>(null)
  workspaces = $state<FolderWorkspace[]>([])
  channels = $state<Channel[]>([])
  directory = $state<Record<string, Member>>({})
  presence = $state<Record<string, Presence>>({})
  memberIds = $state<Record<string, string[]>>({})
  activeId = $state('')
  threadId = $state<string | null>(null)
  rightMode = $state<RightPanelMode>('members')
  connection = $state<'connecting' | 'connected' | 'reconnecting'>('connecting')
  theme = $state<'dark' | 'light'>('dark')
  desktopNotify = $state(false)
  soundNotify = $state(false)
  feeds = $state<Record<string, Feed>>({})
  details = $state<Record<string, Message | null>>({})
  pending = $state<PendingMessage[]>([])
  typing = $state<Record<string, string[]>>({})
  drafts = new SvelteMap<string, { text: string; attachments: Attachment[] }>()
  replyingTo = $state<Record<string, Message | null>>({})
  highlightedId = $state<string | null>(null)
  unreadStartId = $state<Record<string, string | null>>({})

  // Side drawer caches
  pins = $state<Message[]>([])
  pinsLoading = $state(false)
  files = $state<ChannelFile[]>([])
  filesLoading = $state(false)
  bookmarks = $state<Bookmark[]>([])
  bookmarksLoading = $state(false)
  bookmarkIds = $derived(new Set(this.bookmarks.map(item => item.message.id)))

  // Global overlays
  settingsTab = $state<SettingsTab | null>(null)
  searchOpen = $state(false)
  searchChannelFilter = $state('')
  confirmState = $state<ConfirmRequest | null>(null)
  toasts = $state<Toast[]>([])

  // Derived selectors
  active = $derived(this.channels.find(channel => channel.id === this.activeId))
  totalUnread = $derived(this.channels.reduce((sum, channel) => sum + (channel.muted ? 0 : channel.unread_count), 0))
  members = $derived(
    Object.values(this.directory)
      .filter(member => !member.disabled)
      .map(member => this.withPresence(member))
      .sort((a, b) => a.username.localeCompare(b.username)),
  )
  allMembers = $derived(
    Object.values(this.directory)
      .map(member => this.withPresence(member))
      .sort((a, b) => a.username.localeCompare(b.username)),
  )
  roomMembers = $derived((this.memberIds[this.activeId] ?? []).flatMap(id => {
    const member = this.directory[id]
    return member && !member.disabled ? [this.withPresence(member)] : []
  }))

  private lifetime = new AbortController()
  private socket?: WebSocket
  private heartbeat?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private readyTimer?: ReturnType<typeof setTimeout>
  private highlightTimer?: ReturnType<typeof setTimeout>
  private attempts = 0
  private pongAt = 0
  private sessionConfirmed = false
  private readTimer?: ReturnType<typeof setTimeout>
  private readQueue = new Map<string, string>()
  private readSent = new Map<string, string>()
  private typingAt = new Map<string, number>()
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private syncMarks = new Map<string, Map<string, Message | null>>()
  private syncAgain = new Set<string>()
  private detailLoading = new Set<string>()
  private channelEdits = new Map<string, Channel | null>()
  private directoryEdits = new Map<string, Member | null>()
  private syncingLists?: Promise<void>
  private listsGeneration?: AbortSignal
  private memberLoads = new Map<string, { again: boolean }>()
  private detailsChanged = new Map<string, number>()
  private feedOrder: string[] = []
  private toastSeq = 0

  setTheme(theme: 'dark' | 'light') {
    this.theme = theme
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (meta) meta.content = theme === 'dark' ? '#0b1110' : '#e4ece9'
    try { localStorage.setItem('chior-theme', theme) } catch { /* Optional */ }
  }

  setNotifyPrefs(desktop: boolean, sound: boolean) {
    this.desktopNotify = desktop
    this.soundNotify = sound
    try {
      localStorage.setItem('chior-notify-desktop', desktop ? '1' : '0')
      localStorage.setItem('chior-notify-sound', sound ? '1' : '0')
    } catch { /* Optional */ }
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++this.toastSeq
    this.toasts = [...this.toasts.slice(-3), { id, kind, text }]
    setTimeout(() => { this.toasts = this.toasts.filter(item => item.id !== id) }, 4200)
  }

  dismissToast(id: number) {
    this.toasts = this.toasts.filter(item => item.id !== id)
  }

  confirm(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
    if (this.confirmState) this.confirmState.resolve(false)
    return new Promise<boolean>(resolve => {
      this.confirmState = { ...options, resolve }
    })
  }

  answerConfirm(ok: boolean) {
    const current = this.confirmState
    this.confirmState = null
    current?.resolve(ok)
  }

  openSettings(tab: SettingsTab = 'profile') {
    this.settingsTab = tab
  }

  openSearch(channelId = '') {
    this.searchChannelFilter = channelId
    this.searchOpen = true
  }

  async start() {
    try {
      this.setTheme(localStorage.getItem('chior-theme') === 'light' ? 'light' : 'dark')
      this.desktopNotify = localStorage.getItem('chior-notify-desktop') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'
      this.soundNotify = localStorage.getItem('chior-notify-sound') === '1'
    } catch { this.setTheme('dark') }
    await this.bootstrap()
  }

  async bootstrap() {
    const signal = this.lifetime.signal
    this.phase = 'loading'
    try {
      const session = await getSession(signal)
      if (signal.aborted) return
      this.initialized = session.initialized
      if (session.user) {
        this.enter(session.user)
      } else {
        this.phase = 'auth'
      }
    } catch (error) {
      if (signal.aborted) return
      this.failure = errorText(error)
      this.phase = 'error'
    }
  }

  async authenticate(mode: 'login' | 'register', input: RegisterRequest) {
    const { user } = await api('/auth/' + mode, authResponseSchema, 'POST', input, this.lifetime.signal)
    this.enter(user)
  }

  private enter(user: User) {
    this.user = user
    this.phase = 'workspace'
    this.initialized = true
    this.connect()
    void this.syncLists().catch(error => this.report(error))
    void this.refreshBookmarks()
  }

  async logout() {
    await api('/auth/logout', okResponseSchema, 'POST', undefined, this.lifetime.signal)
    this.reset()
    this.phase = 'auth'
  }

  private reset() {
    this.dispose()
    this.lifetime = new AbortController()
    this.workspaces = []
    this.channels = []
    this.directory = {}
    this.presence = {}
    this.memberIds = {}
    this.feeds = {}
    this.details = {}
    this.pending = []
    this.typing = {}
    this.replyingTo = {}
    this.unreadStartId = {}
    this.pins = []
    this.files = []
    this.bookmarks = []
    this.drafts.clear()
    this.readSent.clear()
    this.typingAt.clear()
    this.syncMarks.clear()
    this.syncAgain.clear()
    this.detailLoading.clear()
    this.detailsChanged.clear()
    this.channelEdits.clear()
    this.directoryEdits.clear()
    this.memberLoads.clear()
    this.feedOrder = []
    this.activeId = ''
    this.threadId = null
    this.rightMode = 'members'
    this.settingsTab = null
    this.searchOpen = false
    this.user = null
    this.attempts = 0
    this.sessionConfirmed = false
    this.connection = 'connecting'
  }

  dispose() {
    this.lifetime.abort()
    const ws = this.socket
    this.socket = undefined
    ws?.close()
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.readyTimer)
    clearTimeout(this.highlightTimer)
    clearInterval(this.heartbeat)
    clearTimeout(this.readTimer)
    this.readTimer = undefined
    this.readQueue.clear()
    for (const timer of this.typingTimers.values()) clearTimeout(timer)
    for (const timer of this.pendingTimers.values()) clearTimeout(timer)
    this.typingTimers.clear()
    this.pendingTimers.clear()
    if (this.confirmState) { this.confirmState.resolve(false); this.confirmState = null }
  }

  report(error: unknown) {
    if (this.lifetime.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
    if (error instanceof ApiFailure && (error.status === 401 || error.code === 'ACCOUNT_DISABLED')) {
      this.reset()
      this.phase = 'auth'
      if (error.code === 'ACCOUNT_DISABLED') this.toast('账号已被停用。', 'error')
      return
    }
    this.toast(errorText(error), 'error')
  }

  private withPresence(member: Member): Member {
    const live = this.presence[member.id]
    if (!live) return member
    return {
      ...member,
      online: member.disabled ? false : live.online,
      bot: member.bot ? { ...member.bot, runtime_meta: live.runtime ?? null } : null,
    }
  }

  private connect() {
    const signal = this.lifetime.signal
    if (signal.aborted) return
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/client`)
    this.socket = ws
    this.readyTimer = setTimeout(() => ws.close(), 12_000)
    ws.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== ws) return
      try {
        const parsed = clientDownSchema.safeParse(JSON.parse(event.data))
        if (parsed.success) this.receive(parsed.data)
      } catch (error) { this.report(error) }
    }
    ws.onclose = () => {
      if (this.socket !== ws || signal.aborted) return
      this.socket = undefined
      clearTimeout(this.readyTimer)
      clearInterval(this.heartbeat)
      this.readSent.clear()
      this.connection = 'reconnecting'
      for (const item of this.pending) {
        if (item.state === 'sending' && this.pendingTimers.has(item.nonce)) {
          this.failPending(item.nonce, '连接中断，发送结果尚未确认。', 'unconfirmed')
        }
      }
      const timeout = Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6))
      this.reconnectTimer = setTimeout(() => {
        if (signal.aborted) return
        void this.reconnect(signal)
      }, Math.round(timeout * (0.8 + Math.random() * 0.2)))
    }
  }

  private async reconnect(signal: AbortSignal) {
    try {
      if (this.attempts >= 2 || this.sessionConfirmed) {
        const session = await getSession(signal)
        if (!session.user) {
          this.reset()
          this.phase = 'auth'
          return
        }
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiFailure && error.status === 401) { this.report(error); return }
    }
    if (!signal.aborted) this.connect()
  }

  private transmit(event: ClientUp) {
    if (this.connection !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(event))
    return true
  }

  private maybeNotify(message: Message) {
    if (message.author_id === this.user?.id) return
    const room = this.channels.find(item => item.id === message.channel_id)
    if (!room || room.muted) return
    const hidden = document.visibilityState !== 'visible'
    if (!hidden && message.channel_id === this.activeId) return
    if (this.soundNotify) this.playChime()
    if (this.desktopNotify && hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const folder = room.workspace_id ? this.workspaces.find(ws => ws.id === room.workspace_id)?.name : ''
      const title = room.type === 'dm' ? message.author.display_name : `${message.author.display_name} · ${folder ? `${folder}/` : ''}#${room.name}`
      const body = message.content.trim().slice(0, 140) || '发来一条附件消息'
      const note = new Notification(title, { body, icon: '/icon.svg', tag: room.id })
      note.onclick = () => {
        window.focus()
        this.select(room.id)
        note.close()
      }
    }
  }

  private playChime() {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(740, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(980, ctx.currentTime + 0.09)
      gain.gain.setValueAtTime(0.06, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16)
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.17)
      osc.onended = () => { void ctx.close() }
    } catch { /* Audio blocked */ }
  }

  private receive(event: ClientDown) {
    switch (event.type) {
      case 'ready': {
        this.user = event.user
        this.attempts = 0
        this.sessionConfirmed = true
        this.connection = 'connected'
        this.pongAt = Date.now()
        clearTimeout(this.readyTimer)
        clearInterval(this.heartbeat)
        const ids = new Set(event.online_user_ids)
        this.presence = Object.fromEntries([...ids, ...Object.keys(this.directory)].map(id => [
          id, { online: ids.has(id), runtime: event.bridge_runtimes[id] },
        ]))
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.pongAt > 55_000) this.socket?.close()
          else this.transmit({ type: 'ping' })
        }, 25_000)
        const signal = this.lifetime.signal
        void this.syncLists().then(() => {
          if (signal.aborted || !this.activeId) return
          void this.loadMembers(this.activeId, true)
          void this.loadFeed(this.activeId, null, 'sync')
          if (this.threadId) {
            void this.loadDetail(this.threadId, true)
            void this.loadFeed(this.activeId, this.threadId, 'sync')
          }
        }).catch(error => { if (!signal.aborted) this.report(error) })
        return
      }
      case 'pong': this.pongAt = Date.now(); return
      case 'presence.update':
        this.presence[event.user_id] = { online: event.online, runtime: event.runtime_meta }
        return
      case 'member.updated':
        this.directory[event.member.id] = event.member
        this.presence[event.member.id] = { online: event.member.online, runtime: event.member.bot?.runtime_meta ?? undefined }
        if (this.syncingLists) this.directoryEdits.set(event.member.id, event.member)
        if (event.member.id === this.user?.id) this.user = userSchema.parse(event.member)
        return
      case 'member.removed':
        delete this.directory[event.user_id]
        delete this.presence[event.user_id]
        if (this.syncingLists) this.directoryEdits.set(event.user_id, null)
        return
      case 'channel.updated': this.applyChannel(event.channel); return
      case 'workspace.updated': {
        const exists = this.workspaces.some(ws => ws.id === event.workspace.id)
        this.workspaces = exists
          ? this.workspaces.map(ws => ws.id === event.workspace.id ? event.workspace : ws)
          : [...this.workspaces, event.workspace]
        return
      }
      case 'workspace.removed': {
        this.workspaces = this.workspaces.filter(ws => ws.id !== event.workspace_id)
        return
      }
      case 'channel.removed':
        if (this.syncingLists) this.channelEdits.set(event.channel_id, null)
        this.channels = this.channels.filter(channel => channel.id !== event.channel_id)
        delete this.memberIds[event.channel_id]
        for (const key of Object.keys(this.feeds)) if (key.split('/')[0] === event.channel_id) delete this.feeds[key]
        for (const [id, message] of Object.entries(this.details)) if (message?.channel_id === event.channel_id) delete this.details[id]
        if (event.channel_id === this.activeId) this.select(this.channels[0]?.id ?? '')
        return
      case 'message.created':
        if (event.client_nonce) this.dismissPending(event.client_nonce)
        this.applyMessage(event.message, true)
        this.maybeNotify(event.message)
        return
      case 'message.updated': this.applyMessage(event.message); return
      case 'message.reactions': {
        for (const [key, feed] of Object.entries(this.feeds)) {
          if (key.split('/')[0] !== event.channel_id) continue
          const target = feed.rows.find(row => row.id === event.message_id)
          if (target) target.reactions = event.reactions
        }
        const detail = this.details[event.message_id]
        if (detail) detail.reactions = event.reactions
        return
      }
      case 'message.deleted': {
        for (const [key, feed] of Object.entries(this.feeds)) {
          if (key.split('/')[0] !== event.channel_id) continue
          this.syncMarks.get(key)?.set(event.message_id, null)
          feed.rows = feed.rows.filter(row => row.id !== event.message_id)
        }
        this.detailsChanged.set(event.message_id, (this.detailsChanged.get(event.message_id) ?? 0) + 1)
        this.details[event.message_id] = null
        this.pins = this.pins.filter(item => item.id !== event.message_id)
        this.bookmarks = this.bookmarks.filter(item => item.message.id !== event.message_id)
        if (this.threadId === event.message_id) this.closeThread()
        return
      }
      case 'message.delta': {
        const key = scopeKey(event.channel_id, event.thread_root_id)
        const marks = this.syncMarks.get(key)
        const row = this.feeds[key]?.rows.find(item => item.id === event.message_id) ?? this.details[event.message_id] ?? marks?.get(event.message_id)
        if (!row || row.status !== 'streaming') return
        marks?.set(row.id, row)
        this.detailsChanged.set(row.id, (this.detailsChanged.get(row.id) ?? 0) + 1)
        if (event.part === 'text') row.content += event.delta ?? ''
        if (event.part === 'thinking') {
          const last = row.blocks.at(-1)
          if (last?.type === 'thinking') last.text += event.delta ?? ''
          else row.blocks.push({ type: 'thinking', text: event.delta ?? '' })
        }
        if (event.tool) {
          const index = row.blocks.findIndex(block => block.type === 'tool_call' && block.id === event.tool?.id)
          if (index === -1) row.blocks.push({ ...event.tool, type: 'tool_call' })
          else row.blocks[index] = { ...row.blocks[index], ...event.tool, type: 'tool_call' }
        }
        if (event.prompt) {
          const index = row.blocks.findIndex(block => block.type === 'prompt' && block.id === event.prompt?.id)
          if (index === -1) row.blocks.push({ ...event.prompt, type: 'prompt' })
          else row.blocks[index] = { ...row.blocks[index], ...event.prompt, type: 'prompt' }
        }
        if (Object.hasOwn(this.details, row.id)) this.details[row.id] = row
        return
      }
      case 'typing': this.receiveTyping(event); return
      case 'error':
        if (event.client_nonce) this.failPending(event.client_nonce, errorOf(event))
        else this.toast(errorOf(event), 'error')
    }
  }

  private applyChannel(channel: Channel) {
    if (this.syncingLists) this.channelEdits.set(channel.id, channel)
    const previous = this.channels.find(item => item.id === channel.id)
    this.channels = previous ? this.channels.map(item => item.id === channel.id ? channel : item) : [...this.channels, channel]
    if (channel.id !== this.activeId) return
    if (previous?.member_count !== channel.member_count) void this.loadMembers(channel.id, true)
    if (this.rightMode === 'pins' && previous?.pinned_count !== channel.pinned_count) void this.refreshPins(channel.id)
  }

  async syncLists() {
    const signal = this.lifetime.signal
    if (this.syncingLists && this.listsGeneration === signal) return this.syncingLists
    this.listsGeneration = signal
    const promise = Promise.all([
      api('/workspaces', workspaceListSchema, 'GET', undefined, signal),
      api('/channels', channelListSchema, 'GET', undefined, signal),
      api('/users', memberListSchema, 'GET', undefined, signal),
    ]).then(([workspaces, channels, members]) => {
      if (signal.aborted) return
      this.workspaces = workspaces
      const previous = this.active
      const byId = new Map(channels.map(channel => [channel.id, channel]))
      for (const [id, row] of this.channelEdits) row ? byId.set(id, row) : byId.delete(id)
      this.channels = [...byId.values()]
      const directory = Object.fromEntries(members.map(member => [member.id, member]))
      for (const [id, member] of this.directoryEdits) {
        if (member) directory[id] = member
        else delete directory[id]
      }
      this.directory = directory
      for (const member of Object.values(directory)) {
        if (!this.presence[member.id]) {
          this.presence[member.id] = { online: member.online, runtime: member.bot?.runtime_meta ?? undefined }
        }
      }
      const selected = byId.get(this.activeId)
      if (!selected) {
        const firstChannel = this.channels.find(channel => channel.name === 'general' && channel.type === 'public')
          ?? this.channels.find(channel => channel.type !== 'dm')
          ?? this.channels[0]
        if (firstChannel) this.select(firstChannel.id)
      } else if (previous?.member_count !== selected.member_count) {
        void this.loadMembers(selected.id, true)
      }
    }).finally(() => {
      if (this.syncingLists !== promise) return
      this.syncingLists = undefined
      this.channelEdits.clear()
      this.directoryEdits.clear()
    })
    this.syncingLists = promise
    return promise
  }

  folderUnread(folderId: string) {
    return this.channels
      .filter(c => c.type !== 'dm' && c.workspace_id === folderId && !c.muted)
      .reduce((sum, c) => sum + c.unread_count, 0)
  }

  private touchFeed(key: string) {
    this.feedOrder = [key, ...this.feedOrder.filter(item => item !== key)]
  }

  private pruneMemory() {
    const activeMain = this.activeId ? scopeKey(this.activeId, null) : ''
    const activeThread = this.activeId && this.threadId ? scopeKey(this.activeId, this.threadId) : ''
    const protectedKeys = new Set([activeMain, activeThread].filter(Boolean))
    for (const item of this.pending) protectedKeys.add(scopeKey(item.channel, item.payload.thread_root_id))

    // Trim inactive feeds to latest 80 messages to keep DOM & heap bounded.
    for (const [key, feed] of Object.entries(this.feeds)) {
      if (protectedKeys.has(key) || feed.loading) continue
      if (feed.rows.some(row => row.status === 'streaming' || row.status === 'queued')) { protectedKeys.add(key); continue }
      if (feed.rows.length > 80) {
        feed.rows = feed.rows.slice(-80)
        feed.before = feed.rows[0]?.id ?? feed.before
      }
    }

    // Evict least-recently-used inactive feeds beyond 8 cached views.
    const keep: string[] = []
    for (const key of this.feedOrder) {
      if (!this.feeds[key]) continue
      if (protectedKeys.has(key) || keep.length < 8) {
        keep.push(key)
      } else {
        delete this.feeds[key]
      }
    }
    this.feedOrder = keep

    // Cap single-message detail cache at 120 entries.
    const detailKeys = Object.keys(this.details)
    if (detailKeys.length > 120) {
      const keepDetails = new Set([this.threadId, this.active?.pinned_message_id].filter((id): id is string => Boolean(id)))
      let toDrop = detailKeys.length - 120
      for (const id of detailKeys) {
        if (toDrop <= 0) break
        if (keepDetails.has(id)) continue
        delete this.details[id]
        this.detailsChanged.delete(id)
        toDrop--
      }
    }
  }

  select(id: string) {
    if (id === this.activeId) return
    this.activeId = id
    this.threadId = null
    this.pins = []
    this.files = []
    if (this.rightMode === 'thread' || this.rightMode === 'pins' || this.rightMode === 'files') {
      this.rightMode = 'members'
    }
    if (!id) { this.pruneMemory(); return }
    const target = this.channels.find(channel => channel.id === id)
    const hadUnread = target?.unread_count ?? 0
    this.ensureFeed(id)
    this.pruneMemory()
    void this.loadFeed(id, null, 'sync').then(() => {
      if (hadUnread > 0) {
        const rows = this.feeds[id]?.rows ?? []
        const others = rows.filter(row => row.author_id !== this.user?.id)
        const firstUnread = others.at(-Math.min(hadUnread, others.length))
        this.unreadStartId[id] = firstUnread?.id ?? null
      } else {
        this.unreadStartId[id] = null
      }
    })
    void this.loadMembers(id)
  }

  setChannel(channel: Channel) {
    this.applyChannel(channel)
  }

  async toggleMute(channelId: string) {
    const channel = this.channels.find(item => item.id === channelId)
    if (!channel) return
    const updated = await api(
      `/channels/${channelId}/preferences`, channelSchema, 'PATCH',
      channelPreferenceSchema.parse({ muted: !channel.muted }),
    )
    this.applyChannel(updated)
    this.toast(updated.muted ? '已静音该频道通知' : '已开启该频道通知', 'info')
  }

  async readAll() {
    await api('/channels/read-all', okResponseSchema, 'POST')
    this.unreadStartId = {}
    await this.syncLists()
    this.toast('已将全部频道标为已读', 'success')
  }

  async dm(id: string) {
    const channel = await api('/channels/dm', channelSchema, 'POST', dmCreateSchema.parse({ target_user_id: id }))
    this.applyChannel(channel)
    this.select(channel.id)
    return channel
  }

  openThread(id: string) {
    if (!this.activeId) return
    this.threadId = id
    this.rightMode = 'thread'
    this.ensureFeed(this.activeId, id)
    void this.loadFeed(this.activeId, id, 'sync')
    if (!this.findMessage(id)) void this.loadDetail(id)
  }

  closeThread() {
    this.threadId = null
    if (this.rightMode === 'thread') this.rightMode = 'members'
  }

  openRightPanel(mode: RightPanelMode) {
    if (mode !== 'thread') this.threadId = null
    this.rightMode = mode
    if (mode === 'pins' && this.activeId) void this.refreshPins(this.activeId)
    if (mode === 'files' && this.activeId) void this.refreshFiles(this.activeId)
    if (mode === 'bookmarks') void this.refreshBookmarks()
  }

  async refreshPins(channelId: string) {
    this.pinsLoading = true
    try { this.pins = await listPins(channelId) }
    catch (error) { this.report(error) }
    finally { this.pinsLoading = false }
  }

  async pinMessage(channelId: string, messageId: string) {
    this.pins = await addPin(channelId, messageId)
    this.toast('已置顶消息', 'success')
  }

  async unpinMessage(channelId: string, messageId: string) {
    await removePin(channelId, messageId)
    this.pins = this.pins.filter(item => item.id !== messageId)
    this.toast('已取消置顶', 'info')
  }

  async refreshFiles(channelId: string) {
    this.filesLoading = true
    try { this.files = await listChannelFiles(channelId) }
    catch (error) { this.report(error) }
    finally { this.filesLoading = false }
  }

  async refreshBookmarks() {
    this.bookmarksLoading = true
    try { this.bookmarks = await listBookmarks() }
    catch (error) { this.report(error) }
    finally { this.bookmarksLoading = false }
  }

  async toggleBookmark(message: Message) {
    if (this.bookmarkIds.has(message.id)) {
      await removeBookmark(message.id)
      this.bookmarks = this.bookmarks.filter(item => item.message.id !== message.id)
      this.toast('已取消收藏', 'info')
    } else {
      const saved = await saveBookmark(message.id)
      this.bookmarks = [saved, ...this.bookmarks.filter(item => item.message.id !== message.id)]
      this.toast('已加入收藏夹', 'success')
    }
  }

  async react(messageId: string, emoji: string) {
    const { reactions } = await toggleReaction(messageId, emoji)
    for (const feed of Object.values(this.feeds)) {
      const target = feed.rows.find(row => row.id === messageId)
      if (target) target.reactions = reactions
    }
    const detail = this.details[messageId]
    if (detail) detail.reactions = reactions
  }

  async regenerate(messageId: string) {
    const updated = await regenerateMessage(messageId)
    this.applyMessage(updated)
  }

  async setBoardStatus(message: Message, board_status: BoardStatus) {
    const updated = await api(
      `/messages/${message.id}`, messageSchema, 'PATCH',
      messagePatchSchema.parse({ board_status }),
    )
    this.applyMessage(updated)
  }

  setReply(channelId: string, threadId: string | null, message: Message | null) {
    this.replyingTo[scopeKey(channelId, threadId)] = message
  }

  async jumpToMessage(channelId: string, messageId: string, threadRootId?: string | null) {
    if (channelId !== this.activeId) {
      this.activeId = channelId
      this.threadId = null
      void this.loadMembers(channelId)
    }
    if (threadRootId) {
      this.threadId = threadRootId
      this.rightMode = 'thread'
      if (!this.findMessage(threadRootId)) await this.loadDetail(threadRootId)
      await this.loadAround(channelId, threadRootId, messageId)
    } else {
      await this.loadAround(channelId, null, messageId)
    }
    this.highlightedId = messageId
    clearTimeout(this.highlightTimer)
    this.highlightTimer = setTimeout(() => {
      if (this.highlightedId === messageId) this.highlightedId = null
    }, 2600)
  }

  async loadAround(channel: string, thread: string | null, targetId: string) {
    const key = scopeKey(channel, thread)
    const feed = this.ensureFeed(channel, thread)
    if (feed.rows.some(row => row.id === targetId)) return
    const signal = this.lifetime.signal
    feed.loading = true
    feed.error = ''
    try {
      const page = await messages(channel, { thread, around: targetId, limit: 50 }, signal)
      if (signal.aborted || this.feeds[key] !== feed) return
      const merged = new Map(feed.rows.map(row => [row.id, row]))
      for (const row of page.messages) merged.set(row.id, row)
      feed.rows = sorted(merged.values())
      feed.before = page.next_before
      feed.loaded = true
    } catch (error) {
      if (!signal.aborted) this.report(error)
    } finally {
      feed.loading = false
    }
  }

  feed(channel: string, thread?: string | null) {
    return this.feeds[scopeKey(channel, thread)]
  }

  private ensureFeed(channel: string, thread?: string | null) {
    const key = scopeKey(channel, thread)
    this.feeds[key] ??= newFeed()
    this.touchFeed(key)
    return this.feeds[key]
  }

  async loadFeed(channel: string, thread: string | null, direction: 'older' | 'sync') {
    const key = scopeKey(channel, thread)
    const feed = this.ensureFeed(channel, thread)
    if (feed.loading) {
      if (direction === 'sync') this.syncAgain.add(key)
      return
    }
    if (direction === 'older' && !feed.before) return
    const signal = this.lifetime.signal
    feed.loading = true
    feed.error = ''
    const marks = new Map<string, Message | null>()
    this.syncMarks.set(key, marks)
    try {
      const oldest = direction === 'sync' ? feed.rows[0]?.id : undefined
      const baseline = new Set(feed.rows.map(row => row.id))
      const pulled = new Map<string, Message>()
      let before = direction === 'older' ? feed.before : null
      do {
        const page = await messages(channel, { thread, before }, signal)
        if (signal.aborted || this.feeds[key] !== feed) return
        for (const row of page.messages) pulled.set(row.id, row)
        before = page.next_before
        if (!oldest || page.messages.some(row => row.id <= oldest)) break
      } while (before)
      const current = new Map(feed.rows.map(row => [row.id, row]))
      if (direction === 'sync') {
        for (const id of baseline) if (!marks.has(id) && !pulled.has(id)) current.delete(id)
      }
      for (const [id, row] of pulled) {
        const live = marks.get(id)
        if (live === null) continue
        const latest = live ?? row
        current.set(id, latest)
        if (Object.hasOwn(this.details, id)) this.details[id] = latest
      }
      feed.rows = sorted(current.values())
      feed.before = before
      feed.loaded = true
    } catch (error) {
      if (signal.aborted || this.feeds[key] !== feed) return
      feed.error = errorText(error)
      if (error instanceof ApiFailure && error.status === 401) this.report(error)
    } finally {
      if (this.syncMarks.get(key) === marks) this.syncMarks.delete(key)
      feed.loading = false
      if (!signal.aborted && this.feeds[key] === feed && this.syncAgain.delete(key)) void this.loadFeed(channel, thread, 'sync')
    }
  }

  async loadMembers(channel: string, queue = false) {
    const previous = this.memberLoads.get(channel)
    if (previous) { previous.again ||= queue; return }
    const signal = this.lifetime.signal
    const job = { again: false }
    this.memberLoads.set(channel, job)
    try {
      do {
        job.again = false
        const members = await api(`/channels/${channel}/members`, memberListSchema, 'GET', undefined, signal)
        if (signal.aborted || !this.channels.some(room => room.id === channel)) return
        for (const member of members) {
          this.directory[member.id] = member
          this.presence[member.id] = { online: member.online, runtime: member.bot?.runtime_meta ?? undefined }
        }
        this.memberIds[channel] = members.map(member => member.id)
      } while (job.again)
    } catch (error) {
      if (!signal.aborted && this.channels.some(room => room.id === channel)) this.report(error)
    } finally {
      if (this.memberLoads.get(channel) === job) this.memberLoads.delete(channel)
    }
  }

  findMessage(id: string) {
    return Object.values(this.feeds).find(feed => feed.rows.some(row => row.id === id))?.rows.find(row => row.id === id)
      ?? this.details[id] ?? undefined
  }

  async loadDetail(id: string, refresh = false) {
    if (this.detailLoading.has(id) || (!refresh && this.findMessage(id))) return
    const signal = this.lifetime.signal
    const previous = this.detailsChanged.get(id)
    this.detailLoading.add(id)
    try {
      const row = await api(`/messages/${id}`, messageSchema, 'GET', undefined, signal)
      if (signal.aborted || this.detailsChanged.get(id) !== previous) return
      this.details[id] = row
      this.applyMessage(row)
    } catch (error) {
      if (signal.aborted || this.detailsChanged.get(id) !== previous) return
      if (error instanceof ApiFailure && error.status === 404) {
        this.details[id] = null
        if (this.threadId === id) this.closeThread()
      } else this.report(error)
    } finally {
      if (!signal.aborted) this.detailLoading.delete(id)
    }
  }

  applyMessage(message: Message, insert = false) {
    const key = scopeKey(message.channel_id, message.thread_root_id)
    const feed = this.feeds[key]
    const current = feed?.rows.find(row => row.id === message.id)
    if (current && current.updated_at > message.updated_at) return
    this.syncMarks.get(key)?.set(message.id, message)
    this.detailsChanged.set(message.id, (this.detailsChanged.get(message.id) ?? 0) + 1)
    if (feed && (insert || current)) {
      feed.rows = sorted([...feed.rows.filter(row => row.id !== message.id), message])
    }
    if (Object.hasOwn(this.details, message.id) || this.threadId === message.id ||
        this.active?.pinned_message_id === message.id) this.details[message.id] = message
  }

  async submit(channel: string, raw: SendMessageRequest) {
    const trimmed = raw.content.trim()
    if (!raw.attachments?.length && /^\/(?:reset|model|ask|status)(?:\s|$)/i.test(trimmed)) {
      const result = await runSlashCommand(channel, trimmed, raw.thread_root_id)
      if (result.created_message) this.applyMessage(result.created_message, true)
      this.toast(result.message, 'success')
      return
    }
    const payload = sendMessageSchema.parse(raw)
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const signal = this.lifetime.signal
    this.pending = [...this.pending, { nonce, channel, payload, createdAt: Date.now(), state: 'sending' }]
    const event = clientUpSchema.parse({ type: 'message.send', channel_id: channel, ...payload, client_nonce: nonce })
    if (this.transmit(event)) {
      this.pendingTimers.set(nonce, setTimeout(() => this.failPending(nonce, '服务器尚未确认这条消息。', 'unconfirmed'), 12_000))
      return
    }
    try {
      const sent = await sendMessage(channel, payload, signal)
      if (signal.aborted) return
      this.applyMessage(sent, true)
      this.dismissPending(nonce)
      if (sent.thread_root_id) void this.loadDetail(sent.thread_root_id, true)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiFailure && error.status === 401) { this.report(error); return }
      this.failPending(nonce, errorText(error), error instanceof ApiFailure ? 'failed' : 'unconfirmed')
    }
  }

  private failPending(nonce: string, error: string, state: PendingMessage['state'] = 'failed') {
    clearTimeout(this.pendingTimers.get(nonce))
    this.pendingTimers.delete(nonce)
    this.pending = this.pending.map(item => item.nonce === nonce ? { ...item, error, state } : item)
  }

  dismissPending(nonce: string) {
    clearTimeout(this.pendingTimers.get(nonce))
    this.pendingTimers.delete(nonce)
    this.pending = this.pending.filter(item => item.nonce !== nonce)
  }

  async abort(id: string) {
    if (this.transmit({ type: 'message.abort', message_id: id })) return
    await api(`/messages/${id}/abort`, okResponseSchema, 'POST')
    await this.loadDetail(id, true)
  }

  markRead(channel: string, id: string) {
    if (document.visibilityState !== 'visible' || channel !== this.activeId) return
    const previous = this.readQueue.get(channel) ?? this.readSent.get(channel) ?? ''
    if (previous >= id) return
    this.readQueue.set(channel, id)
    if (!this.readTimer) this.readTimer = setTimeout(() => void this.flushReads(), 360)
  }

  private async flushReads() {
    this.readTimer = undefined
    const signal = this.lifetime.signal
    const entries = [...this.readQueue]
    this.readQueue.clear()
    for (const [channel, id] of entries) {
      if (signal.aborted || (this.readSent.get(channel) ?? '') >= id) continue
      this.readSent.set(channel, id)
      if (this.transmit({ type: 'read.ack', channel_id: channel, last_read_message_id: id })) continue
      try {
        await api(`/channels/${channel}/read`, okResponseSchema, 'POST', { last_read_message_id: id }, signal)
        if (!signal.aborted) await this.syncLists()
      } catch (error) {
        if (!signal.aborted && this.readSent.get(channel) === id) this.readSent.delete(channel)
        if (!signal.aborted && !(error instanceof ApiFailure && error.status === 404)) this.report(error)
      }
    }
  }

  announceTyping(channel: string, thread?: string | null) {
    const key = scopeKey(channel, thread)
    if (Date.now() - (this.typingAt.get(key) ?? 0) < 1600) return
    if (this.transmit({ type: 'typing', channel_id: channel, thread_root_id: thread })) this.typingAt.set(key, Date.now())
  }

  private receiveTyping(event: Extract<ClientDown, { type: 'typing' }>) {
    if (event.user_id === this.user?.id) return
    const key = scopeKey(event.channel_id, event.thread_root_id)
    const id = event.user_id
    const timerKey = `${key}/${id}`
    this.typing[key] = [...new Set([...(this.typing[key] ?? []), id])]
    clearTimeout(this.typingTimers.get(timerKey))
    this.typingTimers.set(timerKey, setTimeout(() => {
      const next = (this.typing[key] ?? []).filter(user => user !== id)
      if (next.length) this.typing[key] = next
      else delete this.typing[key]
      this.typingTimers.delete(timerKey)
    }, 4200))
  }
}
