import { z } from 'zod'

export const userKindSchema = z.enum(['human', 'bot'])
export const presenceStatusSchema = z.enum(['online', 'busy', 'away'])
export const boardStatusSchema = z.enum(['open', 'done'])
export const channelTypeSchema = z.enum(['public', 'private', 'dm', 'board'])
export const providerTypeSchema = z.enum(['openai_compat', 'anthropic', 'gemini'])
export const botModeSchema = z.enum(['provider', 'local', 'bridge'])
export const triggerPolicySchema = z.enum(['mention', 'always', 'dm_only'])
export const driverSchema = z.enum(['claude-code', 'codex', 'hermes', 'antigravity', 'custom'])
export const localDriverSchema = z.enum(['claude-code', 'codex', 'hermes', 'antigravity'])
export const permissionModeSchema = z.enum(['readonly', 'default', 'auto'])
export const messageStatusSchema = z.enum(['queued', 'streaming', 'done', 'aborted', 'error'])
export const idSchema = z.string().min(1).max(128)
export const usernameSchema = z.string().min(2).max(32).regex(/^[a-z0-9_-]+$/)
export const timestampSchema = z.number().int().nonnegative()
export const displayNameSchema = z.string().trim().min(1).max(100)
export const workDirSchema = z.string().trim().min(1).max(4096)
  .refine(value => !value.includes('\0') && !/(?:^|[\\/])\.\.(?:$|[\\/])/.test(value), 'Work directory cannot contain null bytes or parent traversal')
  .nullable()
export const avatarUrlSchema = z.string().max(2048).refine(value => {
  if (/^\/uploads\/[a-f0-9]{32}$/.test(value)) return true
  if (/^preset:[a-z0-9_-]{1,32}$/.test(value)) return true
  try { return ['https:', 'http:'].includes(new URL(value).protocol) } catch { return false }
}).nullable()

export const runtimeSchema = z.object({
  hostname: z.string().min(1).max(255),
  driver: driverSchema,
  cwd: z.string().max(4096).optional(),
  allowed_roots: z.array(z.string().max(4096)).max(64).optional(),
  version: z.string().max(128).optional(),
})
export const bridgeFsEntrySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
  kind: z.enum(['dir', 'file']),
})
export const bridgeFsListSchema = z.object({
  path: z.string().max(4096),
  parent: z.string().max(4096).nullable(),
  entries: z.array(bridgeFsEntrySchema),
})
export const bridgeDeviceSchema = z.object({
  bot_id: idSchema,
  username: usernameSchema,
  display_name: displayNameSchema,
  online: z.boolean(),
  hostname: z.string().nullable(),
  driver: driverSchema.nullable(),
  cwd: z.string().nullable(),
  allowed_roots: z.array(z.string()),
})
export const userSchema = z.object({
  id: idSchema, kind: userKindSchema, username: usernameSchema, display_name: displayNameSchema,
  avatar_url: avatarUrlSchema, bio: z.string(), is_admin: z.boolean(), disabled: z.boolean(),
  presence_status: presenceStatusSchema, status_text: z.string(), created_at: timestampSchema,
})
export const senderSchema = userSchema.pick({ id: true, username: true, display_name: true })
export const botSummarySchema = z.object({
  mode: botModeSchema, model: z.string().nullable(), driver_hint: driverSchema.nullable(),
  runtime_meta: runtimeSchema.nullable(),
})
export const memberSchema = userSchema.extend({ online: z.boolean(), bot: botSummarySchema.nullable() })
export const workspaceSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  icon: z.string().max(16).nullable(),
  color: z.string().max(32).nullable(),
  work_dir: workDirSchema,
  host_bot_id: idSchema.nullable(),
  host_name: z.string().max(255).nullable(),
  description: z.string(),
  created_by: idSchema,
  created_at: timestampSchema,
})
export const channelSchema = z.object({
  id: idSchema, workspace_id: idSchema.nullable(), type: channelTypeSchema, name: z.string(), topic: z.string(),
  system_context: z.string(), work_dir: workDirSchema, effective_work_dir: z.string().nullable(),
  pinned_message_id: idSchema.nullable(), pinned_count: z.number().int().nonnegative(),
  created_by: idSchema, created_at: timestampSchema, dm_peer: userSchema.nullable(),
  member_count: z.number().int().nonnegative(), unread_count: z.number().int().nonnegative(),
  last_message_at: timestampSchema.nullable(), muted: z.boolean(),
})
export const attachmentSchema = z.object({
  url: z.string().regex(/^\/uploads\/[a-f0-9]{32}$/),
  name: z.string().min(1).max(255), mime: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
})
export const toolSchema = z.object({
  id: idSchema, name: z.string().min(1).max(256), input: z.unknown().optional(),
  output: z.unknown().optional(), status: z.enum(['running', 'done', 'error']),
})
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), text: z.string() }),
  toolSchema.extend({ type: z.literal('tool_call') }),
  attachmentSchema.extend({ type: z.literal('attachment') }),
])
export const reactionSummarySchema = z.object({
  emoji: z.string().min(1).max(32),
  count: z.number().int().positive(),
  user_ids: z.array(idSchema),
})
export const messageQuoteSchema = z.object({
  id: idSchema,
  author_id: idSchema,
  author_name: displayNameSchema,
  author_username: usernameSchema,
  content: z.string(),
  status: messageStatusSchema,
})
export const messageSchema = z.object({
  id: idSchema, channel_id: idSchema, thread_root_id: idSchema.nullable(),
  reply_to_id: idSchema.nullable(), reply_to: messageQuoteSchema.nullable(),
  author_id: idSchema, author: userSchema, content: z.string(), blocks: z.array(blockSchema),
  status: messageStatusSchema, error_message: z.string().nullable(),
  board_status: boardStatusSchema.nullable(), webhook_name: z.string().nullable(),
  reactions: z.array(reactionSummarySchema),
  bot_hop_count: z.number().int().nonnegative(), reply_count: z.number().int().nonnegative(),
  created_at: timestampSchema, updated_at: timestampSchema,
})
export const contextEntrySchema = z.object({
  author_username: usernameSchema, author_name: displayNameSchema, author_kind: userKindSchema,
  content: z.string(), created_at: timestampSchema,
})
export const providerSchema = z.object({
  id: idSchema, name: z.string(), type: providerTypeSchema, base_url: z.string(),
  models: z.array(z.string()), api_key_masked: z.string().nullable(), has_api_key: z.boolean(),
  hermes_session_header: z.boolean(), created_by: idSchema, created_at: timestampSchema,
})
export const botSchema = botSummarySchema.extend({
  user: userSchema, user_id: idSchema, owner_id: idSchema, trigger_policy: triggerPolicySchema,
  provider_id: idSchema.nullable(), system_prompt: z.string(), temperature: z.number(),
  context_limit: z.number().int(), local_cwd: workDirSchema.nullable().optional().default(null),
  permission_mode: permissionModeSchema.optional().default('default'),
  created_at: timestampSchema, online: z.boolean(),
})
export const localAgentDriverStatusSchema = z.object({
  available: z.boolean(),
  binary: z.string(),
})
export const localAgentStatusSchema = z.object({
  enabled: z.boolean(),
  hostname: z.string(),
  default_cwd: z.string(),
  allowed_roots: z.array(z.string()),
  drivers: z.object({
    codex: localAgentDriverStatusSchema,
    'claude-code': localAgentDriverStatusSchema,
    antigravity: localAgentDriverStatusSchema,
    hermes: localAgentDriverStatusSchema,
  }),
})
export const inviteSchema = z.object({
  code: idSchema, created_by: idSchema, max_uses: z.number().int(), used_count: z.number().int(),
  expires_at: timestampSchema.nullable(), created_at: timestampSchema,
})
export const sessionInfoSchema = z.object({
  id: idSchema, user_agent: z.string(), ip_address: z.string(),
  created_at: timestampSchema, last_active_at: timestampSchema, expires_at: timestampSchema,
  current: z.boolean(),
})
export const bookmarkSchema = z.object({
  message: messageSchema, note: z.string(), created_at: timestampSchema,
})
export const channelFileSchema = z.object({
  message_id: idSchema, author: userSchema, created_at: timestampSchema, attachment: attachmentSchema,
})
export const webhookSchema = z.object({
  id: idSchema, channel_id: idSchema, name: displayNameSchema, avatar_url: avatarUrlSchema,
  created_by: idSchema, created_at: timestampSchema,
})
export const searchHitSchema = messageSchema.extend({
  channel_name: z.string(), channel_type: channelTypeSchema,
})

export type User = z.infer<typeof userSchema>
export type PresenceStatus = z.infer<typeof presenceStatusSchema>
export type BoardStatus = z.infer<typeof boardStatusSchema>
export type Member = z.infer<typeof memberSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type Channel = z.infer<typeof channelSchema>
export type Message = z.infer<typeof messageSchema>
export type MessageQuote = z.infer<typeof messageQuoteSchema>
export type ReactionSummary = z.infer<typeof reactionSummarySchema>
export type MessageBlock = z.infer<typeof blockSchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type ToolCall = z.infer<typeof toolSchema>
export type ContextEntry = z.infer<typeof contextEntrySchema>
export type BridgeRuntime = z.infer<typeof runtimeSchema>
export type BridgeFsEntry = z.infer<typeof bridgeFsEntrySchema>
export type BridgeFsList = z.infer<typeof bridgeFsListSchema>
export type BridgeDevice = z.infer<typeof bridgeDeviceSchema>
export type DriverName = z.infer<typeof driverSchema>
export type LocalDriverName = z.infer<typeof localDriverSchema>
export type PermissionMode = z.infer<typeof permissionModeSchema>
export type LocalAgentStatus = z.infer<typeof localAgentStatusSchema>
export type Provider = z.infer<typeof providerSchema>
export type Bot = z.infer<typeof botSchema>
export type Invite = z.infer<typeof inviteSchema>
export type SessionInfo = z.infer<typeof sessionInfoSchema>
export type Bookmark = z.infer<typeof bookmarkSchema>
export type ChannelFile = z.infer<typeof channelFileSchema>
export type Webhook = z.infer<typeof webhookSchema>
export type SearchHit = z.infer<typeof searchHitSchema>
