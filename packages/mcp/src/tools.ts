import {
  apiErrorSchema, channelCreateSchema, channelListSchema, channelSchema, idSchema, memberListSchema,
  messagePageSchema, messagePatchSchema, messageSchema, pageMessagesSchema, reactionToggleResponseSchema,
  reactionToggleSchema, searchHitListSchema, searchQuerySchema, sendMessageSchema, workspaceListSchema,
} from '@chiorim/shared'

const id = { type: 'string', minLength: 1, maxLength: 128 }
const limit = { type: 'integer', minimum: 1, maximum: 100 }
const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
})

export const tools = [
  { name: 'list_workspaces', description: 'List ChiorIM folder workspaces.', inputSchema: object({}) },
  { name: 'list_channels', description: 'List visible ChiorIM channels.', inputSchema: object({}) },
  {
    name: 'create_channel',
    description: 'Create a new public, private, or board channel (optionally inside a folder workspace with a sub-directory).',
    inputSchema: object({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      type: { type: 'string', enum: ['public', 'private', 'board'] },
      workspace_id: id,
      topic: { type: 'string', maxLength: 1000 },
      work_dir: { type: 'string', maxLength: 4096 },
      system_context: { type: 'string', maxLength: 16_000 },
    }, ['name']),
  },
  { name: 'read_messages', description: 'Read the latest messages in a channel or thread.',
    inputSchema: object({ channel_id: id, limit, thread_root_id: id }, ['channel_id']) },
  { name: 'post_message', description: 'Post a message in a channel or thread, optionally quoting a message.',
    inputSchema: object({ channel_id: id, content: { type: 'string', minLength: 1, maxLength: 60_000 },
      thread_root_id: id, reply_to_id: id }, ['channel_id', 'content']) },
  {
    name: 'edit_message',
    description: 'Edit one of your messages or update a board post status (open/done).',
    inputSchema: object({
      message_id: id,
      content: { type: 'string', maxLength: 60_000 },
      board_status: { type: 'string', enum: ['open', 'done'] },
    }, ['message_id']),
  },
  {
    name: 'react_message',
    description: 'Toggle an emoji reaction (e.g. 👍, 👀, ✅, 🔥) on a message.',
    inputSchema: object({ message_id: id, emoji: { type: 'string', minLength: 1, maxLength: 32 } }, ['message_id', 'emoji']),
  },
  { name: 'search_messages', description: 'Search conversations that this token can access.',
    inputSchema: object({ q: { type: 'string', maxLength: 200 }, channel_id: id, limit }, ['q']) },
  { name: 'list_members', description: 'List members visible to the token, optionally scoped to a channel.',
    inputSchema: object({ channel_id: id }) },
] as const

export type ToolName = typeof tools[number]['name']

export function createTools(env: NodeJS.ProcessEnv) {
  async function request<T>(
    path: string, schema: { parse(data: unknown): T }, payload?: unknown, method?: 'GET' | 'POST' | 'PATCH',
  ) {
    const token = env.CHIORIM_TOKEN
    if (!token || !/^(?:chior_bot_)?[a-f0-9]{64}$/.test(token)) throw new Error('Set CHIORIM_TOKEN to a ChiorIM session or Bot token')
    const url = new URL(env.CHIORIM_URL ?? 'http://127.0.0.1:3000')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('CHIORIM_URL must be an HTTP(S) base URL')
    }
    const verb = method ?? (payload === undefined ? 'GET' : 'POST')
    const result = await fetch(url.href.replace(/\/+$/, '') + '/api' + path, {
      method: verb, redirect: 'error', signal: AbortSignal.timeout(15_000),
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

  function safeId(raw: unknown, label: string) {
    const value = idSchema.parse(raw)
    if (value === '.' || value === '..') throw new Error(`Invalid ${label}`)
    return encodeURIComponent(value)
  }

  return async function call(name: ToolName, args: Record<string, unknown>) {
    switch (name) {
      case 'list_workspaces':
        return { workspaces: await request('/workspaces', workspaceListSchema) }
      case 'list_channels':
        return { channels: await request('/channels', channelListSchema) }
      case 'create_channel': {
        const input = channelCreateSchema.parse({
          type: args.type ?? 'public',
          name: args.name,
          workspace_id: args.workspace_id,
          topic: args.topic ?? '',
          work_dir: args.work_dir ?? null,
          system_context: args.system_context ?? '',
        })
        return { channel: await request('/channels', channelSchema, input, 'POST') }
      }
      case 'read_messages': {
        const input = pageMessagesSchema.parse({ limit: args.limit, thread_root_id: args.thread_root_id })
        const query = new URLSearchParams({ limit: String(input.limit) })
        if (input.thread_root_id) query.set('thread_root_id', input.thread_root_id)
        return request(`/channels/${safeId(args.channel_id, 'channel ID')}/messages?${query}`, messagePageSchema)
      }
      case 'post_message': {
        const input = sendMessageSchema.parse({ content: args.content, thread_root_id: args.thread_root_id, reply_to_id: args.reply_to_id })
        return { message: await request(`/channels/${safeId(args.channel_id, 'channel ID')}/messages`, messageSchema, input, 'POST') }
      }
      case 'edit_message': {
        const input = messagePatchSchema.parse({ content: args.content, board_status: args.board_status })
        return { message: await request(`/messages/${safeId(args.message_id, 'message ID')}`, messageSchema, input, 'PATCH') }
      }
      case 'react_message': {
        const input = reactionToggleSchema.parse({ emoji: args.emoji })
        return request(`/messages/${safeId(args.message_id, 'message ID')}/reactions`, reactionToggleResponseSchema, input, 'POST')
      }
      case 'search_messages': {
        if (typeof args.q !== 'string') throw new Error('q must be a string')
        const input = searchQuerySchema.parse({ q: args.q, channel_id: args.channel_id, limit: args.limit })
        const query = new URLSearchParams({ q: input.q, limit: String(input.limit) })
        if (input.channel_id) query.set('channel_id', input.channel_id)
        return { hits: await request('/search?' + query, searchHitListSchema) }
      }
      case 'list_members':
        return { members: await request(args.channel_id === undefined ? '/users' : `/channels/${safeId(args.channel_id, 'channel ID')}/members`, memberListSchema) }
    }
  }
}
