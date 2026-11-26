import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { WebSocket } from 'ws'
import type { BridgeDown, BridgeFsList, BridgeRuntime, BridgeUp, ClientDown, Member } from '@chiorim/shared'
import { publicUser } from './chat.js'
import { bots, channelMembers, users } from './db.js'
import type { Database } from './db.js'
import { ApiFailure } from './errors.js'
import type { LocalRunner } from './local-runner.js'

export type BridgeConnection = { ws: WebSocket; runtime?: BridgeRuntime }
export type ClientConnection = { ws: WebSocket; userId: string; sessionId: string }

export function writeSocket(ws: WebSocket, data: ClientDown | BridgeDown) {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount > 4_000_000) { ws.terminate(); return false }
  ws.send(JSON.stringify(data), error => { if (error) ws.terminate() })
  return true
}

export function createRealtime(db: Database, localRunner?: LocalRunner) {
  const clients = new Set<ClientConnection>()
  const bridges = new Map<string, BridgeConnection>()
  const fsPending = new Map<string, {
    botId: string
    resolve: (result: BridgeFsList) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  function publish(event: ClientDown, channelId?: string, nonceOwner?: string) {
    const audience = channelId ? new Set(db.select({ id: channelMembers.user_id }).from(channelMembers)
      .where(eq(channelMembers.channel_id, channelId)).all().map(row => row.id)) : undefined
    for (const client of clients) {
      if (audience && !audience.has(client.userId)) continue
      if (event.type === 'message.created' && event.client_nonce && client.userId !== nonceOwner) {
        writeSocket(client.ws, { type: event.type, message: event.message })
      } else {
        writeSocket(client.ws, event)
      }
    }
  }

  function direct(userId: string, event: ClientDown) {
    for (const client of clients) if (client.userId === userId) writeSocket(client.ws, event)
  }

  const clientIds = () => new Set([...clients].filter(client => client.ws.readyState === WebSocket.OPEN).map(client => client.userId))
  const runtime = (id: string) => {
    const bridge = bridges.get(id)
    if (bridge?.ws.readyState === WebSocket.OPEN && bridge.runtime) return bridge.runtime
    if (localRunner?.enabled) {
      const row = db.select({ user: users, bot: bots }).from(bots)
        .innerJoin(users, eq(bots.user_id, users.id))
        .where(eq(bots.user_id, id)).get()
      if (row && !row.user.disabled && row.bot.mode === 'local') return localRunner.runtimeMeta(row.bot)
    }
    return undefined
  }
  const allRuntimes = (): Record<string, BridgeRuntime> => {
    const map: Record<string, BridgeRuntime> = {}
    for (const [id, bridge] of bridges) {
      if (bridge.ws.readyState === WebSocket.OPEN && bridge.runtime) map[id] = bridge.runtime
    }
    if (localRunner?.enabled) {
      const locals = db.select({ user: users, bot: bots }).from(bots)
        .innerJoin(users, eq(bots.user_id, users.id))
        .where(eq(bots.mode, 'local')).all()
      for (const { user, bot } of locals) {
        if (user.disabled) continue
        const meta = localRunner.runtimeMeta(bot)
        if (meta) map[user.id] = meta
      }
    }
    return map
  }
  const online = (id: string) => members([id])[0]?.online ?? false

  function members(ids?: string[]): Member[] {
    const connected = clientIds()
    return db.select({ user: users, bot: bots }).from(users).leftJoin(bots, eq(users.id, bots.user_id))
      .where(and(ids === undefined ? undefined : inArray(users.id, ids),
        or(eq(users.kind, 'human'), isNotNull(bots.user_id)))).orderBy(users.username).all().map(({ user, bot }) => {
        const meta = user.disabled
          ? undefined
          : bot?.mode === 'local'
            ? localRunner?.runtimeMeta(bot)
            : (bridges.get(user.id)?.ws.readyState === WebSocket.OPEN ? bridges.get(user.id)?.runtime : undefined)
        return {
          ...publicUser(user), online: !user.disabled && (Boolean(meta) || connected.has(user.id) || Boolean(bot?.mode === 'provider' && bot.provider_id && bot.model)),
          bot: bot ? { mode: bot.mode, model: bot.model, driver_hint: bot.driver_hint, runtime_meta: meta ?? null } : null,
        }
      })
  }

  function memberUpdated(id: string) {
    const [member] = members([id])
    if (member) publish({ type: 'member.updated', member })
  }

  function hello(id: string, bridge: BridgeConnection, meta: BridgeRuntime) {
    if (bridges.get(id) !== bridge) return
    bridge.runtime = meta
    db.update(bots).set({ runtime_meta_json: meta }).where(eq(bots.user_id, id)).run()
    publish({ type: 'presence.update', user_id: id, online: true, runtime_meta: meta })
  }

  function detach(id: string, bridge: BridgeConnection) {
    if (bridges.get(id) !== bridge) return
    bridges.delete(id)
    for (const [reqId, pending] of fsPending) {
      if (pending.botId !== id) continue
      clearTimeout(pending.timer)
      fsPending.delete(reqId)
      pending.reject(new ApiFailure(503, 'DEVICE_OFFLINE', 'Device disconnected'))
    }
    db.update(bots).set({ runtime_meta_json: null }).where(eq(bots.user_id, id)).run()
    if (bridge.runtime) publish({ type: 'presence.update', user_id: id, online: false })
  }

  function listBridgeFs(botId: string, path?: string): Promise<BridgeFsList> {
    const bot = db.select({ bot: bots, user: users }).from(bots)
      .innerJoin(users, eq(bots.user_id, users.id))
      .where(eq(bots.user_id, botId)).get()
    if (bot && !bot.user.disabled && bot.bot.mode === 'local') {
      if (!localRunner?.enabled) return Promise.reject(new ApiFailure(403, 'LOCAL_AGENT_DISABLED', 'Local agent execution is disabled on this server'))
      try {
        return Promise.resolve(localRunner.listFs(path, bot.bot.local_cwd))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new ApiFailure(400, 'INVALID_PATH', 'Failed to list local directory'))
      }
    }
    const bridge = bridges.get(botId)
    if (!bridge?.runtime || bridge.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ApiFailure(503, 'DEVICE_OFFLINE', 'Selected device is currently offline'))
    }
    const request_id = randomUUID()
    return new Promise<BridgeFsList>((resolve, reject) => {
      const timer = setTimeout(() => {
        fsPending.delete(request_id)
        reject(new ApiFailure(504, 'BRIDGE_TIMEOUT', 'Device did not respond in time'))
      }, 8_000)
      fsPending.set(request_id, { botId, resolve, reject, timer })
      if (!writeSocket(bridge.ws, { type: 'fs.list', request_id, ...(path ? { path } : {}) })) {
        clearTimeout(timer)
        fsPending.delete(request_id)
        reject(new ApiFailure(503, 'DEVICE_OFFLINE', 'Device connection lost'))
      }
    })
  }

  function resolveBridgeFs(botId: string, event: Extract<BridgeUp, { type: 'fs.list.result' }>) {
    const pending = fsPending.get(event.request_id)
    if (!pending || pending.botId !== botId) return
    clearTimeout(pending.timer)
    fsPending.delete(event.request_id)
    if (event.error) pending.reject(new ApiFailure(400, 'INVALID_PATH', event.error))
    else pending.resolve({ path: event.path, parent: event.parent, entries: event.entries })
  }

  function closeBridge(id: string, reason: string) {
    const bridge = bridges.get(id)
    if (!bridge) return
    detach(id, bridge)
    bridge.ws.close(4001, reason)
  }

  return { clients, bridges, closeBridge, publish, direct, clientIds, runtime, allRuntimes, online, members, memberUpdated, hello, detach, listBridgeFs, resolveBridgeFs }
}
