import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { webhookCreateSchema, webhookIncomingSchema } from '@chiorim/shared'
import type { Webhook } from '@chiorim/shared'
import type { App, Services } from './app.js'
import { users, webhooks } from './db.js'
import type { WebhookRow } from './db.js'
import { body, fail } from './errors.js'
import { randomHex, sha256 } from './security.js'

const dto = ({ token_hash: _, ...row }: WebhookRow): Webhook => row

export function registerWebhooks(app: App, { chat, db, engine, limits }: Services) {
  app.get('/api/channels/:id/webhooks', c => {
    const channel = chat.manageChannel(c.req.param('id'), c.get('user'))
    return c.json(db.select().from(webhooks).where(eq(webhooks.channel_id, channel.id)).orderBy(webhooks.created_at).all().map(dto))
  })

  app.post('/api/channels/:id/webhooks', async c => {
    const input = await body(c, webhookCreateSchema)
    const user = c.get('user')
    const channel = chat.manageChannel(c.req.param('id'), user)
    const token = `chior_wh_${randomHex()}`
    const row = db.insert(webhooks).values({ ...input, id: randomUUID(), channel_id: channel.id,
      token_hash: sha256(token), created_by: user.id, created_at: Date.now() }).returning().get()
    return c.json({ ...dto(row), token, url: '/api/webhooks/in/' + token }, 201)
  })

  app.delete('/api/webhooks/:id', c => {
    const row = db.select().from(webhooks).where(eq(webhooks.id, c.req.param('id'))).get()
    if (!row) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found')
    chat.manageChannel(row.channel_id, c.get('user'))
    db.delete(webhooks).where(eq(webhooks.id, row.id)).run()
    return c.json({ ok: true } as const)
  })

  app.post('/api/webhooks/in/:token', async c => {
    const token = c.req.param('token')
    if (!/^chior_wh_[a-f0-9]{64}$/.test(token)) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found')
    const hash = sha256(token)
    const row = db.select().from(webhooks).where(eq(webhooks.token_hash, hash)).get()
    if (!row) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found')
    limits.webhook(c, row.id)
    const input = await body(c, webhookIncomingSchema)
    const current = db.select({ webhook: webhooks, disabled: users.disabled }).from(webhooks)
      .innerJoin(users, eq(users.id, webhooks.created_by)).where(eq(webhooks.token_hash, hash)).get()
    if (!current || current.disabled) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found')
    const channel = chat.channelRow(current.webhook.channel_id)
    const message = chat.insert({ channel_id: channel.id, author_id: current.webhook.created_by, content: input.content,
      webhook_name: input.username ?? current.webhook.name, board_status: channel.type === 'board' ? 'open' : null })
    const result = chat.created(message)
    if (input.trigger_bots) engine.trigger(message)
    return c.json(result, 201)
  })
}
