import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { WebSocket } from 'ws'
import type { BridgeDown, BridgeRuntime, ClientDown, Member } from '@chiorim/shared'
import { publicUser } from './chat.js'
import { bots, channelMembers, users } from './db.js'
import type { Database } from './db.js'

export type BridgeConnection = { ws: WebSocket; runtime?: BridgeRuntime }
export type ClientConnection = { ws: WebSocket; userId: string; sessionId: string }

export function writeSocket(ws: WebSocket, data: ClientDown | BridgeDown) {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount > 4_000_000) { ws.terminate(); return false }
  ws.send(JSON.stringify(data), error => { if (error) ws.terminate() })
  return true
}

export function createRealtime(db: Database) {
  const clients = new Set<ClientConnection>()
  const bridges = new Map<string, BridgeConnection>()

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
    return bridge?.ws.readyState === WebSocket.OPEN ? bridge.runtime : undefined
  }
  const online = (id: string) => members([id])[0]?.online ?? false

  function members(ids?: string[]): Member[] {
    const connected = clientIds()
    return db.select({ user: users, bot: bots }).from(users).leftJoin(bots, eq(users.id, bots.user_id))
      .where(and(ids === undefined ? undefined : inArray(users.id, ids),
        or(eq(users.kind, 'human'), isNotNull(bots.user_id)))).orderBy(users.username).all().map(({ user, bot }) => {
        const meta = user.disabled ? undefined : runtime(user.id)
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
    db.update(bots).set({ runtime_meta_json: null }).where(eq(bots.user_id, id)).run()
    if (bridge.runtime) publish({ type: 'presence.update', user_id: id, online: false })
  }

  function closeBridge(id: string, reason: string) {
    const bridge = bridges.get(id)
    if (!bridge) return
    detach(id, bridge)
    bridge.ws.close(4001, reason)
  }

  return { clients, bridges, closeBridge, publish, direct, clientIds, runtime, online, members, memberUpdated, hello, detach }
}
