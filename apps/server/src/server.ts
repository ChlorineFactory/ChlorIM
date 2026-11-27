import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { getRequestListener } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import type { RawData, WebSocket } from 'ws'
import { bridgeUpSchema, clientUpSchema } from '@chiorim/shared'
import { createApp } from './app.js'
import type { App, ServerOptions } from './app.js'
import { bearer, COOKIE } from './auth.js'
import { maintainDatabase } from './db.js'
import type { OpenDatabase } from './db.js'
import { ApiFailure, fail, parse } from './errors.js'
import type { BridgeConnection, ClientConnection } from './realtime.js'
import { writeSocket } from './realtime.js'

function json(data: RawData, binary: boolean) {
  if (binary) fail(400, 'INVALID_FRAME', 'Expected a JSON text frame')
  try { return JSON.parse(data.toString()) as unknown }
  catch { return fail(400, 'INVALID_JSON', 'Expected a JSON text frame') }
}

function reject(socket: Duplex, status: '400 Bad Request' | '401 Unauthorized' | '403 Forbidden' | '404 Not Found') {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function cookieToken(request: IncomingMessage) {
  return request.headers.cookie?.split(';').map(entry => entry.trim()).find(entry => entry.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
}

type ChiorServer = OpenDatabase & { app: App; server: Server; close(): Promise<void> }

export function createChiorServer(options: ServerOptions = {}): ChiorServer {
  const { app, identity, sessionById, botIdentity, allowedOrigin, sqlite, db, chat, engine, realtime, localRunner } = createApp(options)
  const server = createServer(getRequestListener(app.fetch))
  server.on('listening', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object' && addr.port) {
      localRunner.setServerUrl(`http://127.0.0.1:${addr.port}`)
    }
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
  const lastSeen = new Map<WebSocket, number>()
  let closing = false

  function touch(ws: WebSocket) {
    if (lastSeen.has(ws)) lastSeen.set(ws, Date.now())
  }

  function track(ws: WebSocket) {
    lastSeen.set(ws, Date.now())
    ws.on('pong', () => touch(ws))
    ws.on('ping', () => touch(ws))
    ws.on('close', () => lastSeen.delete(ws))
    ws.on('error', () => ws.terminate())
  }

  server.on('upgrade', (request, socket, head) => {
    if (closing) return reject(socket, '400 Bad Request')
    let url: URL
    try { url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`) }
    catch { return reject(socket, '400 Bad Request') }
    if (url.pathname === '/ws/client') {
      // A TLS-terminating proxy forwards the same Host and an HTTPS Origin.
      const origin = request.headers.origin
      const fwdHost = typeof request.headers['x-forwarded-host'] === 'string' ? request.headers['x-forwarded-host'] : undefined
      const fwdProto = typeof request.headers['x-forwarded-proto'] === 'string' ? request.headers['x-forwarded-proto'].split(',')[0]?.trim() : undefined
      if (!allowedOrigin(origin, url.origin, fwdHost, fwdProto) && !allowedOrigin(origin, url.origin.replace(/^http:/, 'https:'), fwdHost, fwdProto)) {
        return reject(socket, '403 Forbidden')
      }
      const token = cookieToken(request)
      const auth = identity(token) ?? identity(url.searchParams.get('token') ?? undefined)
      if (!auth) return reject(socket, '401 Unauthorized')
      if (auth.user.disabled) return reject(socket, '403 Forbidden')
      wss.handleUpgrade(request, socket, head, ws => {
        track(ws)
        const userId = auth.user.id
        const alreadyOnline = realtime.online(userId)
        const connection: ClientConnection = { ws, userId, sessionId: auth.sessionId }
        realtime.clients.add(connection)
        ws.on('close', () => {
          realtime.clients.delete(connection)
          if (!closing && !realtime.online(userId)) realtime.publish({ type: 'presence.update', user_id: userId, online: false })
        })
        const bridgeRuntimes = realtime.allRuntimes()
        writeSocket(ws, { type: 'ready', user: auth.user,
          online_user_ids: realtime.members().filter(member => member.online).map(member => member.id), bridge_runtimes: bridgeRuntimes })
        if (!alreadyOnline) realtime.publish({ type: 'presence.update', user_id: userId, online: true })
        ws.on('message', (raw, binary) => {
          touch(ws)
          if (closing || ws.readyState !== ws.OPEN) return
          const current = sessionById(connection.sessionId)
          if (!current || current.user.disabled) {
            ws.close(4001, 'Session ended')
            return
          }
          let nonce: string | undefined
          try {
            const event = parse(clientUpSchema, json(raw, binary))
            switch (event.type) {
              case 'ping': writeSocket(ws, { type: 'pong' }); break
              case 'message.send': {
                nonce = event.client_nonce
                const result = chat.send(current.user, event.channel_id, event, nonce)
                engine.trigger(result.row)
                break
              }
              case 'message.abort': engine.abort(userId, current.user.is_admin, event.message_id); break
              case 'read.ack': chat.read(userId, event.channel_id, event.last_read_message_id); break
              case 'typing':
                chat.access(event.channel_id, userId)
                chat.root(event.channel_id, event.thread_root_id)
                realtime.publish({ ...event, user_id: userId }, event.channel_id)
                break
            }
          } catch (error) {
            const failure = error instanceof ApiFailure ? error : new ApiFailure(500, 'INTERNAL_ERROR', 'Internal server error')
            writeSocket(ws, { type: 'error', ...failure.response(), client_nonce: nonce })
          }
        })
      })
      return
    }
    if (url.pathname === '/ws/bridge') {
      const auth = botIdentity(bearer(request.headers.authorization))
      if (!auth || auth.bot.mode !== 'bridge') return reject(socket, '401 Unauthorized')
      const { user } = auth
      if (user.disabled) return reject(socket, '403 Forbidden')
      wss.handleUpgrade(request, socket, head, ws => {
        track(ws)
        const old = realtime.bridges.get(user.id)
        if (old) {
          realtime.detach(user.id, old)
          engine.disconnect(old)
          old.ws.close(4001, 'Replaced by a new Bridge connection')
        }
        const connection: BridgeConnection = { ws }
        realtime.bridges.set(user.id, connection)
        const helloDeadline = setTimeout(() => ws.close(1008, 'Expected bridge.hello'), 10_000)
        ws.on('close', () => {
          clearTimeout(helloDeadline)
          if (closing) return
          realtime.detach(user.id, connection)
          engine.disconnect(connection)
        })
        writeSocket(ws, { type: 'bridge.welcome', bot_id: user.id, username: user.username, display_name: user.display_name })
        ws.on('message', (raw, binary) => {
          touch(ws)
          if (closing || realtime.bridges.get(user.id) !== connection) return
          try {
            const event = parse(bridgeUpSchema, json(raw, binary))
            if (event.type === 'bridge.hello') {
              clearTimeout(helloDeadline)
              const { type: _, ...meta } = event
              realtime.hello(user.id, connection, meta)
              engine.drainQueued(user.id)
            } else if (connection.runtime && event.type === 'fs.list.result') {
              realtime.resolveBridgeFs(user.id, event)
            } else if (connection.runtime) {
              engine.bridgeEvent(connection, event)
            } else {
              ws.close(1008, 'Expected bridge.hello')
            }
          } catch (error) {
            console.warn('Closing bridge socket due to invalid frame:', error instanceof Error ? error.message : String(error))
            ws.close(1008, 'Invalid Bridge frame')
          }
        })
      })
      return
    }
    reject(socket, '404 Not Found')
  })

  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const client of realtime.clients) {
      const current = sessionById(client.sessionId, false)
      if (!current || current.user.disabled) client.ws.close(4001, 'Session ended')
    }
    for (const [ws, seenAt] of lastSeen) {
      if (now - seenAt > 90_000) { ws.terminate(); continue }
      if (ws.readyState !== ws.OPEN) continue
      ws.ping()
    }
    for (const bridge of realtime.bridges.values()) writeSocket(bridge.ws, { type: 'ping' })
  }, 25_000)
  heartbeat.unref()

  const maintenance = setInterval(() => {
    maintainDatabase(sqlite, false)
  }, 30 * 60_000)
  maintenance.unref()

  let closePromise: Promise<void> | undefined
  function close() {
    if (closePromise) return closePromise
    closing = true
    clearInterval(heartbeat)
    clearInterval(maintenance)
    engine.close()
    for (const ws of lastSeen.keys()) ws.terminate()
    wss.close()
    closePromise = new Promise<void>((resolve, rejectClose) => {
      server.close(error => {
        maintainDatabase(sqlite, true)
        sqlite.close()
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error)
        else resolve()
      })
    })
    return closePromise
  }
  return { app, server, close, db, sqlite }
}
