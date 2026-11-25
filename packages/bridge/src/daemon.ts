import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { appendFileSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { WebSocket } from 'ws'
import { bridgeDownSchema, bridgeUpSchema } from '@chiorim/shared'
import type { BridgeUp, RunStart } from '@chiorim/shared'
import { expandHome, readConfig, resolvedAgent, writePrivate } from './config.js'
import type { BridgePaths } from './config.js'
import { drivers } from './drivers.js'

type ResolvedAgent = ReturnType<typeof resolvedAgent>
type Status = { name: string; driver: string; cwd: string; connected: boolean; active_tasks: number }
const CHECK_INTERVAL = 10_000
const HEARTBEAT_TIMEOUT = 60_000

function startTime(pid: number) {
  return spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout?.trim()
}

export function daemonPid(path: string) {
  try {
    const [rawPid, started] = readFileSync(path, 'utf8').trim().split('\n')
    const pid = Number(rawPid)
    if (Number.isSafeInteger(pid) && pid > 1 && started && startTime(pid) === started) return pid
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return undefined
}

export function reloadDaemon(path: string) {
  const pid = daemonPid(path)
  if (!pid) return false
  try { process.kill(pid, 'SIGHUP'); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return false
  }
}

function claimPid(path: string) {
  const started = startTime(process.pid)
  if (!started) throw new Error('Could not identify the Bridge process')
  const temp = `${path}.${process.pid}.new`
  try {
    writeFileSync(temp, `${process.pid}\n${started}\n`, { mode: 0o600, flag: 'wx' })
    try { linkSync(temp, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = statSync(path)
      if (daemonPid(path)) throw new Error('A Bridge daemon is already running for this configuration directory')
      if (statSync(path).ino === previous.ino) rmSync(path)
      linkSync(temp, path)
    }
  } finally { rmSync(temp, { force: true }) }
}

function connectAgent(config: ResolvedAgent, changed: () => void, log: (message: string) => void) {
  const url = new URL(config.server)
  if (!url.pathname.endsWith('/ws/bridge')) url.pathname = url.pathname.replace(/\/$/, '') + '/ws/bridge'
  const tasks = new Map<string, { controller: AbortController; promise: Promise<unknown> }>()
  let stopped = false
  let connected = false
  let socket: WebSocket | undefined
  let timer: NodeJS.Timeout | undefined
  let failures = 0
  let activity = Date.now()

  function send(ws: WebSocket, event: BridgeUp) {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 4_000_000) { ws.terminate(); return }
    const parsed = bridgeUpSchema.safeParse(event)
    if (!parsed.success) throw new Error('Driver emitted an invalid event')
    ws.send(JSON.stringify(parsed.data), error => { if (error) ws.terminate() })
  }

  function resolveRunCwd(workDir?: string) {
    if (!workDir) return config.cwd
    const candidate = expandHome(workDir)
    let targetReal: string
    try {
      if (!statSync(candidate).isDirectory()) throw new Error('not a directory')
      targetReal = realpathSync(candidate)
    } catch {
      throw new Error(`Channel work_dir "${workDir}" does not exist or is not a directory on this machine`)
    }
    const roots = config.allowed_roots.length ? config.allowed_roots : [config.cwd]
    const permitted = roots.some(root => {
      try {
        const rootReal = realpathSync(root)
        const rel = relative(rootReal, targetReal)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      } catch { return false }
    })
    if (!permitted) {
      throw new Error(`Channel work_dir "${workDir}" is outside allowed_roots in bridge.yaml`)
    }
    return targetReal
  }

  function execute(ws: WebSocket, request: RunStart) {
    if (tasks.has(request.run_id)) return
    if (!config.allowed_users.includes('*') && !config.allowed_users.includes(request.sender.username)) {
      send(ws, { type: 'run.error', run_id: request.run_id, error: 'Sender is not in this Agent’s allowed_users list' })
      return
    }
    let effectiveCwd: string
    try {
      effectiveCwd = resolveRunCwd(request.work_dir)
    } catch (error) {
      send(ws, { type: 'run.error', run_id: request.run_id, error: error instanceof Error ? error.message : 'Invalid work_dir' })
      return
    }
    const runConfig = effectiveCwd === config.cwd ? config : { ...config, cwd: effectiveCwd }
    const controller = new AbortController()
    const promise = Promise.resolve().then(async () => {
      const external_session_id = await drivers[config.driver].run(request, runConfig, controller.signal, event => {
        controller.signal.throwIfAborted()
        if (event.delta && event.delta.length > 64_000) {
          for (let offset = 0; offset < event.delta.length; offset += 64_000) {
            send(ws, { ...event, delta: event.delta.slice(offset, offset + 64_000), type: 'run.delta', run_id: request.run_id })
          }
        } else {
          send(ws, { ...event, type: 'run.delta', run_id: request.run_id })
        }
      })
      if (!controller.signal.aborted) send(ws, { type: 'run.done', run_id: request.run_id, external_session_id })
    }).catch(error => {
      if (!controller.signal.aborted) send(ws, { type: 'run.error', run_id: request.run_id,
        error: ((error instanceof Error ? error.message : '') || 'Agent execution failed').slice(0, 4000) })
    }).finally(() => {
      tasks.delete(request.run_id)
      if (!stopped) changed()
    })
    tasks.set(request.run_id, { controller, promise })
    changed()
  }

  function open() {
    if (stopped) return
    activity = Date.now()
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.token}` }, handshakeTimeout: 10_000, maxPayload: 32 * 1024 * 1024,
    })
    socket = ws
    ws.on('error', () => {})
    ws.on('ping', () => { activity = Date.now() })
    ws.on('pong', () => { activity = Date.now() })
    ws.on('message', (raw, binary) => {
      activity = Date.now()
      if (stopped || socket !== ws) return
      try {
        if (binary) throw new Error('Expected a text frame')
        const event = bridgeDownSchema.parse(JSON.parse(raw.toString()))
        if (event.type === 'bridge.welcome') {
          send(ws, { type: 'bridge.hello', hostname: hostname().slice(0, 255), driver: config.driver, cwd: config.cwd, version: '0.1.0' })
          connected = true
          failures = 0
          log(`${config.name} connected`)
          changed()
        } else if (event.type === 'ping') {
          send(ws, { type: 'pong' })
        } else if (connected && event.type === 'run.abort') {
          tasks.get(event.run_id)?.controller.abort()
        } else if (connected && event.type === 'run.start') {
          execute(ws, event)
        }
      } catch {
        log(`${config.name} received an invalid server frame`)
        ws.close(1008, 'Invalid server frame')
      }
    })
    ws.on('close', (code) => {
      if (socket !== ws || stopped) return
      socket = undefined
      connected = false
      for (const task of tasks.values()) task.controller.abort()
      changed()
      const delay = Math.min(30_000, 500 * 2 ** Math.min(failures++, 8))
      log(`${config.name} disconnected (${code}). Reconnecting.`)
      timer = setTimeout(open, Math.round(delay * (0.8 + Math.random() * 0.2)))
    })
  }

  const heartbeat = setInterval(() => {
    if (socket && Date.now() - activity > HEARTBEAT_TIMEOUT) socket.terminate()
    else if (socket?.readyState === WebSocket.OPEN) socket.ping()
  }, CHECK_INTERVAL)
  open()
  return {
    config,
    status: (): Status => ({ name: config.name, driver: config.driver, cwd: config.cwd, connected, active_tasks: tasks.size }),
    async stop() {
      stopped = true
      connected = false
      clearInterval(heartbeat)
      if (timer) clearTimeout(timer)
      socket?.terminate()
      for (const task of tasks.values()) task.controller.abort()
      await Promise.allSettled([...tasks.values()].map(task => task.promise))
    },
  }
}

export function startDaemon(paths: BridgePaths) {
  const config = readConfig(paths.config)
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  claimPid(paths.pid)
  const agents = new Map<string, ReturnType<typeof connectAgent>>()
  const retired = new Set<Promise<void>>()
  let running = true
  const log = (message: string) => appendFileSync(paths.log, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })

  function writeStatus() {
    writePrivate(paths.status, JSON.stringify({
      pid: process.pid, running, updated_at: Date.now(), agents: [...agents.values()].map(agent => agent.status()),
    }, null, 2) + '\n')
  }

  function apply(next: ReturnType<typeof readConfig>) {
    const desired = new Map(next.agents.map(agent => [agent.name, resolvedAgent(agent, next, paths.directory)]))
    for (const [name, connection] of agents) {
      if (isDeepStrictEqual(connection.config, desired.get(name))) { desired.delete(name); continue }
      agents.delete(name)
      const stopping = connection.stop().finally(() => retired.delete(stopping))
      retired.add(stopping)
    }
    for (const [name, agent] of desired) agents.set(name, connectAgent(agent, writeStatus, log))
    writeStatus()
  }

  try {
    apply(config)
    log('Bridge started')
  } catch (error) {
    for (const agent of agents.values()) void agent.stop()
    rmSync(paths.pid, { force: true })
    throw error
  }

  let stopping: Promise<void> | undefined
  return {
    reload() {
      if (!running) return
      try { apply(readConfig(paths.config)); log('Configuration reloaded') }
      catch { log('Configuration reload failed. Check bridge.yaml.') }
    },
    stop() {
      return stopping ??= (async () => {
        running = false
        try {
          await Promise.all([...agents.values()].map(agent => agent.stop()).concat([...retired]))
          writeStatus()
          log('Bridge stopped')
        } finally { rmSync(paths.pid, { force: true }) }
      })()
    },
  }
}
