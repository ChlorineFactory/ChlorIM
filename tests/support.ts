import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect } from 'vitest'
import { WebSocket } from 'ws'
import { clientDownSchema } from '@chiorim/shared'
import type { AuthResponse, Channel, ClientDown } from '@chiorim/shared'
import type { ServerOptions } from '../apps/server/src/app.js'
import { createChiorServer } from '../apps/server/src/server.js'

const cleanups: (() => unknown)[] = []
export const cleanup = (fn: () => unknown) => cleanups.push(fn)
afterEach(async () => {
  const errors: unknown[] = []
  while (cleanups.length) {
    try { await cleanups.pop()!() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors)
})

export async function harness(options: ServerOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'chiorim-test-'))
  cleanup(() => rmSync(dataDir, { recursive: true, force: true }))
  const instance = createChiorServer({ dataDir, rateLimit: false, webDistDir: join(dataDir, 'web'), ...options })
  cleanup(instance.close)
  instance.server.listen(0, '127.0.0.1')
  await once(instance.server, 'listening')
  const url = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
  const wsUrl = url.replace(/^http/, 'ws')
  function raw(method: string, path: string, token?: string, payload?: unknown, extra?: HeadersInit) {
    const headers = new Headers(extra)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (payload !== undefined && !(payload instanceof FormData)) headers.set('Content-Type', 'application/json')
    return fetch(url + path, {
      method, headers, body: payload instanceof FormData ? payload : payload === undefined ? undefined : JSON.stringify(payload),
    })
  }
  async function api<T>(method: string, path: string, token?: string, payload?: unknown, status = 200): Promise<T> {
    const response = await raw(method, path, token, payload)
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(status)
    return result as T
  }
  const person = (username: string, invite_code?: string) =>
    api<AuthResponse>('POST', '/api/auth/register', undefined, { username, display_name: username.toUpperCase(), password: 'chior-password', invite_code }, 201)
  const invite = async (token: string, max_uses = 1) =>
    (await api<{ code: string }>('POST', '/api/invites', token, { max_uses }, 201)).code
  const general = async (token: string) => (await api<Channel[]>('GET', '/api/channels', token)).find(channel => channel.name === 'general')!
  return { ...instance, url, wsUrl, dataDir, raw, api, person, invite, general }
}

export async function upstream(handler: RequestListener) {
  const server = createServer(handler)
  cleanup(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export function socket(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, { headers })
  ws.on('error', () => {})
  cleanup(async () => {
    if (ws.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>(resolve => { ws.once('close', () => resolve()) })
    ws.terminate()
    await closed
  })
  return ws
}

export function client(wsUrl: string, token: string, useCookie = false) {
  const ws = useCookie
    ? socket(`${wsUrl}/ws/client`, { Cookie: `chior_session=${token}`, Origin: 'http://localhost:5173' })
    : socket(`${wsUrl}/ws/client?token=${token}`)
  const events: ClientDown[] = []
  ws.on('message', raw => events.push(clientDownSchema.parse(JSON.parse(raw.toString()))))
  return { ws, events }
}
