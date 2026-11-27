import {
  apiErrorSchema, attachmentSchema, bookmarkListSchema, bookmarkSchema, bridgeDeviceListSchema,
  bridgeFsListSchema, channelFileListSchema, clearedSessionsResponseSchema, fsActionResultSchema, localAgentStatusSchema, messagePageSchema,
  messageSchema, okResponseSchema, pinListSchema, reactionToggleResponseSchema, searchHitListSchema,
  sessionListSchema, sessionResponseSchema, slashCommandResponseSchema, webhookCreatedSchema, webhookListSchema,
} from '@chiorim/shared'
import type {
  Attachment, Bookmark, BridgeDevice, BridgeFsList, ChannelFile, CreatedWebhook, LocalAgentStatus, Message,
  ReactionSummary, SearchHit, SendMessageRequest, SessionInfo, SessionResponse, SlashCommandResponse, Webhook,
} from '@chiorim/shared'
import { ZodError } from 'zod'
import type { ZodType, ZodTypeDef } from 'zod'

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

const errors: Record<string, string> = {
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  ACCOUNT_DISABLED: '该账号已被停用，请联系管理员。',
  INVALID_CREDENTIALS: '用户名或密码有误。',
  INVALID_INVITE: '邀请码无效、已过期或已用完。',
  USERNAME_TAKEN: '该用户名已被使用。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
  UNSUPPORTED_MEDIA_TYPE: '不支持此文件类型。',
  FILE_TOO_LARGE: '文件超过上传大小限制。',
  REQUEST_TOO_LARGE: '请求超过大小限制。',
  FORBIDDEN: '权限不足，无法执行此操作。',
  BOT_DISABLED: '该 Bot 已停用。',
  LOCAL_AGENT_DISABLED: '当前服务器已关闭本机直连 Agent，请改用远程设备 Bridge 或联系管理员开启。',
}

const fieldNames: Record<string, string> = {
  avatar_url: '头像', base_url: 'Base URL', bio: '简介', display_name: '显示名称',
  name: '名称', username: '用户名', password: '密码', current_password: '当前密码',
  new_password: '新密码', temperature: 'Temperature', context_limit: '上下文条数',
  content: '消息', expires_at: '过期时间', models: '模型列表', status_text: '状态签名',
  system_context: '频道共享上下文',
}

export function errorText(error: unknown) {
  if (error instanceof ZodError) {
    const field = fieldNames[String(error.issues[0]?.path[0])]
    return field ? `请检查${field}的格式或长度。` : '请检查填写的内容。'
  }
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return '无法连接到服务器，请重试。'
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

export async function api<T>(
  path: string, schema: ZodType<T, ZodTypeDef, unknown>, method = 'GET', payload?: unknown, signal?: AbortSignal,
): Promise<T> {
  const multipart = payload instanceof FormData
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin', signal,
    headers: payload !== undefined && !multipart ? { 'Content-Type': 'application/json' } : undefined,
    body: multipart ? payload : payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(data)
    if (!parsed.success) throw new ApiFailure(response.status, `请求失败（${response.status}）`)
    const { code, message } = parsed.data.error
    throw new ApiFailure(response.status, errors[code] ?? message, code)
  }
  return schema.parse(data)
}

export const getSession = (signal?: AbortSignal): Promise<SessionResponse> =>
  api('/auth/session', sessionResponseSchema, 'GET', undefined, signal)

export function upload(file: File): Promise<Attachment> {
  const body = new FormData()
  body.append('file', file)
  return api('/uploads', attachmentSchema, 'POST', body)
}

export function messages(
  channel: string,
  options: { thread?: string | null; before?: string | null; around?: string | null; limit?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (options.thread) query.set('thread_root_id', options.thread)
  if (options.around) query.set('around', options.around)
  else if (options.before) query.set('before', options.before)
  if (options.limit) query.set('limit', String(options.limit))
  return api(`/channels/${channel}/messages?${query}`, messagePageSchema, 'GET', undefined, signal)
}

export const sendMessage = (channel: string, payload: SendMessageRequest, signal?: AbortSignal) =>
  api(`/channels/${channel}/messages`, messageSchema, 'POST', payload, signal)

export const remove = (path: string) => api(path, okResponseSchema, 'DELETE')

export const toggleReaction = (messageId: string, emoji: string): Promise<{ reactions: ReactionSummary[] }> =>
  api(`/messages/${messageId}/reactions`, reactionToggleResponseSchema, 'POST', { emoji })

export const regenerateMessage = (messageId: string): Promise<Message> =>
  api(`/messages/${messageId}/regenerate`, messageSchema, 'POST')

export const respondPrompt = (messageId: string, payload: { prompt_id?: string; value: string; label?: string }): Promise<Message> =>
  api(`/messages/${messageId}/respond`, messageSchema, 'POST', payload)

export const clearBotSessions = (botId: string, scope?: { channel_id?: string; thread_root_id?: string }) => {
  const query = new URLSearchParams()
  if (scope?.channel_id) query.set('channel_id', scope.channel_id)
  if (scope?.thread_root_id) query.set('thread_root_id', scope.thread_root_id)
  const suffix = query.size ? `?${query}` : ''
  return api(`/bots/${botId}/sessions${suffix}`, clearedSessionsResponseSchema, 'DELETE')
}

export const runSlashCommand = (channelId: string, command: string, thread_root_id?: string | null): Promise<SlashCommandResponse> =>
  api(`/channels/${channelId}/command`, slashCommandResponseSchema, 'POST', { command, thread_root_id })

export const listPins = (channelId: string): Promise<Message[]> =>
  api(`/channels/${channelId}/pins`, pinListSchema)

export const addPin = (channelId: string, message_id: string): Promise<Message[]> =>
  api(`/channels/${channelId}/pins`, pinListSchema, 'POST', { message_id })

export const removePin = (channelId: string, messageId: string) =>
  api(`/channels/${channelId}/pins/${messageId}`, okResponseSchema, 'DELETE')

export const listBookmarks = (): Promise<Bookmark[]> => api('/bookmarks', bookmarkListSchema)

export const saveBookmark = (message_id: string, note = ''): Promise<Bookmark> =>
  api('/bookmarks', bookmarkSchema, 'POST', { message_id, note })

export const removeBookmark = (messageId: string) =>
  api(`/bookmarks/${messageId}`, okResponseSchema, 'DELETE')

export const listChannelFiles = (channelId: string): Promise<ChannelFile[]> =>
  api(`/channels/${channelId}/files`, channelFileListSchema)

export const searchMessages = (params: {
  q?: string; channel_id?: string; author_id?: string; has_attachments?: boolean; limit?: number
}, signal?: AbortSignal): Promise<SearchHit[]> => {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.channel_id) query.set('channel_id', params.channel_id)
  if (params.author_id) query.set('author_id', params.author_id)
  if (params.has_attachments !== undefined) query.set('has_attachments', String(params.has_attachments))
  if (params.limit) query.set('limit', String(params.limit))
  return api(`/search?${query}`, searchHitListSchema, 'GET', undefined, signal)
}

export const listSessions = (): Promise<SessionInfo[]> => api('/auth/sessions', sessionListSchema)
export const revokeOtherSessions = () => api('/auth/sessions/revoke-others', okResponseSchema, 'POST')

export const listWebhooks = (channelId: string): Promise<Webhook[]> =>
  api(`/channels/${channelId}/webhooks`, webhookListSchema)
export const createWebhook = (channelId: string, name: string, avatar_url: string | null = null): Promise<CreatedWebhook> =>
  api(`/channels/${channelId}/webhooks`, webhookCreatedSchema, 'POST', { name, avatar_url })
export const deleteWebhook = (webhookId: string) => remove(`/webhooks/${webhookId}`)

export const listBridgeDevices = (): Promise<BridgeDevice[]> => api('/bridges', bridgeDeviceListSchema)
export const getLocalAgentStatus = (): Promise<LocalAgentStatus> => api('/local-agents/status', localAgentStatusSchema)
export const listHostFs = (path?: string): Promise<BridgeFsList> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return api(`/host/fs${query}`, bridgeFsListSchema)
}
export const mkdirHostFs = (path: string, name: string) =>
  api('/host/fs/mkdir', fsActionResultSchema, 'POST', { path, name })
export const deleteHostFs = (path: string) =>
  api(`/host/fs?path=${encodeURIComponent(path)}`, okResponseSchema, 'DELETE')
export const cloneHostRepo = (path: string, repo: string, dir_name?: string) =>
  api('/host/fs/clone', fsActionResultSchema, 'POST', { path, repo, ...(dir_name?.trim() ? { dir_name: dir_name.trim() } : {}) })
export const listBridgeFs = (botId: string, path?: string): Promise<BridgeFsList> => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return api(`/bridges/${botId}/fs${query}`, bridgeFsListSchema)
}

export async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const active = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  field.style.cssText = 'position:fixed;left:-9999px'
  const dialog = active?.closest('dialog') ?? document.body
  dialog.append(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('请手动复制。')
  } finally {
    field.remove()
    if (active instanceof HTMLElement) active.focus()
  }
}
