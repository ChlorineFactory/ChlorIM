import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { Channel, ClientDown, Message, ReactionSummary, SendMessageRequest, User, Workspace } from '@chiorim/shared'
import { bots, channelMembers, channelPins, channels, messages, queuedRuns, reactions, users, workspaces } from './db.js'
import type { ChannelRow, Database, MessageRow, UserRow, WorkspaceRow } from './db.js'
import { fail } from './errors.js'

export const publicUser = ({ password_hash: _, ...user }: UserRow): User => user
export const MAX_BOT_HOPS = 2
const nextMessageId = monotonicFactory()

export function resolveEffectiveWorkDir(workspaceDir?: string | null, channelDir?: string | null): string | null {
  const ch = channelDir?.trim()
  const ws = workspaceDir?.trim()
  if (ch) {
    if (ch.startsWith('/') || ch.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(ch)) return ch
    if (ws) return `${ws.replace(/[\\/]+$/, '')}/${ch.replace(/^[\\/]+/, '')}`
    return ch
  }
  return ws || null
}

export function createChat(db: Database, publish: (event: ClientDown, channelId?: string, nonceOwner?: string) => void,
  direct: (userId: string, event: ClientDown) => void) {
  function memberIds(id: string) {
    return db.select({ id: channelMembers.user_id }).from(channelMembers).where(eq(channelMembers.channel_id, id)).all().map(row => row.id)
  }

  function channelRow(id: string) {
    const row = db.select().from(channels).where(eq(channels.id, id)).get()
    if (!row) fail(404, 'CHANNEL_NOT_FOUND', 'Channel not found')
    return row
  }

  function membership(channelId: string, userId: string) {
    return db.select().from(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId))).get()
  }

  function access(id: string, userId: string) {
    if (!membership(id, userId)) fail(404, 'CHANNEL_NOT_FOUND', 'Channel not found')
    return channelRow(id)
  }

  function manageChannel(id: string, user: User) {
    const channel = user.is_admin ? channelRow(id) : access(id, user.id)
    if (!user.is_admin && channel.created_by !== user.id) fail(403, 'FORBIDDEN', 'Channel owner or administrator required')
    return channel
  }

  function visible(userId: string) {
    return db.select({ channel: channels }).from(channelMembers).innerJoin(channels, eq(channels.id, channelMembers.channel_id))
      .where(eq(channelMembers.user_id, userId)).orderBy(channels.created_at, channels.id).all().map(row => row.channel)
  }

  function workspaceRow(id: string): WorkspaceRow {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get()
    if (!row) fail(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found')
    return row
  }

  function listWorkspaces(): Workspace[] {
    return db.select().from(workspaces).orderBy(workspaces.created_at, workspaces.id).all()
  }

  function defaultWorkspaceId() {
    return db.select({ id: workspaces.id }).from(workspaces).orderBy(workspaces.created_at, workspaces.id).get()?.id ?? null
  }

  function createWorkspace(owner: string, data: {
    name: string
    work_dir?: string | null
    host_bot_id?: string | null
    host_name?: string | null
    icon?: string | null
    color?: string | null
    description?: string
  }) {
    return db.insert(workspaces).values({
      id: randomUUID(),
      name: data.name,
      work_dir: data.work_dir ?? null,
      host_bot_id: data.host_bot_id ?? null,
      host_name: data.host_name ?? null,
      icon: data.icon ?? null,
      color: data.color ?? null,
      description: data.description ?? '',
      created_by: owner,
      created_at: Date.now(),
    }).returning().get()
  }

  function effectiveWorkDir(row: ChannelRow) {
    if (row.type === 'dm') return null
    const ws = row.workspace_id ? db.select({ work_dir: workspaces.work_dir }).from(workspaces).where(eq(workspaces.id, row.workspace_id)).get() : undefined
    return resolveEffectiveWorkDir(ws?.work_dir, row.work_dir)
  }

  function channelDto(row: ChannelRow, userId: string): Channel {
    const ids = memberIds(row.id)
    const peerId = row.type === 'dm' ? ids.find(id => id !== userId) : undefined
    const peer = peerId ? db.select().from(users).where(eq(users.id, peerId)).get() : undefined
    const read = membership(row.id, userId)
    const counts = db.select({
      last: sql<number | null>`max(${messages.created_at})`,
      unread: sql<number>`count(case when ${messages.author_id} <> ${userId} and
        ${messages.id} > ${read?.last_read_message_id ?? ''} then 1 end)`,
    }).from(messages).where(eq(messages.channel_id, row.id)).get()!
    const pinned_count = db.select({ count: sql<number>`count(*)` }).from(channelPins).where(eq(channelPins.channel_id, row.id)).get()!.count
    const { dm_key: _, ...channel } = row
    return {
      ...channel,
      effective_work_dir: effectiveWorkDir(row),
      dm_peer: peer ? publicUser(peer) : null,
      member_count: ids.length,
      unread_count: counts.unread,
      last_message_at: counts.last,
      pinned_count,
      muted: read?.muted ?? false,
    }
  }

  function notifyChannel(id: string) {
    const row = channelRow(id)
    for (const idToNotify of memberIds(id)) direct(idToNotify, { type: 'channel.updated', channel: channelDto(row, idToNotify) })
  }

  function addMembers(id: string, ids: string[], when = Date.now()) {
    if (!ids.length) return
    const distinct = [...new Set(ids)]
    const found = db.select({ id: users.id }).from(users).leftJoin(bots, eq(users.id, bots.user_id))
      .where(and(inArray(users.id, distinct), or(eq(users.kind, 'human'), isNotNull(bots.user_id)))).all()
    if (found.length !== distinct.length) fail(400, 'USER_NOT_FOUND', 'A channel member does not exist')
    db.insert(channelMembers).values(distinct.map(user_id => ({ channel_id: id, user_id, joined_at: when })))
      .onConflictDoNothing().run()
  }

  function createChannel(owner: string, data: { type: ChannelRow['type']; name: string; topic?: string; system_context?: string; workspace_id?: string | null; work_dir?: string | null; dm_key?: string }, ids: string[]) {
    return db.transaction(() => {
      const workspace_id = data.type === 'dm' ? null : (data.workspace_id ? workspaceRow(data.workspace_id).id : defaultWorkspaceId())
      const row = db.insert(channels).values({ ...data, workspace_id, work_dir: data.type === 'dm' ? null : (data.work_dir ?? null), id: randomUUID(), created_by: owner, created_at: Date.now() }).returning().get()
      const automatic = row.type === 'public' || row.type === 'board'
        ? db.select({ id: users.id }).from(users).where(and(eq(users.disabled, false), row.type === 'board' ? eq(users.kind, 'human') : undefined)).all().map(row => row.id)
        : []
      addMembers(row.id, [owner, ...ids, ...automatic], row.created_at)
      return row
    })
  }

  function dm(owner: string, target: string) {
    if (owner === target) fail(400, 'INVALID_DM', 'A DM needs two distinct members')
    if (!db.select({ id: users.id }).from(users).where(and(eq(users.id, target), eq(users.disabled, false))).get()) {
      fail(404, 'USER_NOT_FOUND', 'Available user not found')
    }
    return db.transaction(() => {
      const key = [owner, target].sort().join(':')
      return db.select().from(channels).where(eq(channels.dm_key, key)).get()
        ?? createChannel(owner, { type: 'dm', name: '', dm_key: key }, [target])
    }, { behavior: 'immediate' })
  }

  function messageRow(id: string) {
    const row = db.select().from(messages).where(eq(messages.id, id)).get()
    if (!row) fail(404, 'MESSAGE_NOT_FOUND', 'Message not found')
    return row
  }

  function messageInChannel(channelId: string, id: string) {
    const message = db.select().from(messages).where(and(eq(messages.id, id), eq(messages.channel_id, channelId))).get()
    if (!message) fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this channel')
    return message
  }

  function reactionSummary(id: string): ReactionSummary[] {
    const rows = db.select({ emoji: reactions.emoji, userId: reactions.user_id }).from(reactions)
      .where(eq(reactions.message_id, id)).orderBy(reactions.created_at, reactions.user_id).all()
    const groups = new Map<string, string[]>()
    for (const { emoji, userId } of rows) {
      const ids = groups.get(emoji) ?? []
      ids.push(userId)
      groups.set(emoji, ids)
    }
    return Array.from(groups, ([emoji, user_ids]) => ({ emoji, count: user_ids.length, user_ids }))
  }

  function dto(row: MessageRow): Message {
    const author = db.select().from(users).where(eq(users.id, row.author_id)).get()!
    const { blocks_json: blocks, ...message } = row
    const status = row.status === 'streaming'
      && db.select({ id: queuedRuns.message_id }).from(queuedRuns).where(eq(queuedRuns.message_id, row.id)).get()
      ? 'queued' as const
      : row.status
    const reply_count = row.thread_root_id ? 0 : db.select({ count: sql<number>`count(*)` }).from(messages)
      .where(eq(messages.thread_root_id, row.id)).get()!.count
    const quote = row.reply_to_id ? db.select({
      id: messages.id, author_id: messages.author_id, author_name: users.display_name, author_username: users.username,
      content: messages.content, status: messages.status,
    }).from(messages).innerJoin(users, eq(users.id, messages.author_id))
      .where(and(eq(messages.id, row.reply_to_id), eq(messages.channel_id, row.channel_id))).get() : undefined
    return { ...message, status, author: publicUser(author), blocks, reply_count, reply_to: quote ?? null, reactions: reactionSummary(row.id) }
  }

  function root(channelId: string, rootId?: string | null) {
    if (!rootId) return
    const row = messageRow(rootId)
    if (row.channel_id !== channelId || row.thread_root_id) fail(404, 'THREAD_NOT_FOUND', 'Thread root not found in this channel')
    return row
  }

  function listMessages(channelId: string, threadId: string | null, limit: number, before?: string, through?: string) {
    return db.select().from(messages).where(and(
      eq(messages.channel_id, channelId),
      threadId ? eq(messages.thread_root_id, threadId) : isNull(messages.thread_root_id),
      before ? lt(messages.id, before) : undefined,
      through ? and(lte(messages.id, through), eq(messages.status, 'done')) : undefined,
    )).orderBy(desc(messages.id)).limit(limit).all()
  }

  function around(channelId: string, target: MessageRow, limit: number) {
    const scope = and(eq(messages.channel_id, channelId), target.thread_root_id
      ? eq(messages.thread_root_id, target.thread_root_id) : isNull(messages.thread_root_id))
    const newer = db.select().from(messages).where(and(scope, gt(messages.id, target.id)))
      .orderBy(asc(messages.id)).limit(limit - 1).all()
    const older = db.select().from(messages).where(and(scope, lt(messages.id, target.id)))
      .orderBy(desc(messages.id)).limit(limit).all()
    const takeNewer = Math.min(newer.length, Math.max(Math.floor((limit - 1) / 2), limit - 1 - older.length))
    const takeOlder = limit - 1 - takeNewer
    const page = [...newer.slice(0, takeNewer).reverse(), target, ...older.slice(0, takeOlder)]
    return { messages: page.map(dto), next_before: older.length > takeOlder ? page.at(-1)!.id : null }
  }

  function pinRows(id: string) {
    return db.select({ message: messages }).from(channelPins).innerJoin(messages, eq(messages.id, channelPins.message_id))
      .where(eq(channelPins.channel_id, id)).orderBy(desc(channelPins.created_at), desc(channelPins.message_id)).all()
  }

  function refreshPins(id: string) {
    const latest = db.select({ id: channelPins.message_id }).from(channelPins).where(eq(channelPins.channel_id, id))
      .orderBy(desc(channelPins.created_at), desc(channelPins.message_id)).limit(1).get()
    return db.update(channels).set({ pinned_message_id: latest?.id ?? null }).where(eq(channels.id, id)).returning().get()
  }

  function addPin(id: string, messageId: string, actor: string, promote = false) {
    messageInChannel(id, messageId)
    const input = { channel_id: id, message_id: messageId, pinned_by: actor, created_at: Date.now() }
    const latest = db.select({ time: sql<number | null>`max(${channelPins.created_at})` }).from(channelPins)
      .where(eq(channelPins.channel_id, id)).get()?.time
    input.created_at = Math.max(input.created_at, (latest ?? 0) + 1)
    const insert = db.insert(channelPins).values(input)
    if (promote) insert.onConflictDoUpdate({ target: [channelPins.channel_id, channelPins.message_id],
      set: { pinned_by: actor, created_at: input.created_at } }).run()
    else insert.onConflictDoNothing().run()
    return refreshPins(id)
  }

  function insert(data: Omit<typeof messages.$inferInsert, 'id' | 'created_at' | 'updated_at'>) {
    const now = Date.now()
    return db.insert(messages).values({ ...data, id: nextMessageId(now), created_at: now, updated_at: now }).returning().get()
  }

  function created(row: MessageRow, clientNonce?: string) {
    const message = dto(row)
    publish({ type: 'message.created', message, client_nonce: clientNonce }, row.channel_id, row.author_id)
    if (row.thread_root_id) publish({ type: 'message.updated', message: dto(messageRow(row.thread_root_id)) }, row.channel_id)
    notifyChannel(row.channel_id)
    return message
  }

  function validateBoardStatus(channel: ChannelRow, threadId?: string | null) {
    if (channel.type !== 'board' || threadId) fail(400, 'INVALID_BOARD_STATUS', 'Status applies only to top-level board messages')
  }

  function send(user: User, channelId: string, input: SendMessageRequest, clientNonce?: string, botHops = 1) {
    const channel = access(channelId, user.id)
    root(channelId, input.thread_root_id)
    const quote = input.reply_to_id ? messageInChannel(channelId, input.reply_to_id) : undefined
    if (input.board_status != null) validateBoardStatus(channel, input.thread_root_id)
    const row = insert({
      channel_id: channelId, thread_root_id: input.thread_root_id ?? null, author_id: user.id,
      content: input.content, reply_to_id: input.reply_to_id ?? null, bot_hop_count: user.kind === 'bot' ? Math.max(botHops, Math.min(MAX_BOT_HOPS, (quote?.bot_hop_count ?? 0) + 1)) : 0,
      board_status: channel.type === 'board' && !input.thread_root_id ? input.board_status ?? 'open' : null,
      blocks_json: input.attachments?.map(attachment => ({ ...attachment, type: 'attachment' })),
    })
    return { row, message: created(row, clientNonce) }
  }

  function advanceRead(userId: string, channelId: string, messageId: string) {
    db.update(channelMembers).set({ last_read_message_id: messageId, last_read_at: Date.now() }).where(and(
      eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId),
      sql`(${channelMembers.last_read_message_id} is null or ${channelMembers.last_read_message_id} < ${messageId})`,
    )).run()
  }

  function notifyViewer(channel: ChannelRow, userId: string) {
    const dto = channelDto(channel, userId)
    direct(userId, { type: 'channel.updated', channel: dto })
    return dto
  }

  function read(userId: string, channelId: string, messageId: string) {
    const room = access(channelId, userId)
    messageInChannel(channelId, messageId)
    advanceRead(userId, channelId, messageId)
    notifyViewer(room, userId)
  }

  function readAll(userId: string) {
    const rooms = visible(userId)
    db.transaction(() => {
      for (const room of rooms) {
        const row = db.select({ id: messages.id }).from(messages).where(eq(messages.channel_id, room.id))
          .orderBy(desc(messages.id)).limit(1).get()
        if (row) advanceRead(userId, room.id, row.id)
      }
    })
    for (const room of rooms) notifyViewer(room, userId)
  }

  function memberBots(channelId: string) {
    return db.select({ bot: bots, user: users }).from(channelMembers)
      .innerJoin(bots, eq(bots.user_id, channelMembers.user_id)).innerJoin(users, eq(users.id, bots.user_id))
      .where(eq(channelMembers.channel_id, channelId)).all()
  }

  return {
    workspaceRow, listWorkspaces, defaultWorkspaceId, createWorkspace, effectiveWorkDir,
    membership, access, manageChannel, visible, memberIds, channelRow, channelDto, notifyChannel, addMembers, createChannel, dm,
    messageRow, messageInChannel, dto, reactionSummary, root, listMessages, around, pinRows, refreshPins, addPin,
    insert, created, send, validateBoardStatus, read, readAll, notifyViewer, memberBots,
  }
}
