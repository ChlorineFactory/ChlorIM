import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { deltaSchema, readSse } from '@chiorim/shared'
import type { Delta, RunStart, ToolCall } from '@chiorim/shared'
import type { AgentConfig } from './config.js'
import { processJson } from './process.js'

export interface AgentDriver {
  run(request: RunStart, config: AgentConfig, signal: AbortSignal, emit: (delta: Delta) => void): Promise<string | undefined>
}

const conversationPrompt = (request: RunStart) => JSON.stringify({
  sender: request.sender,
  channel_context: request.external_session_id ? undefined : request.channel_context,
  recent_messages: request.external_session_id ? undefined : request.context.slice(0, -1),
  message: request.prompt,
})

const unified = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('thinking'), delta: z.string() }),
  z.object({ type: z.literal('tool_start'), tool: deltaSchema.shape.tool.unwrap() }),
  z.object({ type: z.literal('tool_end'), tool: deltaSchema.shape.tool.unwrap() }),
  z.object({ type: z.literal('done'), external_session_id: z.string().min(1).max(1024).optional() }),
  z.object({ type: z.literal('error'), error: z.string().min(1).max(4000) }),
])

async function runUnified(command: string, args: string[], request: RunStart, config: AgentConfig, signal: AbortSignal, emit: (delta: Delta) => void) {
  let done = false
  let session: string | undefined
  for await (const value of processJson(command, args, config, signal, JSON.stringify(request) + '\n')) {
    const parsed = unified.safeParse(value)
    if (!parsed.success || done) throw new Error('Invalid driver JSONL event')
    const { type, ...event } = parsed.data
    if (parsed.data.type === 'error') throw new Error(parsed.data.error)
    if (parsed.data.type === 'done') {
      session = parsed.data.external_session_id
      done = true
    } else {
      emit({ part: type as Delta['part'], ...event })
    }
  }
  if (!done) throw new Error('Driver exited without a done event')
  return session
}

const custom: AgentDriver = {
  async run(request, config, signal, emit) {
    if (!config.command) throw new Error('Custom driver needs a command in bridge.yaml')
    return runUnified(config.command, config.args, request, config, signal, emit)
  },
}

const hermes: AgentDriver = {
  async run(request, config, signal, emit) {
    const endpoint = (config.endpoint ?? 'http://127.0.0.1:8642/v1/chat/completions').replace(/\/$/, '')
    const url = endpoint.endsWith('/chat/completions') ? endpoint : endpoint + '/chat/completions'
    const response = await fetch(url, {
      method: 'POST', signal, redirect: 'error',
      headers: {
        'Content-Type': 'application/json', 'X-Hermes-Session-Id': request.scope_key,
        ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: config.model ?? 'hermes-agent', stream: true,
        messages: [{ role: 'user', content: conversationPrompt(request) }],
      }),
    })
    let received = false
    for await (const data of readSse(response)) {
      if (data === '[DONE]') return request.scope_key
      const value = JSON.parse(data) as {
        error?: unknown
        choices?: { delta?: { reasoning_content?: string; reasoning?: string; content?: string } }[]
      }
      if (value.error) throw new Error('Hermes reported a stream error')
      const delta = value.choices?.[0]?.delta
      const thinking = delta?.reasoning_content ?? delta?.reasoning
      if (typeof thinking === 'string' && thinking) emit({ part: 'thinking', delta: thinking })
      if (typeof delta?.content === 'string' && delta.content) emit({ part: 'text', delta: delta.content })
      received = true
    }
    if (!received) throw new Error('Hermes returned an empty stream')
    return request.scope_key
  },
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const str = (value: unknown) => typeof value === 'string' ? value : undefined
function toolEvent(emit: (delta: Delta) => void, tool: ToolCall) {
  emit({ part: tool.status === 'running' ? 'tool_start' : 'tool_end', tool })
}

function sessionArgument(id: string) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid CLI session ID')
  return id
}

const antigravity: AgentDriver = {
  async run(request, config, signal, emit) {
    const python = () => runUnified('python3',
      [fileURLToPath(new URL('../runners/antigravity_runner.py', import.meta.url)), config.permission_mode],
      request, config, signal, emit)
    if (config.env.CHIOR_ANTIGRAVITY_BACKEND === 'python') return python()

    const mode = { readonly: 'plan', default: 'accept-edits', auto: 'auto' }[config.permission_mode]
    const args = ['-p', '--output-format', 'stream-json', '--mode', mode, '--input-format', 'stream-json']
    if (config.model) args.push('--model', config.model)
    if (request.external_session_id) args.push('--conversation', sessionArgument(request.external_session_id))
    const input = JSON.stringify({ event: 'user', message: { content: conversationPrompt(request) } }) + '\n'
    let session: string | undefined
    let complete = false
    let emittedText = false
    const previousTools = new Map<string, ToolCall>()
    try {
      for await (const event of processJson('agy', args, config, signal, input)) {
        const name = event.event ?? event.type
        const step = object(event.step_update ?? event.step)
        const result = object(event.result)
        session = str(result.conversation_id) || str(step.conversation_id) || str(event.conversation_id) || session
        if (name === 'result') {
          if (result.status !== 'SUCCESS' || result.error) throw new Error('Antigravity CLI reported a failed run')
          if (!emittedText && typeof result.response === 'string' && result.response) emit({ part: 'text', delta: result.response })
          complete = true
          continue
        }
        if (name !== 'step_update') continue
        const kind = str(step.step_type) ?? ''
        const thinking = str(step.thinking_delta) ?? str(step.thought_delta) ?? str(step.reasoning_delta) ??
          (/think|reason/i.test(kind) ? str(step.text_delta) : undefined)
        if (thinking) emit({ part: 'thinking', delta: thinking })
        if (kind === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
          emit({ part: 'text', delta: step.text_delta })
          emittedText = true
        }
        const info = object(step.tool_info ?? step.tool)
        const key = str(info.id) ?? str(step.tool_id) ?? (typeof step.step_index === 'number' ? String(step.step_index) : undefined)
        const previous = key ? previousTools.get(key) : undefined
        const toolName = str(step.tool_name) ?? str(info.name) ?? previous?.name
        if (!key || !toolName) continue
        const state = String(step.state ?? '').toUpperCase()
        const status = /ERROR|FAIL|CANCEL|DENI/.test(state) || info.error ? 'error' : state === 'DONE' ? 'done' : 'running'
        const tool = { id: key, name: toolName, status, input: info.parameters ?? info.input ?? step.tool_input ?? previous?.input,
          output: info.output ?? info.error ?? step.tool_output } satisfies ToolCall
        previousTools.set(key, tool)
        if (!previous || previous.status !== status || JSON.stringify(previous) !== JSON.stringify(tool)) toolEvent(emit, tool)
      }
    } catch (error) {
      if (error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return python()
      throw error
    }
    if (!complete) throw new Error('Antigravity CLI exited without a result event')
    return session
  },
}

const claude: AgentDriver = {
  async run(request, config, signal, emit) {
    const permission = { readonly: 'plan', default: 'default', auto: 'acceptEdits' }[config.permission_mode]
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', permission]
    if (config.model) args.push('--model', config.model)
    if (request.external_session_id) args.push('--resume', sessionArgument(request.external_session_id))
    let session: string | undefined
    let result = false
    let emittedText = false
    let streamingMessage = false
    const tools = new Map<string, ToolCall>()
    for await (const entry of processJson('claude', args, config, signal, conversationPrompt(request))) {
      session = str(entry.session_id) ?? session
      switch (entry.type) {
        case 'stream_event': {
          const event = object(entry.event)
          if (event.type === 'message_start') streamingMessage = false
          if (event.type === 'content_block_delta') {
            const delta = object(event.delta)
            if (typeof delta.text === 'string') { emit({ part: 'text', delta: delta.text }); emittedText = true; streamingMessage = true }
            if (typeof delta.thinking === 'string') { emit({ part: 'thinking', delta: delta.thinking }); streamingMessage = true }
          }
          if (event.type === 'content_block_start') {
            const block = object(event.content_block)
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !tools.has(block.id)) {
              const tool = { id: block.id, name: block.name, input: block.input, status: 'running' as const }
              tools.set(tool.id, tool)
              toolEvent(emit, tool)
            }
          }
          break
        }
        case 'assistant': {
          const content = object(entry.message).content
          if (!Array.isArray(content)) break
          for (const raw of content) {
            const block = object(raw)
            if (!streamingMessage && block.type === 'text' && typeof block.text === 'string') {
              emit({ part: 'text', delta: block.text }); emittedText = true
            }
            if (!streamingMessage && block.type === 'thinking' && typeof block.thinking === 'string') {
              emit({ part: 'thinking', delta: block.thinking })
            }
            if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
              const tool = { id: block.id, name: block.name, input: block.input, status: 'running' as const }
              if (!tools.has(tool.id)) toolEvent(emit, tool)
              tools.set(tool.id, tool)
            }
          }
          streamingMessage = false
          break
        }
        case 'user': {
          const content = object(entry.message).content
          if (!Array.isArray(content)) break
          for (const raw of content) {
            const block = object(raw)
            const tool = typeof block.tool_use_id === 'string' ? tools.get(block.tool_use_id) : undefined
            if (tool && block.type === 'tool_result') {
              toolEvent(emit, { ...tool, output: block.content, status: block.is_error ? 'error' : 'done' })
              tools.delete(tool.id)
            }
          }
          break
        }
        case 'result':
          if (entry.is_error || entry.subtype !== 'success') throw new Error('Claude Code reported a failed run')
          if (!emittedText && typeof entry.result === 'string') emit({ part: 'text', delta: entry.result })
          result = true
          break
      }
    }
    if (!result) throw new Error('Claude Code exited without a result event')
    return session
  },
}

const codex: AgentDriver = {
  async run(request, config, signal, emit) {
    const sandbox = config.permission_mode === 'readonly' ? 'read-only' : 'workspace-write'
    const approval = config.permission_mode === 'auto' ? 'never' : 'on-request'
    const args = ['--ask-for-approval', approval, 'exec', '--sandbox', sandbox, '--skip-git-repo-check', '--json']
    if (config.model) args.push('-m', config.model)
    if (request.external_session_id) args.push('resume', sessionArgument(request.external_session_id))
    args.push('-')
    let session: string | undefined
    let done = false
    for await (const event of processJson('codex', args, config, signal, conversationPrompt(request))) {
      if (event.type === 'thread.started') session = str(event.thread_id)
      if (event.type === 'turn.failed') throw new Error('Codex reported a failed run')
      if (event.type === 'turn.completed') done = true
      if (event.type !== 'item.started' && event.type !== 'item.completed') continue
      const item = object(event.item)
      if (item.type === 'agent_message' || item.type === 'reasoning') {
        if (event.type === 'item.completed' && typeof item.text === 'string') {
          emit({ part: item.type === 'agent_message' ? 'text' : 'thinking', delta: item.text })
        }
        continue
      }
      if (typeof item.id !== 'string') continue
      const toolType = str(item.type) ?? 'tool'
      toolEvent(emit, {
        id: item.id, name: str(item.tool) ?? toolType,
        input: item.command ?? item.arguments ?? item.query ?? item.changes,
        output: item.aggregated_output ?? item.result ?? item.error,
        status: event.type === 'item.started' ? 'running' : item.status === 'failed' || item.error ? 'error' : 'done',
      })
    }
    if (!done) throw new Error('Codex exited without a turn.completed event')
    return session
  },
}

export const drivers: Record<AgentConfig['driver'], AgentDriver> = {
  'claude-code': claude, codex, hermes, antigravity, custom,
}
