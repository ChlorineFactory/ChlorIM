import { randomUUID } from 'node:crypto'
import { eq, inArray, or } from 'drizzle-orm'
import { botCreateSchema, botPatchSchema, providerCreateSchema, providerPatchSchema } from '@chiorim/shared'
import type { Bot, Provider, User } from '@chiorim/shared'
import { adminOnly } from './auth.js'
import { publicUser } from './chat.js'
import { bots, botSessions, channelMembers, channels, messages, providers, users } from './db.js'
import type { BotRow, ProviderRow } from './db.js'
import { body, fail } from './errors.js'
import { providerError, testProvider } from './providers.js'
import { randomHex, sha256 } from './security.js'
import type { App, Services } from './app.js'
import type { registerChat } from './chat-routes.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export function registerManagement(app: App, services: Services, chatRoutes: ReturnType<typeof registerChat>) {
  const { db, chat, engine, realtime, secret, bridgePublicUrl } = services

  function providerRow(id: string) {
    const row = db.select().from(providers).where(eq(providers.id, id)).get()
    if (!row) fail(404, 'PROVIDER_NOT_FOUND', 'Provider not found')
    return row
  }

  const providerDto = ({ api_key_enc, models_json, ...row }: ProviderRow): Provider => ({
    ...row, models: models_json, api_key_masked: api_key_enc ? '••••••••' : null, has_api_key: Boolean(api_key_enc),
  })

  app.get('/api/providers', c => c.json(db.select().from(providers).orderBy(providers.name).all().map(providerDto)))
  app.post('/api/providers', async c => {
    const { api_key, models, ...input } = await body(c, providerCreateSchema)
    adminOnly(c.get('user'))
    const row = db.insert(providers).values({
      ...input, models_json: models, api_key_enc: secret.encrypt(api_key), id: randomUUID(),
      created_by: c.get('user').id, created_at: Date.now(),
    }).returning().get()
    return c.json(providerDto(row), 201)
  })
  app.patch('/api/providers/:id', async c => {
    const { api_key, models, ...input } = await body(c, providerPatchSchema)
    adminOnly(c.get('user'))
    const current = providerRow(c.req.param('id'))
    const patch = {
      ...input, ...(api_key !== undefined ? { api_key_enc: secret.encrypt(api_key) } : {}),
      ...(models !== undefined ? { models_json: models } : {}),
    }
    const updated = Object.keys(patch).length
      ? db.update(providers).set(patch).where(eq(providers.id, current.id)).returning().get() : current
    return c.json(providerDto(updated))
  })
  app.delete('/api/providers/:id', c => {
    adminOnly(c.get('user'))
    const id = c.req.param('id')
    const using = db.select({ id: bots.user_id }).from(bots).where(eq(bots.provider_id, id)).all()
    db.delete(providers).where(eq(providers.id, id)).run()
    for (const bot of using) {
      engine.cancelBot(bot.id)
      realtime.memberUpdated(bot.id)
    }
    return c.json({ ok: true } as const)
  })
  app.post('/api/providers/:id/test', async c => {
    adminOnly(c.get('user'))
    const row = providerRow(c.req.param('id'))
    try { return c.json({ ok: true as const, models: await testProvider(row, secret.decrypt(row.api_key_enc)) }) }
    catch (error) { return fail(502, 'PROVIDER_UNAVAILABLE', providerError(error)) }
  })

  function botDto({ token_hash: _, runtime_meta_json: __, ...bot }: BotRow): Bot {
    const user = db.select().from(users).where(eq(users.id, bot.user_id)).get()!
    return { ...bot, user: publicUser(user), online: realtime.online(user.id), runtime_meta: realtime.runtime(user.id) ?? null }
  }

  function manageBot(id: string, user: User) {
    const bot = db.select().from(bots).where(eq(bots.user_id, id)).get()
    if (!bot) fail(404, 'BOT_NOT_FOUND', 'Bot not found')
    if (!user.is_admin && user.id !== bot.owner_id) fail(403, 'FORBIDDEN', 'Bot owner or administrator required')
    return bot
  }

  function credentials(url: string, token: string, driver: BotRow['driver_hint'], username: string) {
    const origin = bridgePublicUrl ?? new URL(url).origin.replace(/^http/, 'ws')
    return { bot_token: token, connect_command: `chior-bridge add --url ${quote(origin)} --token ${quote(token)} --driver ${quote(driver ?? 'codex')} --name ${quote(username)}` }
  }

  app.get('/api/bots', c => c.json(db.select().from(bots).orderBy(bots.created_at).all().map(botDto)))
  app.post('/api/bots', async c => {
    const { display_name, username, avatar_url, bio, channel_ids, disabled, ...input } = await body(c, botCreateSchema)
    const owner = c.get('user')
    const token = input.mode === 'bridge' ? `chior_bot_${randomHex()}` : undefined
    const { bot, joined } = db.transaction(() => {
      if (input.mode === 'provider' && (!input.provider_id || !input.model)) {
        fail(400, 'INVALID_BOT', 'A provider bot requires provider_id and model')
      }
      if (input.provider_id) providerRow(input.provider_id)
      if (db.select().from(users).where(eq(users.username, username)).get()) fail(409, 'USERNAME_TAKEN', 'Username is already in use')
      const joined = channel_ids ?? db.select({ id: channels.id }).from(channels).where(eq(channels.type, 'public')).all().map(row => row.id)
      for (const id of joined) {
        if (chat.access(id, owner.id).type === 'dm') fail(400, 'INVALID_DM', 'DM membership is fixed')
      }
      const id = randomUUID()
      const now = Date.now()
      db.insert(users).values({ id, kind: 'bot', username, display_name, avatar_url, bio, disabled, created_at: now }).run()
      const bot = db.insert(bots).values({
        ...input, user_id: id, owner_id: owner.id, token_hash: token ? sha256(token) : null, created_at: now,
      }).returning().get()
      for (const room of joined) chat.addMembers(room, [id])
      return { bot, joined }
    }, { behavior: 'immediate' })
    realtime.memberUpdated(bot.user_id)
    for (const id of new Set(joined)) chat.notifyChannel(id)
    if (token) c.header('Cache-Control', 'no-store')
    return c.json({ ...botDto(bot), ...(token ? credentials(c.req.url, token, bot.driver_hint, username) : {}) }, 201)
  })
  app.patch('/api/bots/:id', async c => {
    const { avatar_url, display_name, bio, disabled, ...settings } = await body(c, botPatchSchema)
    const bot = manageBot(c.req.param('id'), c.get('user'))
    if (settings.provider_id) providerRow(settings.provider_id)
    const profile = Object.fromEntries(Object.entries({ avatar_url, display_name, bio, disabled }).filter(([, value]) => value !== undefined))
    const updated = db.transaction(() => {
      if (Object.keys(profile).length) db.update(users).set(profile).where(eq(users.id, bot.user_id)).run()
      return Object.keys(settings).length
        ? db.update(bots).set(settings).where(eq(bots.user_id, bot.user_id)).returning().get() : bot
    })
    if (disabled === true) {
      engine.cancelBot(bot.user_id)
      realtime.closeBridge(bot.user_id, 'Bot was disabled')
    }
    realtime.memberUpdated(bot.user_id)
    return c.json(botDto(updated))
  })
  app.post('/api/bots/:id/rotate-token', c => {
    const bot = manageBot(c.req.param('id'), c.get('user'))
    if (bot.mode !== 'bridge') fail(400, 'INVALID_BOT', 'This bot does not use Bridge tokens')
    const token = `chior_bot_${randomHex()}`
    db.update(bots).set({ token_hash: sha256(token), runtime_meta_json: null }).where(eq(bots.user_id, bot.user_id)).run()
    engine.cancelBot(bot.user_id)
    realtime.closeBridge(bot.user_id, 'Bridge credentials changed')
    c.header('Cache-Control', 'no-store')
    return c.json(credentials(c.req.url, token, bot.driver_hint, botDto(bot).user.username))
  })
  app.delete('/api/bots/:id', c => {
    const bot = manageBot(c.req.param('id'), c.get('user'))
    const purge = c.req.query('purge') === 'true'
    const joined = chat.visible(bot.user_id)
    const dms = joined.filter(room => room.type === 'dm').map(room => ({ id: room.id, members: chat.memberIds(room.id) }))
    const dmIds = new Set(dms.map(room => room.id))
    const authored = purge ? db.select().from(messages).where(eq(messages.author_id, bot.user_id)).all() : []
    const roots = authored.filter(row => !row.thread_root_id).map(row => row.id)
    const affected = purge ? db.select().from(messages).where(or(
      eq(messages.author_id, bot.user_id), inArray(messages.thread_root_id, roots),
    )).all().filter(row => !dmIds.has(row.channel_id)) : []
    const quotes = affected.length ? db.select({ id: messages.id }).from(messages)
      .where(inArray(messages.reply_to_id, affected.map(row => row.id))).all().map(row => row.id) : []
    engine.cancelMessages(new Set(affected.map(row => row.id)))
    engine.cancelBot(bot.user_id)
    realtime.closeBridge(bot.user_id, 'Bot was deleted')
    db.transaction(() => {
      chatRoutes.removeChannels([...dmIds])
      if (purge) {
        db.delete(botSessions).where(inArray(botSessions.scope_key, roots.map(id => `thread:${id}`))).run()
        db.delete(messages).where(eq(messages.author_id, bot.user_id)).run()
        db.delete(users).where(eq(users.id, bot.user_id)).run()
      } else {
        db.delete(bots).where(eq(bots.user_id, bot.user_id)).run()
        db.delete(channelMembers).where(eq(channelMembers.user_id, bot.user_id)).run()
        db.update(users).set({ disabled: true }).where(eq(users.id, bot.user_id)).run()
      }
    })
    realtime.publish({ type: 'member.removed', user_id: bot.user_id })
    chatRoutes.notifyDeleted(affected, quotes)
    for (const room of joined) if (room.type !== 'dm') chat.notifyChannel(room.id)
    for (const dm of dms) for (const id of dm.members) realtime.direct(id, { type: 'channel.removed', channel_id: dm.id })
    return c.json({ ok: true } as const)
  })
}
