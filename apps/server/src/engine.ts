import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { BridgeUp, Delta, MessageBlock, PromptBlock, RunStart, ToolCall, User } from '@chiorim/shared'
import { MAX_BOT_HOPS, publicUser } from './chat.js'
import type { createChat } from './chat.js'
import { bots, botSessions, channels, messages, providers, queuedRuns, users } from './db.js'
import type { BotRow, ChannelRow, Database, MessageRow } from './db.js'
import { fail } from './errors.js'
import type { LocalRunner } from './local-runner.js'
import { providerError, runProvider } from './providers.js'
import { writeSocket } from './realtime.js'
import type { BridgeConnection, createRealtime } from './realtime.js'
import type { createSecretBox } from './security.js'
import { visionImages } from './vision.js'

export { MAX_BOT_HOPS } from './chat.js'
const IDLE_TIMEOUT = 5 * 60_000
const MAX_TOTAL_DURATION = 30 * 60_000
const MAX_OUTPUT = 4_000_000

function withAttachmentNames(content: string, blocks: MessageBlock[]) {
  const names = blocks.flatMap(block => block.type === 'attachment' ? [block.name] : [])
  if (!names.length) return content
  const suffix = `[Attachments: ${names.join(', ')}]`
  return content ? content + '\n' + suffix : suffix
}

type Run = {
  request: RunStart
  botId: string
  channelId: string
  workspaceId: string | null
  triggerMessageId: string
  controller: AbortController
  bridge?: BridgeConnection
  timer?: NodeJS.Timeout
  startedAt: number
  flush?: NodeJS.Timeout
  content: string
  blocks: MessageBlock[]
  size: number
  history: MessageRow[]
  hops: number
}

export function createEngine(db: Database, chat: ReturnType<typeof createChat>, realtime: ReturnType<typeof createRealtime>,
  secret: ReturnType<typeof createSecretBox>, dataDir: string, localRunner?: LocalRunner) {
  const active = new Map<string, Run>()
  const byRunId = new Map<string, Run>()
  const queues = new Map<string, Run[]>()
  let closed = false
  const queueKey = (run: Run) => `${run.botId}/${run.request.scope_key}`

  function persist(run: Run, status?: 'done' | 'aborted' | 'error', error?: string) {
    if (run.flush) clearTimeout(run.flush)
    run.flush = undefined
    return db.update(messages).set({
      content: run.content, blocks_json: run.blocks, updated_at: Date.now(),
      ...(status ? { status, error_message: error ?? null } : {}),
    }).where(eq(messages.id, run.request.message_id)).returning().get()
  }

  function finish(run: Run, status: 'done' | 'aborted' | 'error', error?: string, external?: string) {
    if (active.get(run.request.message_id) !== run) return
    active.delete(run.request.message_id)
    byRunId.delete(run.request.run_id)
    if (run.timer) clearTimeout(run.timer)
    if (run.flush) clearTimeout(run.flush)
    if (status !== 'done') {
      run.controller.abort()
      if (run.bridge) writeSocket(run.bridge.ws, { type: 'run.abort', run_id: run.request.run_id })
    }
    run.blocks = run.blocks.map(block => block.type === 'tool_call' && block.status === 'running'
      ? { ...block, status: status === 'done' ? 'done' : 'error' } : block)
    const row = db.transaction(tx => {
      const updated = persist(run, status, error)
      if (updated && status === 'done' && external) {
        const values = { bot_id: run.botId, scope_key: run.request.scope_key, external_session_id: external, updated_at: Date.now() }
        tx.insert(botSessions).values(values).onConflictDoUpdate({
          target: [botSessions.bot_id, botSessions.scope_key], set: { external_session_id: external, updated_at: values.updated_at },
        }).run()
      }
      return updated
    })
    const key = queueKey(run)
    const queue = queues.get(key)
    const head = queue?.[0] === run
    if (queue) queue.splice(queue.indexOf(run), 1)
    if (queue && !queue.length) queues.delete(key)
    if (row) {
      realtime.publish({ type: 'message.updated', message: chat.dto(row) }, row.channel_id)
      if (status === 'done') trigger(row)
    }
    if (head && queue?.length && !closed) queueMicrotask(() => start(queue[0]))
  }

  function armIdleTimer(run: Run) {
    if (run.timer) clearTimeout(run.timer)
    const remaining = Math.max(1000, MAX_TOTAL_DURATION - (Date.now() - run.startedAt))
    run.timer = setTimeout(() => finish(run, 'error', 'Bot run timed out'), Math.min(IDLE_TIMEOUT, remaining))
  }

  function applyDelta(run: Run, event: Delta) {
    if (active.get(run.request.message_id) !== run) return
    armIdleTimer(run)
    const { part, tool, delta, prompt } = event
    run.size += (delta?.length ?? 0) + (tool ? JSON.stringify(tool).length : 0) + (prompt ? JSON.stringify(prompt).length : 0)
    if (run.size > MAX_OUTPUT) {
      finish(run, 'error', 'Bot output exceeded the limit')
      return
    }
    if (part === 'text') run.content += delta ?? ''
    if (part === 'thinking') {
      const last = run.blocks.at(-1)
      if (last?.type === 'thinking') last.text += delta ?? ''
      else run.blocks.push({ type: 'thinking', text: delta ?? '' })
    }
    if (tool && (part === 'tool_start' || part === 'tool_end')) {
      const previous = run.blocks.find(block => block.type === 'tool_call' && block.id === tool.id)
      const update: ToolCall = { ...tool }
      if (previous) Object.assign(previous, update)
      else run.blocks.push({ ...update, type: 'tool_call' })
    }
    if (prompt && part === 'prompt') {
      const previous = run.blocks.find(block => block.type === 'prompt' && block.id === prompt.id)
      const update: PromptBlock = { ...prompt }
      if (previous) Object.assign(previous, update)
      else run.blocks.push({ ...update, type: 'prompt' })
      // Persist prompts immediately so refreshes preserve unresolved cards.
      persist(run)
    }
    realtime.publish({
      type: 'message.delta', channel_id: run.channelId, thread_root_id: run.request.thread_root_id,
      message_id: run.request.message_id, part, delta, tool, prompt,
    }, run.channelId)
    run.flush ??= setTimeout(() => {
      if (active.get(run.request.message_id) === run) persist(run)
    }, 200)
  }

  function deliverRunInput(run: Run, actor: User, value: string, promptId?: string, label?: string) {
    if (!run.bridge) fail(409, 'NOT_INTERACTIVE', 'This active run cannot receive interactive input')
    const targetPrompt = promptId
      ? run.blocks.find(block => block.type === 'prompt' && block.id === promptId)
      : [...run.blocks].reverse().find(block => block.type === 'prompt' && !block.resolved_value)
    if (targetPrompt && targetPrompt.type === 'prompt') {
      const matched = targetPrompt.options.find(opt => opt.value === value || opt.label === value)
      targetPrompt.resolved_value = value
      targetPrompt.resolved_label = label ?? matched?.label ?? value
      targetPrompt.resolved_by = actor.display_name
      const updated = persist(run)
      if (updated) realtime.publish({ type: 'message.updated', message: chat.dto(updated) }, run.channelId)
    }
    // Reset idle timeout so long interactive sessions do not time out right after user responds.
    armIdleTimer(run)
    if (!writeSocket(run.bridge.ws, {
      type: 'run.input',
      run_id: run.request.run_id,
      prompt_id: targetPrompt?.type === 'prompt' ? targetPrompt.id : promptId,
      content: value,
      sender: { id: actor.id, username: actor.username, display_name: actor.display_name },
    })) {
      fail(503, 'DEVICE_OFFLINE', 'Bridge connection lost')
    }
    return chat.dto(chat.messageRow(run.request.message_id))
  }

  function respond(actor: User, messageId: string, input: { prompt_id?: string; value: string; label?: string }) {
    const row = chat.messageRow(messageId)
    chat.access(row.channel_id, actor.id)
    const run = active.get(messageId)
    if (!run || !run.bridge) fail(409, 'RUN_NOT_ACTIVE', 'This prompt is no longer active')
    return deliverRunInput(run, actor, input.value, input.prompt_id, input.label)
  }

  async function stream(run: Run, bot: typeof bots.$inferSelect) {
    try {
      const provider = bot.provider_id ? db.select().from(providers).where(eq(providers.id, bot.provider_id)).get() : undefined
      if (!provider || !bot.model) return finish(run, 'error', 'A provider and model are required')
      const signal = run.controller.signal
      const images = await visionImages(dataDir, run.history, signal)
      // Release large history/context buffers once handed off to the upstream stream.
      run.history = []
      const context = run.request.context
      run.request.context = []
      signal.throwIfAborted()
      for await (const delta of runProvider(provider, secret.decrypt(provider.api_key_enc), bot, context,
        run.request.scope_key, signal, run.request.channel_context, images)) applyDelta(run, delta)
      finish(run, 'done')
    } catch (error) {
      finish(run, 'error', providerError(error))
    }
  }

  async function runLocal(run: Run, bot: BotRow) {
    try {
      if (!localRunner?.enabled) return finish(run, 'error', 'Local agent execution is disabled on this server')
      const session = db.select().from(botSessions).where(and(
        eq(botSessions.bot_id, run.botId), eq(botSessions.scope_key, run.request.scope_key),
      )).get()
      const payload = { ...run.request, external_session_id: session?.external_session_id }
      run.history = []
      run.request.context = []
      const external = await localRunner.run(bot, payload, run.controller.signal, delta => {
        run.controller.signal.throwIfAborted()
        applyDelta(run, delta)
      }, {
        CHIORIM_TRIGGER_MESSAGE_ID: run.triggerMessageId,
        ...(run.workspaceId ? { CHIORIM_WORKSPACE_ID: run.workspaceId } : {}),
      })
      finish(run, 'done', undefined, external)
    } catch (error) {
      if (!run.controller.signal.aborted) {
        finish(run, 'error', ((error instanceof Error ? error.message : '') || 'Local agent execution failed').slice(0, 4000))
      }
    }
  }

  function start(run?: Run) {
    if (!run || closed || run.timer || active.get(run.request.message_id) !== run) return
    const target = chat.memberBots(run.channelId).find(({ user }) => user.id === run.botId && !user.disabled)
    if (!target) return finish(run, 'error', 'Bot is disabled or no longer in this channel')
    const { bot } = target
    run.startedAt = Date.now()
    armIdleTimer(run)
    if (bot.mode === 'provider') { void stream(run, bot); return }
    if (bot.mode === 'local') { void runLocal(run, bot); return }
    const bridge = realtime.bridges.get(run.botId)
    if (!bridge?.runtime) return finish(run, 'error', 'Bot is offline. Check the local chior-bridge service.')
    const session = db.select().from(botSessions).where(and(
      eq(botSessions.bot_id, run.botId), eq(botSessions.scope_key, run.request.scope_key),
    )).get()
    run.bridge = bridge
    const payload = { ...run.request, external_session_id: session?.external_session_id }
    run.history = []
    run.request.context = []
    if (!writeSocket(bridge.ws, payload)) {
      finish(run, 'error', 'Bridge connection lost')
    }
  }

  function dispatch(room: ChannelRow, bot: BotRow, row: MessageRow, source: MessageRow, sender: User) {
    const history = chat.listMessages(room.id, source.thread_root_id, bot.context_limit, undefined, source.id).reverse()
    const context = history.map(entry => {
      const { author, content, created_at } = chat.dto(entry)
      return { author_username: author.username, author_name: author.display_name, author_kind: author.kind,
        content: withAttachmentNames(content.slice(0, 60_000), entry.blocks_json), created_at }
    })
    const workDir = chat.effectiveWorkDir(room)
    const actionGuide = bot.mode === 'local'
      ? [
        `ChiorIM context: channel_id=${room.id}${room.workspace_id ? `, workspace_id=${room.workspace_id}` : ''}, trigger_message_id=${source.id}.`,
        'You can interact with ChiorIM directly using $CHIORIM_URL with header "Authorization: Bearer $CHIORIM_TOKEN":',
        '- List folder groups/channels: GET /api/workspaces, GET /api/channels',
        '- Create channel: POST /api/channels {"type":"public"|"private"|"board","name":"...","workspace_id":"...","topic":"...","work_dir":"..."}',
        '- Post or quote/thread reply: POST /api/channels/{channel_id}/messages {"content":"...","thread_root_id?":"...","reply_to_id?":"..."}',
        '- React with emoji: POST /api/messages/{message_id}/reactions {"emoji":"👍"}',
      ].join('\n')
      : ''
    const contextNotes = [room.system_context, workDir ? `Workspace directory: ${workDir}` : '', actionGuide].filter(Boolean).join('\n\n')
    const run: Run = {
      request: {
        type: 'run.start', run_id: randomUUID(), message_id: row.id, channel_id: room.id, thread_root_id: row.thread_root_id,
        scope_key: row.thread_root_id ? `thread:${row.thread_root_id}` : `channel:${room.id}`,
        prompt: withAttachmentNames(source.content, source.blocks_json), context,
        channel_context: contextNotes || undefined,
        work_dir: workDir ?? undefined,
        sender: { id: sender.id, username: sender.username, display_name: sender.display_name },
      },
      botId: bot.user_id, channelId: room.id, workspaceId: room.workspace_id, triggerMessageId: source.id,
      controller: new AbortController(), startedAt: Date.now(), content: '', blocks: [], size: 0, history, hops: row.bot_hop_count,
    }
    active.set(row.id, run)
    byRunId.set(run.request.run_id, run)
    const key = queueKey(run)
    const queue = queues.get(key)
    if (queue) queue.push(run)
    else { queues.set(key, [run]); start(run) }
  }

  function trigger(source: MessageRow, selected?: ReadonlySet<string>) {
    if (closed || source.bot_hop_count >= MAX_BOT_HOPS) return
    const room = chat.channelRow(source.channel_id)
    const sender = chat.dto(source).author
    const mentions = new Set([...source.content.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]{2,32})/g)].map(match => match[1].toLowerCase()))

    // If a human replies directly to an active streaming Bridge run (via quote-reply or while it has an unresolved interactive prompt),
    // route the message immediately as run.input instead of deadlocking behind the active run in the serial queue.
    if (!selected && sender.kind === 'human') {
      const scope = source.thread_root_id ? `thread:${source.thread_root_id}` : `channel:${room.id}`
      const memberMap = new Map(chat.memberBots(room.id).map(item => [item.user.id, item]))
      const quotedRun = source.reply_to_id ? active.get(source.reply_to_id) : undefined
      let interactiveRun: Run | undefined
      if (quotedRun && quotedRun.bridge && quotedRun.channelId === room.id && quotedRun.request.scope_key === scope) {
        interactiveRun = quotedRun
      } else {
        const waiting = [...active.values()].filter(run =>
          run.bridge && run.channelId === room.id && run.request.scope_key === scope
          && run.blocks.some(block => block.type === 'prompt' && !block.resolved_value))
        if (waiting.length === 1) {
          const only = waiting[0]
          const botUser = memberMap.get(only.botId)?.user
          if (room.type === 'dm' || mentions.size === 0 || (botUser && mentions.has(botUser.username))) {
            interactiveRun = only
          }
        } else if (waiting.length > 1) {
          interactiveRun = waiting.find(run => {
            const botUser = memberMap.get(run.botId)?.user
            return Boolean(botUser && mentions.has(botUser.username))
          })
        }
      }
      if (interactiveRun) {
        const botUsername = memberMap.get(interactiveRun.botId)?.user.username
        const cleaned = botUsername
          ? source.content.replace(new RegExp(`^(?:@${botUsername}\\b[\\s,，:：]*)+`, 'i'), '').trim() || source.content.trim()
          : source.content.trim()
        try {
          deliverRunInput(interactiveRun, sender, cleaned)
          return
        } catch { /* Fall through to normal dispatch if bridge disconnected */ }
      }
    }

    const candidates = chat.memberBots(room.id).filter(({ bot, user }) => !user.disabled && bot.user_id !== source.author_id &&
      (selected ? selected.has(user.id) : room.type === 'dm' ||
        (bot.trigger_policy !== 'dm_only' && (bot.trigger_policy === 'always' || mentions.has(user.username)))))
    if (!candidates.length) return
    for (const { bot } of candidates) {
      const offline = bot.mode === 'bridge' && !realtime.runtime(bot.user_id)
      const row = chat.insert({
        channel_id: room.id, thread_root_id: source.thread_root_id, author_id: bot.user_id, reply_to_id: source.id,
        status: 'streaming', bot_hop_count: source.bot_hop_count + 1,
        board_status: room.type === 'board' && !source.thread_root_id ? 'open' : null,
        error_message: null,
      })
      if (offline) {
        db.insert(queuedRuns).values({
          message_id: row.id, bot_id: bot.user_id, channel_id: room.id,
          source_message_id: source.id, sender_id: sender.id, created_at: Date.now(),
        }).run()
        chat.created(row)
      } else {
        chat.created(row)
        dispatch(room, bot, row, source, sender)
      }
    }
  }

  function drainQueued(botId: string) {
    if (closed || !realtime.runtime(botId)) return
    const pending = db.select().from(queuedRuns)
      .where(eq(queuedRuns.bot_id, botId))
      .orderBy(asc(queuedRuns.created_at), asc(queuedRuns.message_id))
      .all()
    for (const item of pending) {
      const removed = db.delete(queuedRuns).where(eq(queuedRuns.message_id, item.message_id)).returning().get()
      if (!removed) continue
      const row = db.select().from(messages).where(eq(messages.id, item.message_id)).get()
      if (!row || row.status !== 'streaming') continue
      const room = db.select().from(channels).where(eq(channels.id, item.channel_id)).get()
      const target = room ? chat.memberBots(room.id).find(({ user }) => user.id === botId && !user.disabled) : undefined
      const source = db.select().from(messages).where(eq(messages.id, item.source_message_id)).get()
      const senderRow = db.select().from(users).where(eq(users.id, item.sender_id)).get()
      if (!room || !target || !source || !senderRow) {
        const aborted = db.update(messages).set({
          status: 'aborted', error_message: 'Queued task could no longer be dispatched', updated_at: Date.now(),
        }).where(eq(messages.id, row.id)).returning().get()
        if (aborted) realtime.publish({ type: 'message.updated', message: chat.dto(aborted) }, aborted.channel_id)
        continue
      }
      realtime.publish({ type: 'message.updated', message: chat.dto(row) }, room.id)
      dispatch(room, target.bot, row, source, publicUser(senderRow))
    }
  }

  function regenerate(actor: User, id: string) {
    if (closed) fail(503, 'SERVER_CLOSING', 'Server is closing')
    const row = chat.messageRow(id)
    const room = actor.is_admin ? chat.channelRow(row.channel_id) : chat.access(row.channel_id, actor.id)
    if (row.status === 'streaming') fail(409, 'RUN_ACTIVE', 'Abort the run before regenerating this message')
    const target = chat.memberBots(room.id).find(({ user }) => user.id === row.author_id && !user.disabled)
    if (!target) fail(400, 'BOT_UNAVAILABLE', 'A Bot that is enabled and in the channel is required')
    const source = row.reply_to_id ? chat.messageInChannel(room.id, row.reply_to_id) :
      chat.listMessages(room.id, row.thread_root_id, 100, row.id, row.id).find(entry => entry.author_id !== row.author_id)
    if (!source || source.status !== 'done') fail(409, 'SOURCE_MISSING', 'An available original message is required')
    const updated = db.update(messages).set({ content: '', blocks_json: [], error_message: null,
      status: 'streaming', updated_at: Date.now(), reply_to_id: source.id }).where(eq(messages.id, id)).returning().get()
    const offline = target.bot.mode === 'bridge' && !realtime.runtime(target.bot.user_id)
    if (offline) {
      db.insert(queuedRuns).values({
        message_id: updated.id, bot_id: target.bot.user_id, channel_id: room.id,
        source_message_id: source.id, sender_id: actor.id, created_at: Date.now(),
      }).onConflictDoUpdate({
        target: queuedRuns.message_id,
        set: { source_message_id: source.id, sender_id: actor.id, created_at: Date.now() },
      }).run()
    }
    const message = chat.dto(updated)
    realtime.publish({ type: 'message.updated', message }, room.id)
    if (!offline) dispatch(room, target.bot, updated, source, actor)
    return message
  }

  function botPostHops(botId: string) {
    let hops = 1
    for (const run of active.values()) if (run.botId === botId && run.timer) hops = Math.max(hops, run.hops)
    return hops
  }

  function resetSessions(botId: string, scopes?: string[]) {
    const scopeKeys = scopes ? new Set(scopes) : undefined
    for (const run of [...active.values()]) {
      if (run.botId === botId && (!scopeKeys || scopeKeys.has(run.request.scope_key))) finish(run, 'aborted')
    }
    return db.delete(botSessions).where(and(eq(botSessions.bot_id, botId),
      scopes ? inArray(botSessions.scope_key, scopes) : undefined)).run().changes
  }

  function bridgeEvent(connection: BridgeConnection, event: BridgeUp) {
    if (!('run_id' in event)) return
    const run = byRunId.get(event.run_id)
    if (!run || run.bridge !== connection) return
    if (event.type === 'run.delta') applyDelta(run, event)
    if (event.type === 'run.done') finish(run, 'done', undefined, event.external_session_id)
    if (event.type === 'run.error') finish(run, 'error', event.error)
  }

  function disconnect(connection: BridgeConnection) {
    for (const run of [...active.values()]) if (run.bridge === connection) finish(run, 'error', 'Bridge connection lost')
  }

  function abortQueuedRow(messageId: string) {
    const removed = db.delete(queuedRuns).where(eq(queuedRuns.message_id, messageId)).returning().get()
    if (!removed) return false
    const updated = db.update(messages).set({ status: 'aborted', updated_at: Date.now() })
      .where(eq(messages.id, messageId)).returning().get()
    if (updated) realtime.publish({ type: 'message.updated', message: chat.dto(updated) }, updated.channel_id)
    return true
  }

  function abort(userId: string, isAdmin: boolean, messageId: string) {
    const message = chat.messageRow(messageId)
    chat.access(message.channel_id, userId)
    const run = active.get(messageId)
    if (run) {
      const bot = db.select().from(bots).where(eq(bots.user_id, run.botId)).get()
      if (!isAdmin && userId !== run.request.sender.id && userId !== bot?.owner_id) {
        fail(403, 'FORBIDDEN', 'Only the sender, bot owner or an administrator can abort this run')
      }
      finish(run, 'aborted')
      return
    }
    const queued = db.select().from(queuedRuns).where(eq(queuedRuns.message_id, messageId)).get()
    if (!queued) return
    const bot = db.select().from(bots).where(eq(bots.user_id, queued.bot_id)).get()
    if (!isAdmin && userId !== queued.sender_id && userId !== bot?.owner_id) {
      fail(403, 'FORBIDDEN', 'Only the sender, bot owner or an administrator can abort this run')
    }
    abortQueuedRow(messageId)
  }

  function cancelMessages(ids: Set<string>) {
    for (const id of ids) {
      const run = active.get(id)
      if (run) finish(run, 'aborted')
      else abortQueuedRow(id)
    }
  }

  function cancelBot(id: string, channelId?: string) {
    for (const run of [...active.values()]) {
      if (run.botId === id && (!channelId || run.channelId === channelId)) finish(run, 'aborted')
    }
    const queued = db.select({ message_id: queuedRuns.message_id }).from(queuedRuns)
      .where(and(eq(queuedRuns.bot_id, id), channelId ? eq(queuedRuns.channel_id, channelId) : undefined)).all()
    for (const item of queued) abortQueuedRow(item.message_id)
  }

  function close() {
    closed = true
    for (const run of [...active.values()]) finish(run, 'aborted')
  }

  return { trigger, drainQueued, regenerate, respond, botPostHops, resetSessions, bridgeEvent, disconnect, abort, cancelMessages, cancelBot, close }
}
