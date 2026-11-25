import { and, desc, eq, sql } from 'drizzle-orm'
import { bookmarkCreateSchema, searchQuerySchema } from '@chiorim/shared'
import type { App, Services } from './app.js'
import { bookmarks, channelMembers, channels, messages } from './db.js'
import { body, fail, parse } from './errors.js'

export function registerDiscovery(app: App, { chat, db }: Services) {
  function accessMessage(id: string, userId: string) {
    const message = chat.messageRow(id)
    chat.access(message.channel_id, userId)
    return message
  }

  app.get('/api/search', c => {
    const input = parse(searchQuerySchema, c.req.query())
    const userId = c.get('user').id
    if (input.channel_id) chat.access(input.channel_id, userId)
    const query = '%' + input.q.replace(/[\\%_]/g, '\\$&') + '%'
    const hasAttachments = sql`exists(select 1 from json_each(${messages.blocks_json}) as b where json_extract(b.value, '$.type') = 'attachment')`
    const rows = db.select({ message: messages, channel_name: channels.name, channel_type: channels.type })
      .from(messages).innerJoin(channels, eq(channels.id, messages.channel_id))
      .innerJoin(channelMembers, and(eq(channelMembers.channel_id, channels.id), eq(channelMembers.user_id, userId)))
      .where(and(input.q ? sql`${messages.content} LIKE ${query} ESCAPE '\\'` : undefined,
        input.channel_id ? eq(channels.id, input.channel_id) : undefined,
        input.author_id ? eq(messages.author_id, input.author_id) : undefined,
        input.has_attachments === undefined ? undefined : input.has_attachments ? hasAttachments : sql`not ${hasAttachments}`))
      .orderBy(desc(messages.created_at), desc(messages.id)).limit(input.limit).all()
    return c.json(rows.map(({ message, ...channel }) => ({ ...chat.dto(message), ...channel })))
  })

  app.get('/api/channels/:id/files', c => {
    const room = chat.access(c.req.param('id'), c.get('user').id)
    const rows = db.select().from(messages).where(and(eq(messages.channel_id, room.id), sql`
      exists(select 1 from json_each(${messages.blocks_json}) as b where json_extract(b.value, '$.type') = 'attachment')
    `)).orderBy(desc(messages.created_at), desc(messages.id)).all()
    return c.json(rows.flatMap(row => {
      const message = chat.dto(row)
      return message.blocks.flatMap(block => {
        if (block.type !== 'attachment') return []
        const { type: _, ...attachment } = block
        return [{ message_id: row.id, author: message.author, created_at: row.created_at, attachment }]
      })
    }))
  })

  app.get('/api/bookmarks', c => {
    const userId = c.get('user').id
    const rows = db.select({ message: messages, note: bookmarks.note, created_at: bookmarks.created_at })
      .from(bookmarks).innerJoin(messages, eq(messages.id, bookmarks.message_id))
      .innerJoin(channelMembers, and(eq(channelMembers.channel_id, messages.channel_id), eq(channelMembers.user_id, userId)))
      .where(eq(bookmarks.user_id, userId)).orderBy(desc(bookmarks.created_at), desc(messages.id)).all()
    return c.json(rows.map(({ message, ...bookmark }) => ({ ...bookmark, message: chat.dto(message) })))
  })

  app.post('/api/bookmarks', async c => {
    const input = await body(c, bookmarkCreateSchema)
    const user_id = c.get('user').id
    const message = accessMessage(input.message_id, user_id)
    const values = { ...input, user_id, created_at: Date.now() }
    const row = db.insert(bookmarks).values(values).onConflictDoUpdate({
      target: [bookmarks.user_id, bookmarks.message_id], set: { note: input.note },
    }).returning().get()
    return c.json({ message: chat.dto(message), note: row.note, created_at: row.created_at })
  })

  app.delete('/api/bookmarks/:messageId', c => {
    const id = c.req.param('messageId')
    if (!id) fail(400, 'INVALID_INPUT', 'Message ID is required')
    db.delete(bookmarks).where(and(eq(bookmarks.message_id, id), eq(bookmarks.user_id, c.get('user').id))).run()
    return c.json({ ok: true } as const)
  })
}
