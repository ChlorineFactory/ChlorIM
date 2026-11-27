import { and, eq, inArray, or, sql } from 'drizzle-orm'
import {
  addMembersSchema, channelCreateSchema, channelPatchSchema, channelPreferenceSchema, dmCreateSchema, messagePatchSchema,
  pageMessagesSchema, pinCreateSchema, reactionToggleSchema, readAckSchema, respondPromptSchema, sendMessageSchema,
  workspaceCreateSchema, workspacePatchSchema,
} from '@chiorim/shared'
import type { User } from '@chiorim/shared'
import { botSessions, bots, channelMembers, channelPins, channels, messages, reactions, users, workspaces } from './db.js'
import type { ChannelRow, MessageRow } from './db.js'
import { body, fail, parse } from './errors.js'
import { registerDiscovery } from './discovery.js'
import { registerCommands } from './commands.js'
import type { App, Services } from './app.js'

export function registerChat(app: App, services: Services) {
  const { db, chat, realtime, engine } = services
  registerDiscovery(app, services)
  registerCommands(app, services)

  function manageMessage(user: User, messageId: string) {
    const row = chat.messageRow(messageId)
    chat.access(row.channel_id, user.id)
    if (!user.is_admin && row.author_id !== user.id) fail(403, 'FORBIDDEN', 'Message author or administrator required')
    return row
  }

  function resolveHostMeta(hostBotId?: string | null, hostName?: string | null) {
    if (!hostBotId) return { host_bot_id: null, host_name: hostName ?? null }
    const bot = db.select({ bot: bots, user: users }).from(bots)
      .innerJoin(users, eq(bots.user_id, users.id))
      .where(eq(bots.user_id, hostBotId)).get()
    if (!bot || (bot.bot.mode !== 'bridge' && bot.bot.mode !== 'local')) fail(400, 'INVALID_HOST_BOT', 'Selected device must be an Agent bot')
    const live = realtime.runtime(hostBotId)
    return {
      host_bot_id: hostBotId,
      host_name: hostName ?? live?.hostname ?? bot.bot.runtime_meta_json?.hostname ?? bot.user.display_name,
    }
  }

  app.get('/api/workspaces', c => c.json(chat.listWorkspaces()))
  app.post('/api/workspaces', async c => {
    const { create_default_channel, host_bot_id, host_name, ...rest } = await body(c, workspaceCreateSchema)
    const userId = c.get('user').id
    const host = resolveHostMeta(host_bot_id, host_name)
    const { workspace, defaultChannel } = db.transaction(() => {
      const workspace = chat.createWorkspace(userId, { ...rest, ...host })
      const defaultChannel = create_default_channel
        ? chat.createChannel(userId, { type: 'public', name: 'general', workspace_id: workspace.id }, [])
        : undefined
      return { workspace, defaultChannel }
    })
    realtime.publish({ type: 'workspace.updated', workspace })
    if (defaultChannel) chat.notifyChannel(defaultChannel.id)
    return c.json(workspace, 201)
  })
  app.patch('/api/workspaces/:id', async c => {
    const patch = await body(c, workspacePatchSchema)
    const user = c.get('user')
    const current = chat.workspaceRow(c.req.param('id'))
    if (!user.is_admin && current.created_by !== user.id) fail(403, 'FORBIDDEN', 'Workspace owner or administrator required')
    const nextPatch = { ...patch }
    if (patch.host_bot_id !== undefined) {
      Object.assign(nextPatch, resolveHostMeta(patch.host_bot_id, patch.host_name))
    }
    const updated = Object.keys(nextPatch).length
      ? db.update(workspaces).set(nextPatch).where(eq(workspaces.id, current.id)).returning().get()
      : current
    realtime.publish({ type: 'workspace.updated', workspace: updated })
    for (const room of db.select({ id: channels.id }).from(channels).where(eq(channels.workspace_id, updated.id)).all()) {
      chat.notifyChannel(room.id)
    }
    return c.json(updated)
  })
  app.delete('/api/workspaces/:id', c => {
    const user = c.get('user')
    const current = chat.workspaceRow(c.req.param('id'))
    if (!user.is_admin && current.created_by !== user.id) fail(403, 'FORBIDDEN', 'Workspace owner or administrator required')
    const rooms = db.select({ id: channels.id }).from(channels).where(eq(channels.workspace_id, current.id)).all()
    const audiences = rooms.map(room => ({ id: room.id, members: chat.memberIds(room.id) }))
    removeChannels(rooms.map(room => room.id))
    db.delete(workspaces).where(eq(workspaces.id, current.id)).run()
    for (const room of audiences) {
      for (const id of room.members) realtime.direct(id, { type: 'channel.removed', channel_id: room.id })
    }
    realtime.publish({ type: 'workspace.removed', workspace_id: current.id })
    return c.json({ ok: true } as const)
  })

  app.get('/api/channels', c => {
    const id = c.get('user').id
    return c.json(chat.visible(id).map(channel => chat.channelDto(channel, id)))
  })
  app.post('/api/channels', async c => {
    const { member_ids, ...input } = await body(c, channelCreateSchema)
    const id = c.get('user').id
    const row = chat.createChannel(id, input, member_ids)
    chat.notifyChannel(row.id)
    return c.json(chat.channelDto(row, id), 201)
  })
  app.post('/api/channels/dm', async c => {
    const input = await body(c, dmCreateSchema)
    const id = c.get('user').id
    const row = chat.dm(id, input.target_user_id)
    chat.notifyChannel(row.id)
    return c.json(chat.channelDto(row, id))
  })
  app.patch('/api/channels/:id', async c => {
    const { pinned_message_id, ...patch } = await body(c, channelPatchSchema)
    const user = c.get('user')
    const room = chat.manageChannel(c.req.param('id'), user)
    const updated = db.transaction(() => {
      if (patch.workspace_id) chat.workspaceRow(patch.workspace_id)
      if (Object.keys(patch).length) db.update(channels).set(patch).where(eq(channels.id, room.id)).run()
      if (pinned_message_id === null) {
        db.delete(channelPins).where(eq(channelPins.channel_id, room.id)).run()
        return chat.refreshPins(room.id)!
      }
      if (pinned_message_id) return chat.addPin(room.id, pinned_message_id, user.id, true)!
      return chat.channelRow(room.id)
    })
    chat.notifyChannel(room.id)
    return c.json(chat.channelDto(updated, user.id))
  })
  app.delete('/api/channels/:id', c => {
    const room = chat.manageChannel(c.req.param('id'), c.get('user'))
    if (room.type === 'dm') fail(400, 'INVALID_DM', 'A DM cannot be deleted')
    const members = chat.memberIds(room.id)
    removeChannels([room.id])
    for (const id of members) realtime.direct(id, { type: 'channel.removed', channel_id: room.id })
    return c.json({ ok: true } as const)
  })
  app.post('/api/channels/:id/leave', c => {
    const user = c.get('user')
    const room = chat.access(c.req.param('id'), user.id)
    if (room.type === 'dm' || room.created_by === user.id) fail(400, 'INVALID_MEMBER_CHANGE', 'This member cannot leave')
    removeMember(room, user.id)
    return c.json({ ok: true } as const)
  })
  app.patch('/api/channels/:id/preferences', async c => {
    const patch = await body(c, channelPreferenceSchema)
    const userId = c.get('user').id
    const room = chat.access(c.req.param('id'), userId)
    db.update(channelMembers).set(patch).where(and(eq(channelMembers.channel_id, room.id), eq(channelMembers.user_id, userId))).run()
    return c.json(chat.notifyViewer(room, userId))
  })
  app.post('/api/channels/read-all', c => {
    chat.readAll(c.get('user').id)
    return c.json({ ok: true } as const)
  })

  app.get('/api/channels/:id/pins', c => {
    const room = chat.access(c.req.param('id'), c.get('user').id)
    return c.json(chat.pinRows(room.id).map(row => chat.dto(row.message)))
  })
  app.post('/api/channels/:id/pins', async c => {
    const { message_id } = await body(c, pinCreateSchema)
    const user = c.get('user')
    const room = chat.manageChannel(c.req.param('id'), user)
    const updated = db.transaction(() => chat.addPin(room.id, message_id, user.id))!
    chat.notifyChannel(room.id)
    return c.json(chat.channelDto(updated, user.id))
  })
  app.delete('/api/channels/:id/pins/:messageId', c => {
    const room = chat.manageChannel(c.req.param('id'), c.get('user'))
    db.transaction(() => {
      db.delete(channelPins).where(and(eq(channelPins.channel_id, room.id), eq(channelPins.message_id, c.req.param('messageId')))).run()
      chat.refreshPins(room.id)
    })
    chat.notifyChannel(room.id)
    return c.json({ ok: true } as const)
  })
  app.post('/api/channels/:id/members', async c => {
    const ids = await body(c, addMembersSchema)
    const user = c.get('user')
    const row = chat.manageChannel(c.req.param('id'), user)
    if (row.type === 'dm') fail(400, 'INVALID_DM', 'DM membership is fixed')
    chat.addMembers(row.id, ids)
    chat.notifyChannel(row.id)
    return c.json(chat.channelDto(row, user.id))
  })
  app.delete('/api/channels/:id/members/:userId', c => {
    const user = c.get('user')
    const row = chat.manageChannel(c.req.param('id'), user)
    const target = c.req.param('userId')
    if (row.type === 'dm' || row.created_by === target) fail(400, 'INVALID_MEMBER_CHANGE', 'This member cannot be removed')
    if (chat.membership(row.id, target)) removeMember(row, target)
    return c.json({ ok: true } as const)
  })

  app.get('/api/channels/:id/members', c => {
    const room = chat.access(c.req.param('id'), c.get('user').id)
    return c.json(realtime.members(chat.memberIds(room.id)))
  })
  app.get('/api/messages/:id', c => {
    const row = chat.messageRow(c.req.param('id'))
    chat.access(row.channel_id, c.get('user').id)
    return c.json(chat.dto(row))
  })

  app.get('/api/channels/:id/messages', c => {
    const channel = chat.access(c.req.param('id'), c.get('user').id)
    const input = parse(pageMessagesSchema, c.req.query())
    if (input.around) {
      if (input.before) fail(400, 'INVALID_INPUT', 'Use around or before, not both')
      const target = chat.messageInChannel(channel.id, input.around)
      if (input.thread_root_id && target.thread_root_id !== input.thread_root_id) {
        fail(404, 'MESSAGE_NOT_FOUND', 'Message not found in this thread')
      }
      return c.json(chat.around(channel.id, target, input.limit))
    }
    chat.root(channel.id, input.thread_root_id)
    const rows = chat.listMessages(channel.id, input.thread_root_id ?? null, input.limit + 1, input.before)
    const page = rows.slice(0, input.limit)
    return c.json({ messages: page.map(chat.dto), next_before: rows.length > input.limit ? page.at(-1)!.id : null })
  })
  app.post('/api/channels/:id/messages', async c => {
    const input = await body(c, sendMessageSchema)
    const user = c.get('user')
    const result = chat.send(user, c.req.param('id'), input, undefined, user.kind === 'bot' ? engine.botPostHops(user.id) : undefined)
    engine.trigger(result.row)
    return c.json(result.message, 201)
  })
  app.post('/api/channels/:id/read', async c => {
    const input = await body(c, readAckSchema)
    chat.read(c.get('user').id, c.req.param('id'), input.last_read_message_id)
    return c.json({ ok: true } as const)
  })
  app.patch('/api/messages/:id', async c => {
    const patch = await body(c, messagePatchSchema)
    const user = c.get('user')
    const row = chat.messageRow(c.req.param('id'))
    const room = chat.access(row.channel_id, user.id)
    if (patch.board_status !== undefined) chat.validateBoardStatus(room, row.thread_root_id)
    if (patch.content !== undefined) {
      if (!user.is_admin && row.author_id !== user.id) fail(403, 'FORBIDDEN', 'Message author or administrator required')
      if (row.status === 'streaming') fail(409, 'RUN_ACTIVE', 'Abort the run before editing this message')
      if (!patch.content.trim() && !row.blocks_json.some(block => block.type === 'attachment')) {
        fail(400, 'INVALID_INPUT', 'A message or attachment is required')
      }
    }
    const updated = db.update(messages).set({ ...patch, updated_at: Date.now() }).where(eq(messages.id, row.id)).returning().get()
    const message = chat.dto(updated)
    realtime.publish({ type: 'message.updated', message }, row.channel_id)
    return c.json(message)
  })
  app.delete('/api/messages/:id', c => {
    const row = manageMessage(c.get('user'), c.req.param('id'))
    const affected = db.select().from(messages).where(or(eq(messages.id, row.id), eq(messages.thread_root_id, row.id))).all()
    const ids = affected.map(message => message.id)
    const quotes = db.select({ id: messages.id }).from(messages).where(inArray(messages.reply_to_id, ids)).all().map(message => message.id)
    engine.cancelMessages(new Set(ids))
    db.transaction(() => {
      db.delete(messages).where(eq(messages.id, row.id)).run()
      if (!row.thread_root_id) db.delete(botSessions).where(eq(botSessions.scope_key, `thread:${row.id}`)).run()
    })
    notifyDeleted(affected, quotes)
    return c.json({ ok: true } as const)
  })
  app.post('/api/messages/:id/abort', c => {
    const user = c.get('user')
    engine.abort(user.id, user.is_admin, c.req.param('id'))
    return c.json({ ok: true } as const)
  })

  app.post('/api/messages/:id/regenerate', c => c.json(engine.regenerate(c.get('user'), c.req.param('id'))))

  app.post('/api/messages/:id/respond', async c => {
    const input = await body(c, respondPromptSchema)
    return c.json(engine.respond(c.get('user'), c.req.param('id'), input))
  })

  app.post('/api/messages/:id/reactions', async c => {
    const { emoji } = await body(c, reactionToggleSchema)
    const row = chat.messageRow(c.req.param('id'))
    const user_id = c.get('user').id
    chat.access(row.channel_id, user_id)
    const summary = db.transaction(() => {
      const deleted = db.delete(reactions).where(and(eq(reactions.message_id, row.id), eq(reactions.user_id, user_id), eq(reactions.emoji, emoji))).run()
      if (!deleted.changes) db.insert(reactions).values({ message_id: row.id, user_id, emoji, created_at: Date.now() }).run()
      return chat.reactionSummary(row.id)
    }, { behavior: 'immediate' })
    realtime.publish({ type: 'message.reactions', channel_id: row.channel_id, message_id: row.id, reactions: summary }, row.channel_id)
    return c.json({ reactions: summary })
  })

  function removeMember(room: ChannelRow, target: string) {
    engine.cancelBot(target, room.id)
    db.delete(channelMembers).where(and(eq(channelMembers.channel_id, room.id), eq(channelMembers.user_id, target))).run()
    realtime.direct(target, { type: 'channel.removed', channel_id: room.id })
    chat.notifyChannel(room.id)
  }

  function removeChannels(ids: string[]) {
    if (!ids.length) return
    const affected = db.select({ id: messages.id }).from(messages).where(inArray(messages.channel_id, ids)).all()
    engine.cancelMessages(new Set(affected.map(row => row.id)))
    db.transaction(() => {
      db.delete(botSessions).where(or(inArray(botSessions.scope_key, ids.map(id => `channel:${id}`)), sql`
        ${botSessions.scope_key} IN (SELECT 'thread:' || id FROM messages
          WHERE ${inArray(sql`channel_id`, ids)} AND thread_root_id IS NULL)
      `)).run()
      db.delete(channels).where(inArray(channels.id, ids)).run()
    })
  }

  function notifyDeleted(rows: MessageRow[], quotes: string[] = []) {
    const removed = new Set(rows.map(row => row.id))
    const roots = new Map<string, string>()
    const rooms = new Set<string>()
    for (const row of rows) {
      realtime.publish({ type: 'message.deleted', channel_id: row.channel_id, message_id: row.id }, row.channel_id)
      if (row.thread_root_id && !removed.has(row.thread_root_id)) roots.set(row.thread_root_id, row.channel_id)
      rooms.add(row.channel_id)
    }
    for (const id of quotes) if (!removed.has(id) && !roots.has(id)) {
      const row = db.select().from(messages).where(eq(messages.id, id)).get()
      if (row) roots.set(id, row.channel_id)
    }
    for (const [id, channelId] of roots) realtime.publish({ type: 'message.updated', message: chat.dto(chat.messageRow(id)) }, channelId)
    for (const channelId of rooms) {
      chat.refreshPins(channelId)
      chat.notifyChannel(channelId)
    }
  }

  return { notifyDeleted, removeChannels }
}
