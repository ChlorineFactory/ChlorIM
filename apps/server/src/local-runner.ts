import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { readSse } from '@chiorim/shared'
import type { BridgeFsList, BridgeRuntime, Delta, LocalAgentStatus, LocalDriverName, PermissionMode, RunStart, ToolCall } from '@chiorim/shared'
import type { BotRow } from './db.js'
import { ApiFailure } from './errors.js'

export type LocalAgentOptions = {
  enabled?: boolean
  allowedRoots?: string[]
  defaultCwd?: string
  env?: Record<string, string | undefined>
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.svelte-kit', '__pycache__', '.DS_Store', '.Trash'])
const DRIVER_BINARIES: Record<LocalDriverName, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'agy',
  hermes: 'hermes',
}

function expandHome(value: string) {
  return resolve(value.replace(/^~(?=\/|$)/, () => homedir()))
}

function isWithinRoots(targetReal: string, roots: string[]) {
  return roots.some(rootReal => {
    const rel = relative(rootReal, targetReal)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

function hasExecutable(binary: string, env: NodeJS.ProcessEnv) {
  const pathValue = env.PATH ?? ''
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, binary + ext)
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        if (statSync(candidate).isFile()) return true
      } catch { /* Try next directory */ }
    }
  }
  return false
}

const conversationPrompt = (request: RunStart) => JSON.stringify({
  sender: request.sender,
  channel_context: request.external_session_id ? undefined : request.channel_context,
  recent_messages: request.external_session_id ? undefined : request.context.slice(0, -1),
  message: request.prompt,
})

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const str = (value: unknown) => typeof value === 'string' ? value : undefined

function toolEvent(emit: (delta: Delta) => void, tool: ToolCall) {
  emit({ part: tool.status === 'running' ? 'tool_start' : 'tool_end', tool })
}

function sessionArgument(id: string) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid CLI session ID')
  return id
}

async function* processJson(
  executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, input: string,
): AsyncGenerator<Record<string, unknown>> {
  signal.throwIfAborted()
  const useGroup = process.platform !== 'win32'
  const child = spawn(executable, args, {
    cwd, env, detached: useGroup, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let spawnError: Error | undefined
  let forceKill: NodeJS.Timeout | undefined
  let exited = false
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolveExit => {
    child.once('error', (error: Error) => { spawnError = error })
    child.once('close', (code, exitSignal) => { exited = true; resolveExit({ code, signal: exitSignal }) })
  })

  function kill(sig: NodeJS.Signals) {
    if (!child.pid) return
    try {
      if (useGroup) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(sig)
    }
  }

  function abort() {
    if (forceKill) return
    kill('SIGTERM')
    forceKill = setTimeout(() => kill('SIGKILL'), 1000)
  }

  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  function parseLine(line: string) {
    if (line.length > 1_000_000) throw new Error('Driver output line exceeded the limit')
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('Expected valid JSONL from the local CLI') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSONL object from the local CLI')
    return value as Record<string, unknown>
  }

  try {
    for await (const chunk of child.stdout) {
      signal.throwIfAborted()
      buffer += decoder.write(chunk as Buffer)
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      if (buffer.length > 1_000_000) throw new Error('Driver output line exceeded the limit')
      for (const line of lines) if (line.trim()) yield parseLine(line)
    }
    buffer += decoder.end()
    if (buffer.trim()) yield parseLine(buffer)
    const result = await exit
    signal.throwIfAborted()
    if (spawnError) {
      throw new Error((spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Local CLI "${executable}" was not found in PATH on this server. Install it on this machine or switch to Remote Bridge mode.`
        : `Could not start local CLI "${executable}"`, { cause: spawnError })
    }
    if (result.code !== 0) {
      const sanitized = stderr.trim()
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/chior_(?:bot|wh)_[a-f0-9]+/gi, '[REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
        .slice(-300)
      const detail = sanitized ? `: ${sanitized}` : ''
      throw new Error(`${executable} exited with ${result.code ?? result.signal}${detail}`)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (!exited) {
      abort()
      await exit
    }
    if (forceKill) {
      clearTimeout(forceKill)
      kill('SIGKILL')
    }
  }
}

async function runCodex(
  request: RunStart, cwd: string, env: NodeJS.ProcessEnv, permissionMode: PermissionMode,
  model: string | null, signal: AbortSignal, emit: (delta: Delta) => void,
) {
  const sandbox = permissionMode === 'readonly' ? 'read-only' : 'workspace-write'
  const approval = permissionMode === 'auto' ? 'never' : 'on-request'
  const args = ['--ask-for-approval', approval, 'exec', '--sandbox', sandbox, '--skip-git-repo-check', '--json']
  if (model) args.push('-m', model)
  if (request.external_session_id) args.push('resume', sessionArgument(request.external_session_id))
  args.push('-')
  let session: string | undefined
  let done = false
  for await (const event of processJson('codex', args, cwd, env, signal, conversationPrompt(request))) {
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
}

async function runClaude(
  request: RunStart, cwd: string, env: NodeJS.ProcessEnv, permissionMode: PermissionMode,
  model: string | null, signal: AbortSignal, emit: (delta: Delta) => void,
) {
  const permission = { readonly: 'plan', default: 'default', auto: 'acceptEdits' }[permissionMode]
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', permission]
  if (model) args.push('--model', model)
  if (request.external_session_id) args.push('--resume', sessionArgument(request.external_session_id))
  let session: string | undefined
  let result = false
  let emittedText = false
  let streamingMessage = false
  const tools = new Map<string, ToolCall>()
  for await (const entry of processJson('claude', args, cwd, env, signal, conversationPrompt(request))) {
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
}

async function runAntigravity(
  request: RunStart, cwd: string, env: NodeJS.ProcessEnv, permissionMode: PermissionMode,
  model: string | null, signal: AbortSignal, emit: (delta: Delta) => void,
) {
  const mode = { readonly: 'plan', default: 'accept-edits', auto: 'auto' }[permissionMode]
  const args = ['-p', '--output-format', 'stream-json', '--mode', mode, '--input-format', 'stream-json']
  if (model) args.push('--model', model)
  if (request.external_session_id) args.push('--conversation', sessionArgument(request.external_session_id))
  const input = JSON.stringify({ event: 'user', message: { content: conversationPrompt(request) } }) + '\n'
  let session: string | undefined
  let complete = false
  let emittedText = false
  const previousTools = new Map<string, ToolCall>()
  for await (const event of processJson('agy', args, cwd, env, signal, input)) {
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
    const tool = {
      id: key, name: toolName, status, input: info.parameters ?? info.input ?? step.tool_input ?? previous?.input,
      output: info.output ?? info.error ?? step.tool_output,
    } satisfies ToolCall
    previousTools.set(key, tool)
    if (!previous || previous.status !== status || JSON.stringify(previous) !== JSON.stringify(tool)) toolEvent(emit, tool)
  }
  if (!complete) throw new Error('Antigravity CLI exited without a result event')
  return session
}

async function runHermes(
  request: RunStart, env: NodeJS.ProcessEnv, model: string | null, signal: AbortSignal, emit: (delta: Delta) => void,
) {
  const endpoint = (env.HERMES_ENDPOINT ?? 'http://127.0.0.1:8642/v1/chat/completions').replace(/\/$/, '')
  const url = endpoint.endsWith('/chat/completions') ? endpoint : endpoint + '/chat/completions'
  const apiKey = env.HERMES_API_KEY
  const response = await fetch(url, {
    method: 'POST', signal, redirect: 'error',
    headers: {
      'Content-Type': 'application/json', 'X-Hermes-Session-Id': request.scope_key,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: model || 'hermes-agent', stream: true,
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
}

function parseRepoUrl(raw: string): { url: string; defaultName: string } {
  const value = raw.trim()
  if (!value || value.startsWith('-') || /[\s\0]/.test(value) || value.includes('..')) {
    throw new ApiFailure(400, 'INVALID_REPO', 'Invalid Git repository URL or owner/repo shorthand')
  }
  let url = value
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    url = `https://github.com/${value.replace(/\.git$/, '')}.git`
  } else if (!/^https?:\/\/[A-Za-z0-9._-]+(?::\d+)?\/[A-Za-z0-9_./-]+(?:\.git)?$/.test(value)
    && !/^git@[A-Za-z0-9._-]+:[A-Za-z0-9_./-]+(?:\.git)?$/.test(value)) {
    throw new ApiFailure(400, 'INVALID_REPO', 'Use GitHub owner/repo, https://..., or git@host:owner/repo')
  }
  const tail = url.replace(/\/+$/, '').split(/[/:]/).filter(Boolean).at(-1)?.replace(/\.git$/, '') ?? ''
  if (!tail || tail === '.' || tail === '..' || /[\\/\0]/.test(tail)) {
    throw new ApiFailure(400, 'INVALID_REPO', 'Could not determine repository folder name')
  }
  return { url, defaultName: tail }
}

function sanitizeGitError(stderr: string) {
  return stderr.trim()
    .replace(/https?:\/\/[^@\s/]+@/gi, 'https://[REDACTED]@')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(-300)
}

export function createLocalRunner(options: LocalAgentOptions = {}) {
  const enabled = options.enabled ?? true
  const customEnv = options.env
  const botTokens = new Map<string, string>()
  const tokenToBot = new Map<string, string>()
  let loopbackUrl: string | undefined
  const mergedEnv = (): NodeJS.ProcessEnv => customEnv ? { ...process.env, ...customEnv } : { ...process.env }

  function setServerUrl(url: string) { loopbackUrl = url }
  function tokenForBot(botId: string) {
    let token = botTokens.get(botId)
    if (!token) {
      token = `chior_bot_${randomBytes(32).toString('hex')}`
      botTokens.set(botId, token)
      tokenToBot.set(token, botId)
    }
    return token
  }
  function botIdForToken(token: string) { return tokenToBot.get(token) }

  function allowedRoots(): string[] {
    const raw = options.allowedRoots?.length ? options.allowedRoots : [homedir(), process.cwd()]
    const seen = new Set<string>()
    const resolved: string[] = []
    for (const root of raw) {
      try {
        const real = realpathSync(expandHome(root))
        if (statSync(real).isDirectory() && !seen.has(real)) {
          seen.add(real)
          resolved.push(real)
        }
      } catch { /* Ignore missing root directories */ }
    }
    return resolved
  }

  function defaultCwd(): string {
    if (options.defaultCwd) {
      try {
        const real = realpathSync(expandHome(options.defaultCwd))
        const roots = allowedRoots()
        if (statSync(real).isDirectory() && isWithinRoots(real, roots)) return real
      } catch { /* Fall back to first allowed root */ }
    }
    return allowedRoots()[0] ?? homedir()
  }

  function homeDir(): string {
    try {
      const homeReal = realpathSync(homedir())
      if (isWithinRoots(homeReal, allowedRoots())) return homeReal
    } catch { /* Fall back to defaultCwd */ }
    return defaultCwd()
  }

  function resolveDir(target?: string | null, fallback?: string | null): string {
    const candidateRaw = target?.trim() || fallback?.trim() || defaultCwd()
    const candidate = expandHome(candidateRaw)
    let targetReal: string
    try {
      if (!statSync(candidate).isDirectory()) throw new Error('not a directory')
      targetReal = realpathSync(candidate)
    } catch {
      throw new ApiFailure(400, 'INVALID_PATH', `Directory "${candidateRaw}" does not exist on this server`)
    }
    const roots = allowedRoots()
    if (!roots.length || !isWithinRoots(targetReal, roots)) {
      throw new ApiFailure(400, 'INVALID_PATH', `Directory "${candidateRaw}" is outside allowed local roots`)
    }
    return targetReal
  }

  function listFs(requestedPath?: string, botDefaultCwd?: string | null, defaultToHome = false): BridgeFsList {
    if (!enabled) throw new ApiFailure(403, 'LOCAL_AGENT_DISABLED', 'Local agent execution is disabled on this server')
    const roots = allowedRoots()
    if (!requestedPath?.trim() && !defaultToHome) {
      const entries = roots.map(root => ({ name: basename(root) || root, path: root, kind: 'dir' as const }))
      return { path: '', parent: null, entries }
    }
    const dirReal = resolveDir(requestedPath?.trim() || (defaultToHome ? homeDir() : undefined), botDefaultCwd)
    const rawEntries = readdirSync(dirReal, { withFileTypes: true })
    const entries: BridgeFsList['entries'] = []
    for (const item of rawEntries) {
      if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
      const full = join(dirReal, item.name)
      try {
        const real = realpathSync(full)
        if (!isWithinRoots(real, roots)) continue
        if (statSync(real).isDirectory()) entries.push({ name: item.name, path: real, kind: 'dir' })
      } catch { /* Skip unreadable entries */ }
      if (entries.length >= 200) break
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const up = dirname(dirReal)
    const parent = up !== dirReal && isWithinRoots(up, roots) ? up : (!defaultToHome && roots.length > 1 ? '' : null)
    return { path: dirReal, parent, entries }
  }

  function mkdir(parentPath: string, name: string) {
    if (!enabled) throw new ApiFailure(403, 'LOCAL_AGENT_DISABLED', 'Local agent execution is disabled on this server')
    const trimmed = name.trim()
    if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed)) {
      throw new ApiFailure(400, 'INVALID_NAME', 'Invalid folder name')
    }
    const parentReal = resolveDir(parentPath)
    const target = join(parentReal, trimmed)
    if (existsSync(target)) throw new ApiFailure(409, 'ALREADY_EXISTS', `Folder "${trimmed}" already exists`)
    try {
      mkdirSync(target, { recursive: false })
    } catch (error) {
      throw new ApiFailure(400, 'FS_ERROR', error instanceof Error ? error.message : 'Failed to create folder')
    }
    const real = realpathSync(target)
    if (!isWithinRoots(real, allowedRoots())) {
      rmSync(real, { recursive: true, force: true })
      throw new ApiFailure(400, 'INVALID_PATH', 'Created folder escapes allowed local roots')
    }
    return { path: real, name: basename(real) }
  }

  function removeDir(targetPath: string) {
    if (!enabled) throw new ApiFailure(403, 'LOCAL_AGENT_DISABLED', 'Local agent execution is disabled on this server')
    const candidate = expandHome(targetPath.trim())
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(candidate) }
    catch { throw new ApiFailure(404, 'NOT_FOUND', 'Folder does not exist') }
    if (stat.isSymbolicLink()) throw new ApiFailure(400, 'INVALID_PATH', 'Refusing to delete symbolic links')
    if (!stat.isDirectory()) throw new ApiFailure(400, 'INVALID_PATH', 'Target is not a directory')
    const targetReal = realpathSync(candidate)
    const roots = allowedRoots()
    if (!roots.length || !isWithinRoots(targetReal, roots)) {
      throw new ApiFailure(400, 'INVALID_PATH', 'Folder is outside allowed local roots')
    }
    const protectedDirs = new Set<string>([...roots, resolve('/'), realpathSync(process.cwd())])
    try { protectedDirs.add(realpathSync(homedir())) } catch { /* ignore */ }
    if (protectedDirs.has(targetReal)) {
      throw new ApiFailure(400, 'PROTECTED_PATH', 'Cannot delete a root or home directory')
    }
    try {
      rmSync(targetReal, { recursive: true, force: false })
    } catch (error) {
      throw new ApiFailure(400, 'FS_ERROR', error instanceof Error ? error.message : 'Failed to delete folder')
    }
    return { ok: true as const }
  }

  async function cloneRepo(parentPath: string, repo: string, dirName?: string) {
    if (!enabled) throw new ApiFailure(403, 'LOCAL_AGENT_DISABLED', 'Local agent execution is disabled on this server')
    const parentReal = resolveDir(parentPath)
    const { url, defaultName } = parseRepoUrl(repo)
    const targetName = (dirName?.trim() || defaultName).trim()
    if (!targetName || targetName === '.' || targetName === '..' || /[\\/\0]/.test(targetName)) {
      throw new ApiFailure(400, 'INVALID_NAME', 'Invalid target folder name')
    }
    const targetPath = join(parentReal, targetName)
    if (existsSync(targetPath)) throw new ApiFailure(409, 'ALREADY_EXISTS', `Folder "${targetName}" already exists`)
    const env = { ...mergedEnv(), GIT_TERMINAL_PROMPT: '0' }
    await new Promise<void>((resolveClone, rejectClone) => {
      const child = spawn('git', ['clone', '--', url, targetName], {
        cwd: parentReal, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        rejectClone(new ApiFailure(504, 'CLONE_TIMEOUT', 'git clone timed out after 120 seconds'))
      }, 120_000)
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        rejectClone(new ApiFailure(500, 'GIT_UNAVAILABLE', error.code === 'ENOENT' ? 'git is not installed on this server' : 'Failed to start git'))
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (code === 0) resolveClone()
        else rejectClone(new ApiFailure(400, 'CLONE_FAILED', sanitizeGitError(stderr) || `git clone exited with code ${code}`))
      })
    })
    const real = realpathSync(targetPath)
    return { path: real, name: basename(real) }
  }

  let cachedDrivers: { at: number; value: LocalAgentStatus['drivers'] } | undefined
  function detectDrivers(): LocalAgentStatus['drivers'] {
    if (!customEnv && cachedDrivers && Date.now() - cachedDrivers.at < 15_000) return cachedDrivers.value
    const env = mergedEnv()
    const value: LocalAgentStatus['drivers'] = {
      codex: { available: hasExecutable(DRIVER_BINARIES.codex, env), binary: DRIVER_BINARIES.codex },
      'claude-code': { available: hasExecutable(DRIVER_BINARIES['claude-code'], env), binary: DRIVER_BINARIES['claude-code'] },
      antigravity: { available: hasExecutable(DRIVER_BINARIES.antigravity, env), binary: DRIVER_BINARIES.antigravity },
      hermes: { available: Boolean(env.HERMES_ENDPOINT) || hasExecutable(DRIVER_BINARIES.hermes, env), binary: DRIVER_BINARIES.hermes },
    }
    if (!customEnv) cachedDrivers = { at: Date.now(), value }
    return value
  }

  function status(): LocalAgentStatus {
    return {
      enabled,
      hostname: hostname().slice(0, 255),
      default_cwd: defaultCwd(),
      allowed_roots: allowedRoots(),
      drivers: detectDrivers(),
    }
  }

  function runtimeMeta(bot: BotRow): BridgeRuntime | undefined {
    if (!enabled || bot.mode !== 'local') return undefined
    const driver = (bot.driver_hint && bot.driver_hint !== 'custom' ? bot.driver_hint : 'codex') as LocalDriverName
    let cwd = defaultCwd()
    if (bot.local_cwd) {
      try { cwd = resolveDir(bot.local_cwd) } catch { /* Fall back to defaultCwd */ }
    }
    return {
      hostname: hostname().slice(0, 255),
      driver,
      cwd,
      allowed_roots: allowedRoots(),
      version: 'local',
    }
  }

  async function run(
    bot: BotRow, request: RunStart, signal: AbortSignal, emit: (delta: Delta) => void,
    extraEnv?: Record<string, string>,
  ): Promise<string | undefined> {
    if (!enabled) throw new Error('Local agent execution is disabled on this server')
    const driver = (bot.driver_hint ?? 'codex') as LocalDriverName
    if (!(['codex', 'claude-code', 'antigravity', 'hermes'] as const).includes(driver)) {
      throw new Error(`Unsupported local agent driver: ${String(bot.driver_hint)}`)
    }
    const cwd = resolveDir(request.work_dir, bot.local_cwd)
    const apiEnv: Record<string, string> = {
      ...(loopbackUrl ? { CHIORIM_URL: loopbackUrl, CHIORIM_TOKEN: tokenForBot(bot.user_id) } : {}),
      CHIORIM_CHANNEL_ID: request.channel_id,
      ...(extraEnv ?? {}),
    }
    const env = { ...mergedEnv(), ...apiEnv }
    const permission = bot.permission_mode ?? 'default'
    switch (driver) {
      case 'codex': return runCodex(request, cwd, env, permission, bot.model, signal, emit)
      case 'claude-code': return runClaude(request, cwd, env, permission, bot.model, signal, emit)
      case 'antigravity': return runAntigravity(request, cwd, env, permission, bot.model, signal, emit)
      case 'hermes': return runHermes(request, env, bot.model, signal, emit)
    }
  }

  return {
    enabled, allowedRoots, defaultCwd, homeDir, resolveDir, listFs, mkdir, removeDir, cloneRepo,
    status, runtimeMeta, run, setServerUrl, tokenForBot, botIdForToken,
  }
}

export type LocalRunner = ReturnType<typeof createLocalRunner>
