import { z } from 'zod'
import {
  bridgeFsEntrySchema, channelSchema, contextEntrySchema, idSchema, memberSchema, messageSchema,
  promptBlockSchema, reactionSummarySchema, runtimeSchema, senderSchema, toolSchema, userSchema, workspaceSchema,
} from './domain.js'
import { hasMessageContent, messageFields } from './rest.js'

const scope = { channel_id: idSchema, thread_root_id: idSchema.nullable().optional() }
const ping = z.object({ type: z.literal('ping') })
const pong = z.object({ type: z.literal('pong') })
const nonce = z.string().min(1).max(128)
export const deltaSchema = z.object({
  part: z.enum(['text', 'thinking', 'tool_start', 'tool_end', 'prompt']),
  delta: z.string().max(256_000).optional(), tool: toolSchema.optional(), prompt: promptBlockSchema.optional(),
})
const validDelta = (value: z.infer<typeof deltaSchema>) =>
  value.part === 'text' || value.part === 'thinking'
    ? value.delta !== undefined
    : value.part === 'prompt'
      ? value.prompt !== undefined
      : value.tool !== undefined

export const clientUpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.send'), channel_id: idSchema, ...messageFields, client_nonce: nonce.optional() }),
  z.object({ type: z.literal('message.abort'), message_id: idSchema }),
  z.object({ type: z.literal('read.ack'), channel_id: idSchema, last_read_message_id: idSchema }),
  z.object({ type: z.literal('typing'), ...scope }),
  ping,
]).refine(value => value.type !== 'message.send' || hasMessageContent(value), 'A message or attachment is required')

export const clientDownSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), user: userSchema, online_user_ids: z.array(idSchema), bridge_runtimes: z.record(runtimeSchema) }),
  z.object({ type: z.literal('message.created'), message: messageSchema, client_nonce: nonce.optional() }),
  deltaSchema.extend({ type: z.literal('message.delta'), ...scope, message_id: idSchema }),
  z.object({ type: z.literal('message.updated'), message: messageSchema }),
  z.object({ type: z.literal('message.deleted'), channel_id: idSchema, message_id: idSchema }),
  z.object({ type: z.literal('message.reactions'), channel_id: idSchema, message_id: idSchema, reactions: z.array(reactionSummarySchema) }),
  z.object({ type: z.literal('member.updated'), member: memberSchema }),
  z.object({ type: z.literal('member.removed'), user_id: idSchema }),
  z.object({ type: z.literal('presence.update'), user_id: idSchema, online: z.boolean(), runtime_meta: runtimeSchema.optional() }),
  z.object({ type: z.literal('typing'), ...scope, user_id: idSchema }),
  z.object({ type: z.literal('channel.updated'), channel: channelSchema }),
  z.object({ type: z.literal('channel.removed'), channel_id: idSchema }),
  z.object({ type: z.literal('workspace.updated'), workspace: workspaceSchema }),
  z.object({ type: z.literal('workspace.removed'), workspace_id: idSchema }),
  z.object({ type: z.literal('error'), error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }), client_nonce: nonce.optional() }),
  pong,
]).refine(value => value.type !== 'message.delta' || validDelta(value))

const externalSession = z.string().min(1).max(1024)
export const bridgeUpSchema = z.discriminatedUnion('type', [
  runtimeSchema.extend({ type: z.literal('bridge.hello') }),
  deltaSchema.extend({ type: z.literal('run.delta'), run_id: idSchema }),
  z.object({ type: z.literal('run.done'), run_id: idSchema, external_session_id: externalSession.optional() }),
  z.object({ type: z.literal('run.error'), run_id: idSchema, error: z.string().min(1).max(4000) }),
  z.object({
    type: z.literal('fs.list.result'),
    request_id: idSchema,
    path: z.string().max(4096),
    parent: z.string().max(4096).nullable(),
    entries: z.array(bridgeFsEntrySchema),
    error: z.string().max(1000).optional(),
  }),
  pong,
]).refine(value => value.type !== 'run.delta' || validDelta(value))

export const runStartSchema = z.object({
  type: z.literal('run.start'), run_id: idSchema, message_id: idSchema, ...scope,
  scope_key: z.string().min(1).max(256), prompt: z.string(), context: z.array(contextEntrySchema),
  channel_context: z.string().optional(),
  work_dir: z.string().max(4096).optional(),
  sender: senderSchema, external_session_id: externalSession.optional(),
})
export const bridgeDownSchema = z.discriminatedUnion('type', [
  senderSchema.omit({ id: true }).extend({ type: z.literal('bridge.welcome'), bot_id: idSchema }),
  runStartSchema,
  z.object({
    type: z.literal('run.input'),
    run_id: idSchema,
    prompt_id: idSchema.optional(),
    content: z.string().max(60_000),
    sender: senderSchema,
  }),
  z.object({ type: z.literal('run.abort'), run_id: idSchema }),
  z.object({ type: z.literal('fs.list'), request_id: idSchema, path: z.string().max(4096).optional() }),
  ping,
])

export type Delta = z.infer<typeof deltaSchema>
export type ClientUp = z.infer<typeof clientUpSchema>
export type ClientDown = z.infer<typeof clientDownSchema>
export type BridgeUp = z.infer<typeof bridgeUpSchema>
export type BridgeDown = z.infer<typeof bridgeDownSchema>
export type RunStart = z.infer<typeof runStartSchema>
