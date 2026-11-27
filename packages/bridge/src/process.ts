import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentConfig } from './config.js'

function augmentedPath(env: NodeJS.ProcessEnv) {
  const home = env.HOME?.trim() || homedir()
  const dirs = new Set<string>((env.PATH ?? '').split(delimiter).map(d => d.trim()).filter(Boolean))
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.volta', 'bin'),
    join(home, '.fnm', 'current', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.mise', 'shims'),
    join(home, '.cargo', 'bin'),
    join(home, 'bin'),
  ]
  if (process.platform !== 'win32') extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin')
  try {
    const nvmDir = join(home, '.nvm', 'versions', 'node')
    for (const ver of readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 3)) {
      extra.push(join(nvmDir, ver, 'bin'))
    }
  } catch { /* nvm not installed */ }
  for (const dir of extra) {
    try { if (statSync(dir).isDirectory()) dirs.add(dir) } catch { /* ignore */ }
  }
  return [...dirs].join(delimiter)
}

/** Runs a single executable with a separate process group so cancellation reaches descendants. */
export async function* processJson(
  executable: string, args: string[], config: AgentConfig, signal: AbortSignal, input: string,
): AsyncGenerator<Record<string, unknown>> {
  signal.throwIfAborted()
  const useGroup = process.platform !== 'win32'
  const baseEnv = { ...process.env, ...config.env }
  const env = config.env.PATH !== undefined ? baseEnv : { ...baseEnv, PATH: augmentedPath(baseEnv) }
  const child = spawn(executable, args, {
    cwd: config.cwd, env, detached: useGroup, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let spawnError: Error | undefined
  let forceKill: NodeJS.Timeout | undefined
  let exited = false
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('error', (error: Error) => { spawnError = error })
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) })
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
    try { value = JSON.parse(line) } catch { throw new Error('Expected valid JSONL from the driver') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSONL object from the driver')
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
        ? `Could not start ${executable}. Check that the executable and working directory exist.`
        : `Could not start ${executable}`, { cause: spawnError })
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
      // The leader may exit while children continue running in the same group.
      clearTimeout(forceKill)
      kill('SIGKILL')
    }
  }
}
