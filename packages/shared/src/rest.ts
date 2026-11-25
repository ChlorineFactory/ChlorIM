import { z } from 'zod'
import {
  attachmentSchema, avatarUrlSchema, boardStatusSchema, bookmarkSchema, botModeSchema, botSchema,
  bridgeDeviceSchema, bridgeFsListSchema, channelFileSchema, channelSchema, displayNameSchema, driverSchema, idSchema, inviteSchema,
  memberSchema, messageSchema, presenceStatusSchema, providerSchema, providerTypeSchema,
  reactionSummarySchema, searchHitSchema, sessionInfoSchema, timestampSchema, triggerPolicySchema,
  usernameSchema, userSchema, webhookSchema, workDirSchema, workspaceSchema,
} from './domain.js'

const password = z.string().min(8).max(256)
const channelName = z.string().trim().min(1).max(100)
const topic = z.string().max(1000)
const systemContext = z.string().max(16_000)
const members = z.array(idSchema).max(100)
const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export const loginSchema = z.object({ username: usernameSchema, password })
export const registerSchema = loginSchema.extend({ display_name: displayNameSchema, invite_code: idSchema.optional() })
export const changePasswordSchema = z.object({
  current_password: password, new_password: password, revoke_others: z.boolean().default(true),
})
export const adminUserPatchSchema = z.object({
  is_admin: z.boolean(), disabled: z.boolean(),
}).partial()
export const adminResetPasswordSchema = z.object({ new_password: password })
export const profilePatchSchema = z.object({
  display_name: displayNameSchema, bio: z.string().max(2000), avatar_url: avatarUrlSchema,
  presence_status: presenceStatusSchema, status_text: z.string().max(120),
}).partial()
export const inviteCreateSchema = z.object({
  max_uses: z.number().int().min(1).max(1000).default(1),
  expires_at: timestampSchema.nullable().default(null),
})
export const workspaceCreateSchema = z.object({
  name: displayNameSchema,
  work_dir: workDirSchema.optional().default(null),
  host_bot_id: idSchema.nullable().optional().default(null),
  host_name: z.string().trim().min(1).max(255).nullable().optional().default(null),
  icon: z.string().trim().min(1).max(16).nullable().optional().default(null),
  color: z.string().trim().min(1).max(32).nullable().optional().default(null),
  description: z.string().max(1000).default(''),
  create_default_channel: z.boolean().default(true),
})
export const workspacePatchSchema = workspaceCreateSchema.omit({ create_default_channel: true }).partial()
export const channelCreateSchema = z.object({
  type: z.enum(['public', 'private', 'board']), name: channelName, topic: topic.default(''),
  system_context: systemContext.default(''), workspace_id: idSchema.nullable().optional(),
  work_dir: workDirSchema.optional().default(null), member_ids: members.default([]),
})
export const channelPatchSchema = z.object({
  name: channelName, topic, system_context: systemContext,
  workspace_id: idSchema.nullable(), work_dir: workDirSchema, pinned_message_id: idSchema.nullable(),
}).partial()
export const channelPreferenceSchema = z.object({ muted: z.boolean() })
export const dmCreateSchema = z.object({ target_user_id: idSchema })
export const addMembersSchema = z.union([
  z.object({ user_id: idSchema }).transform(value => [value.user_id]),
  z.object({ member_ids: members.min(1) }).transform(value => value.member_ids),
  z.object({ user_ids: members.min(1) }).transform(value => value.user_ids),
])
export const messageFields = {
  content: z.string().max(60_000),
  thread_root_id: idSchema.nullable().optional(),
  reply_to_id: idSchema.nullable().optional(),
  board_status: boardStatusSchema.nullable().optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
}
export const hasMessageContent = (value: { content: string; attachments?: unknown[] }) =>
  Boolean(value.content.trim() || value.attachments?.length)
export const sendMessageSchema = z.object(messageFields).refine(hasMessageContent, 'A message or attachment is required')
export const messagePatchSchema = z.object({
  content: messageFields.content.optional(),
  board_status: boardStatusSchema.nullable().optional(),
}).refine(value => value.content !== undefined || value.board_status !== undefined, 'Provide content or board_status')
export const pageMessagesSchema = z.object({
  before: z.string().regex(ulidPattern).optional(),
  around: z.string().regex(ulidPattern).optional(),
  thread_root_id: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const readAckSchema = z.object({ last_read_message_id: idSchema })
export const pinCreateSchema = z.object({ message_id: idSchema })
export const reactionToggleSchema = z.object({ emoji: z.string().trim().min(1).max(32) })
export const reactionToggleResponseSchema = z.object({ reactions: z.array(reactionSummarySchema) })
export const bookmarkCreateSchema = z.object({ message_id: idSchema, note: z.string().max(500).default('') })
export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  channel_id: idSchema.optional(),
  author_id: idSchema.optional(),
  has_attachments: z.union([
    z.boolean(), z.enum(['true', 'false', '1', '0']).transform(value => value === 'true' || value === '1'),
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export const webhookCreateSchema = z.object({
  name: displayNameSchema, avatar_url: avatarUrlSchema.optional().default(null),
})
export const webhookCreatedSchema = webhookSchema.extend({ token: z.string(), url: z.string() })
export const webhookIncomingSchema = z.object({
  content: z.string().trim().min(1).max(60_000),
  username: z.string().trim().min(1).max(100).optional(),
  trigger_bots: z.boolean().default(false),
})
export const slashCommandSchema = z.object({
  command: z.string().trim().min(1).max(4000),
  thread_root_id: idSchema.nullable().optional(),
})
export const slashCommandResponseSchema = z.object({
  ok: z.literal(true), message: z.string(), created_message: messageSchema.optional(),
})

export const httpUrlSchema = z.string().max(2048).url().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, 'Expected an HTTP(S) base URL without credentials, query, or fragment')
export const providerCreateSchema = z.object({
  name: displayNameSchema, type: providerTypeSchema, base_url: httpUrlSchema,
  api_key: z.string().max(4096).default(''), models: z.array(z.string().min(1).max(256)).max(100).default([]),
  hermes_session_header: z.boolean().default(false),
})
export const providerPatchSchema = providerCreateSchema.partial()
const botSettings = {
  trigger_policy: triggerPolicySchema.optional(), provider_id: idSchema.nullable().optional(),
  model: z.string().trim().min(1).max(256).nullable().optional(),
  system_prompt: z.string().max(60_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  context_limit: z.number().int().min(1).max(100).optional(),
  driver_hint: driverSchema.nullable().optional(),
  disabled: z.boolean().optional(),
}
export const botCreateSchema = profilePatchSchema.pick({ display_name: true, bio: true, avatar_url: true }).extend({
  ...botSettings, display_name: displayNameSchema, username: usernameSchema, mode: botModeSchema,
  channel_ids: members.optional(),
})
export const botPatchSchema = profilePatchSchema.pick({ display_name: true, bio: true, avatar_url: true }).extend(botSettings)

export const messagePageSchema = z.object({ messages: z.array(messageSchema), next_before: idSchema.nullable() })
export const memberListSchema = z.array(memberSchema)
export const workspaceListSchema = z.array(workspaceSchema)
export const channelListSchema = z.array(channelSchema)
export const inviteListSchema = z.array(inviteSchema)
export const providerListSchema = z.array(providerSchema)
export const botListSchema = z.array(botSchema)
export const sessionListSchema = z.array(sessionInfoSchema)
export const pinListSchema = z.array(messageSchema)
export const bookmarkListSchema = z.array(bookmarkSchema)
export const channelFileListSchema = z.array(channelFileSchema)
export const webhookListSchema = z.array(webhookSchema)
export const searchHitListSchema = z.array(searchHitSchema)
export const bridgeDeviceListSchema = z.array(bridgeDeviceSchema)
export { bridgeFsListSchema }

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
})
export const authResponseSchema = z.object({ user: userSchema, token: z.string() })
export const bootstrapResponseSchema = z.object({ initialized: z.boolean() })
export const sessionResponseSchema = z.object({ initialized: z.boolean(), user: userSchema.nullable() })
export const okResponseSchema = z.object({ ok: z.literal(true) })
export const clearedSessionsResponseSchema = z.object({ ok: z.literal(true), cleared: z.number().int().nonnegative() })
export const providerTestResponseSchema = z.object({ ok: z.literal(true), models: z.array(z.string()) })
export const botCredentialsSchema = z.object({ bot_token: z.string(), connect_command: z.string() })
export const botWriteResponseSchema = botSchema.merge(botCredentialsSchema.partial())

export type ApiError = z.infer<typeof apiErrorSchema>
export type RegisterRequest = z.input<typeof registerSchema>
export type LoginRequest = z.input<typeof loginSchema>
export type AuthResponse = z.infer<typeof authResponseSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type ChangePasswordRequest = z.input<typeof changePasswordSchema>
export type AdminUserPatchRequest = z.input<typeof adminUserPatchSchema>
export type AdminResetPasswordRequest = z.input<typeof adminResetPasswordSchema>
export type SendMessageRequest = z.input<typeof sendMessageSchema>
export type CreateWorkspaceRequest = z.input<typeof workspaceCreateSchema>
export type PatchWorkspaceRequest = z.input<typeof workspacePatchSchema>
export type CreateChannelRequest = z.input<typeof channelCreateSchema>
export type CreateProviderRequest = z.input<typeof providerCreateSchema>
export type CreateBotRequest = z.input<typeof botCreateSchema>
export type BotWriteResponse = z.infer<typeof botWriteResponseSchema>
export type ProfilePatchRequest = z.input<typeof profilePatchSchema>
export type CreateInviteRequest = z.input<typeof inviteCreateSchema>
export type PatchChannelRequest = z.input<typeof channelPatchSchema>
export type ChannelPreferenceRequest = z.input<typeof channelPreferenceSchema>
export type CreateDmRequest = z.input<typeof dmCreateSchema>
export type AddMembersRequest = z.input<typeof addMembersSchema>
export type PatchMessageRequest = z.input<typeof messagePatchSchema>
export type MessagePageQuery = z.input<typeof pageMessagesSchema>
export type MessagePage = z.infer<typeof messagePageSchema>
export type ReadAckRequest = z.input<typeof readAckSchema>
export type PatchProviderRequest = z.input<typeof providerPatchSchema>
export type ProviderTestResponse = z.infer<typeof providerTestResponseSchema>
export type PatchBotRequest = z.input<typeof botPatchSchema>
export type BotCredentials = z.infer<typeof botCredentialsSchema>
export type CreateWebhookRequest = z.input<typeof webhookCreateSchema>
export type CreatedWebhook = z.infer<typeof webhookCreatedSchema>
export type SlashCommandRequest = z.input<typeof slashCommandSchema>
export type SlashCommandResponse = z.infer<typeof slashCommandResponseSchema>
