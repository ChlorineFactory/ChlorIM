import { and, eq, inArray, sql } from 'drizzle-orm'
import { idSchema, slashCommandSchema } from '@chiorim/shared'
import type { App, Services } from './app.js'
import { bots, messages } from './db.js'
import { body, fail, parse } from './errors.js'

const scope = (id: string, thread?: string | null) => thread ? `thread:${thread}` : `channel:${id}`

export function registerCommands(app: App, { db, chat, engine, realtime }: Services) {
  app.delete('/api/bots/:id/sessions', c => {
    const bot = db.select().from(bots).where(eq(bots.user_id, c.req.param('id'))).get()
    if (!bot) fail(404, 'BOT_NOT_FOUND', 'Bot not found')
    const actor = c.get('user')
    const thread = c.req.query('thread_root_id')
    const room = c.req.query('channel_id')
    if (room !== undefined) parse(idSchema, room)
    const id = thread === undefined ? room : chat.messageRow(parse(idSchema, thread)).channel_id
    if (id) {
      if (room && room !== id) fail(404, 'THREAD_NOT_FOUND', 'Thread not found in this channel')
      if (!actor.is_admin) chat.access(id, actor.id)
      chat.root(id, thread)
      if (!chat.membership(id, bot.user_id)) fail(404, 'BOT_NOT_FOUND', 'Bot is not a member of this channel')
      return c.json({ ok: true as const, cleared: engine.resetSessions(bot.user_id, [scope(id, thread)]) })
    }
    if (actor.is_admin) return c.json({ ok: true as const, cleared: engine.resetSessions(bot.user_id) })
    const shared = chat.visible(actor.id).filter(channel => chat.membership(channel.id, bot.user_id)).map(channel => channel.id)
    if (!shared.length) fail(403, 'FORBIDDEN', 'The Bot shares no channels with this user')
    const scopes = db.select({ id: messages.id }).from(messages)
      .where(and(inArray(messages.channel_id, shared), sql`${messages.thread_root_id} IS NULL`)).all()
      .map(row => `thread:${row.id}`)
    return c.json({ ok: true as const, cleared: engine.resetSessions(bot.user_id, [...shared.map(id => `channel:${id}`), ...scopes]) })
  })

  app.post('/api/channels/:id/command', async c => {
    const { command, thread_root_id } = await body(c, slashCommandSchema)
    const actor = c.get('user')
    const room = chat.access(c.req.param('id'), actor.id)
    chat.root(room.id, thread_root_id)
    const [prefix, ...rest] = command.split(/\s+/)
    const candidates = chat.memberBots(room.id)
    function botAt(value: string) {
      const username = /^@([a-z0-9_-]{2,32})$/i.exec(value)?.[1].toLowerCase()
      if (!username) fail(400, 'INVALID_COMMAND', 'Use @username to select a Bot')
      const found = candidates.find(row => row.user.username === username)
      if (!found) fail(404, 'BOT_NOT_FOUND', 'No matching Bot in this channel')
      return found
    }

    if (prefix === '/status' && !rest.length) {
      const lines = candidates.map(({ bot, user }) => {
        const online = realtime.online(user.id)
        const runtime = online && bot.mode === 'bridge' ? realtime.runtime(user.id) : undefined
        const detail = bot.mode === 'provider' ? bot.model : runtime && [runtime.driver, runtime.cwd].filter(Boolean).join(' · ')
        return `@${user.username} ${online ? 'online' : 'offline'}${detail ? ' — ' + detail : ''}`
      })
      return c.json({ ok: true as const, message: lines.join('\n') || 'No Bots in this channel' })
    }
    if (prefix === '/reset' && rest.length <= 1) {
      const targets = rest.length ? [botAt(rest[0])] : candidates
      const key = scope(room.id, thread_root_id)
      const cleared = targets.reduce((count, { bot }) => count + engine.resetSessions(bot.user_id, [key]), 0)
      return c.json({ ok: true as const, message: `Cleared ${cleared} Bot sessions` })
    }
    if (prefix === '/model' && rest.length === 2) {
      const { bot, user } = botAt(rest[0])
      if (actor.id !== bot.owner_id && !actor.is_admin) fail(403, 'FORBIDDEN', 'Bot owner or administrator required')
      if (bot.mode !== 'provider' || rest[1].length > 256) fail(400, 'INVALID_MODEL', 'A Provider Bot and a valid model are required')
      db.update(bots).set({ model: rest[1] }).where(eq(bots.user_id, user.id)).run()
      realtime.memberUpdated(user.id)
      return c.json({ ok: true as const, message: `@${user.username} now uses ${rest[1]}` })
    }
    if (prefix === '/ask') {
      const tail = command.slice(prefix.length).trimStart()
      const targets = /^((?:@[a-z0-9_-]{2,32}\s+)+)(\S[\s\S]*)$/i.exec(tail)
      if (!targets || /^(?:@[a-z0-9_-]{2,32}\s*)+$/i.test(targets[2])) fail(400, 'INVALID_COMMAND', 'Use /ask @bot <question>')
      const selected = targets[1].trim().split(/\s+/).map(botAt)
      if (selected.some(({ user }) => user.disabled)) fail(400, 'BOT_DISABLED', 'A selected Bot is disabled')
      const { row, message } = chat.send(actor, room.id, { content: tail, thread_root_id })
      engine.trigger(row, new Set(selected.map(({ user }) => user.id)))
      return c.json({ ok: true as const, message: 'Question sent', created_message: message })
    }
    fail(400, 'INVALID_COMMAND', 'Use /reset, /model, /ask or /status')
  })
}
