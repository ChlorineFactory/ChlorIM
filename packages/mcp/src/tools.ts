import {
  apiErrorSchema, channelListSchema, idSchema, memberListSchema, messagePageSchema,
  messageSchema, pageMessagesSchema, searchHitListSchema, searchQuerySchema, sendMessageSchema,
} from '@chiorim/shared'

const id = { type: 'string', minLength: 1, maxLength: 128 }
const limit = { type: 'integer', minimum: 1, maximum: 100 }
const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
})

export const tools = [
  { name: 'list_channels', description: 'List visible ChiorIM channels.', inputSchema: object({}) },
  { name: 'read_messages', description: 'Read the latest messages in a channel or thread.',
    inputSchema: object({ channel_id: id, limit, thread_root_id: id }, ['channel_id']) },
  { name: 'post_message', description: 'Post a message in a channel or thread, optionally quoting a message.',
    inputSchema: object({ channel_id: id, content: { type: 'string', minLength: 1, maxLength: 60_000 },
      thread_root_id: id, reply_to_id: id }, ['channel_id', 'content']) },
  { name: 'search_messages', description: 'Search conversations that this token can access.',
    inputSchema: object({ q: { type: 'string', maxLength: 200 }, channel_id: id, limit }, ['q']) },
  { name: 'list_members', description: 'List members visible to the token, optionally scoped to a channel.',
    inputSchema: object({ channel_id: id }) },
] as const

export type ToolName = typeof tools[number]['name']

export function createTools(env: NodeJS.ProcessEnv) {
  async function request<T>(path: string, schema: { parse(data: unknown): T }, payload?: unknown) {
    const token = env.CHIORIM_TOKEN
    if (!token || !/^(?:chior_bot_)?[a-f0-9]{64}$/.test(token)) throw new Error('Set CHIORIM_TOKEN to a ChiorIM session or Bot token')
    const url = new URL(env.CHIORIM_URL ?? 'http://127.0.0.1:3000')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('CHIORIM_URL must be an HTTP(S) base URL')
    }
    const result = await fetch(url.href.replace(/\/+$/, '') + '/api' + path, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Bearer ' + token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const data: unknown = await result.json().catch(() => null)
    if (!result.ok) {
      const parsed = apiErrorSchema.safeParse(data)
      throw new Error(parsed.success ? `ChiorIM ${result.status}: ${parsed.data.error.message}` : `ChiorIM HTTP ${result.status}`)
    }
    return schema.parse(data)
  }

  function channelId(args: Record<string, unknown>) {
    const id = idSchema.parse(args.channel_id)
    if (id === '.' || id === '..') throw new Error('Invalid channel ID')
    return encodeURIComponent(id)
  }

  return async function call(name: ToolName, args: Record<string, unknown>) {
    switch (name) {
      case 'list_channels':
        return { channels: await request('/channels', channelListSchema) }
      case 'read_messages': {
        const input = pageMessagesSchema.parse({ limit: args.limit, thread_root_id: args.thread_root_id })
        const query = new URLSearchParams({ limit: String(input.limit) })
        if (input.thread_root_id) query.set('thread_root_id', input.thread_root_id)
        return request(`/channels/${channelId(args)}/messages?${query}`, messagePageSchema)
      }
      case 'post_message': {
        const input = sendMessageSchema.parse({ content: args.content, thread_root_id: args.thread_root_id, reply_to_id: args.reply_to_id })
        return { message: await request(`/channels/${channelId(args)}/messages`, messageSchema, input) }
      }
      case 'search_messages': {
        if (typeof args.q !== 'string') throw new Error('q must be a string')
        const input = searchQuerySchema.parse({ q: args.q, channel_id: args.channel_id, limit: args.limit })
        const query = new URLSearchParams({ q: input.q, limit: String(input.limit) })
        if (input.channel_id) query.set('channel_id', input.channel_id)
        return { hits: await request('/search?' + query, searchHitListSchema) }
      }
      case 'list_members':
        return { members: await request(args.channel_id === undefined ? '/users' : `/channels/${channelId(args)}/members`, memberListSchema) }
    }
  }
}
