import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type { Context } from 'hono'
import type { User } from '@chiorim/shared'
import { COOKIE, bearer, registerAuth, requestToken } from './auth.js'
import { createChat } from './chat.js'
import { registerChat } from './chat-routes.js'
import { openDatabase } from './db.js'
import type { OpenDatabase } from './db.js'
import { createEngine } from './engine.js'
import { ApiFailure, fail } from './errors.js'
import { registerManagement } from './management.js'
import { createRealtime } from './realtime.js'
import { createSecretBox, loadSecret } from './security.js'
import { registerUploads } from './uploads.js'
import { botTokenPattern, createIdentity } from './identity.js'
import { createRateLimits } from './rate-limit.js'
import { registerStatic } from './static.js'
import { registerWebhooks } from './webhooks.js'

export type App = Hono<{ Variables: { user: User; sessionId: string; recheckAuth?: () => void } }>
export type ServerOptions = {
  dataDir?: string
  database?: string
  appSecret?: string
  corsOrigins?: string[]
  secureCookies?: boolean
  uploadLimit?: number
  bridgePublicUrl?: string
  rateLimit?: boolean
  publicUploads?: boolean
  webDistDir?: string
}

export type Services = OpenDatabase & {
  realtime: ReturnType<typeof createRealtime>
  chat: ReturnType<typeof createChat>
  engine: ReturnType<typeof createEngine>
  secret: ReturnType<typeof createSecretBox>
  dataDir: string
  secureCookies: boolean
  limits: ReturnType<typeof createRateLimits>
  bridgePublicUrl?: string
}

type ChiorApp = Services & ReturnType<typeof createIdentity> & {
  app: App
  allowedOrigin(origin: string | undefined, self: string): boolean
}

function createServices(options: ServerOptions): Services {
  const dataDir = resolve(options.dataDir ?? 'data')
  const secret = createSecretBox(loadSecret(dataDir, options.appSecret))
  const { db, sqlite } = openDatabase(options.database ?? resolve(dataDir, 'chiorim.db'))
  const realtime = createRealtime(db)
  const chat = createChat(db, realtime.publish, realtime.direct)
  const engine = createEngine(db, chat, realtime, secret, dataDir)
  return { db, sqlite, realtime, chat, engine, secret, dataDir, limits: createRateLimits(options.rateLimit ?? true), secureCookies: options.secureCookies ?? false, bridgePublicUrl: options.bridgePublicUrl }
}

export function createApp(options: ServerOptions = {}): ChiorApp {
  const services = createServices(options)
  const origins = new Set(options.corsOrigins ?? ['http://localhost:5173'])
  const allowedOrigin = (origin: string | undefined, self: string) => !origin || origin === self || origins.has(origin)
  const uploadLimit = options.uploadLimit ?? 10 * 1024 * 1024
  const publicUploads = options.publicUploads ?? false
  const app: App = new Hono()
  const auth = createIdentity(services.db)

  function refreshCookie(c: Context, token: string | undefined, expiresAt: number) {
    if (token && token === getCookie(c, COOKIE) && !c.res.headers.has('Set-Cookie')) {
      setCookie(c, COOKIE, token, {
        httpOnly: true, sameSite: 'Lax', path: '/', secure: services.secureCookies,
        maxAge: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      })
    }
  }

  function optionalUser(c: Context) {
    const token = requestToken(c)
    const session = auth.identity(token)
    if (!session || session.user.disabled) return null
    refreshCookie(c, token, session.expiresAt)
    return session.user
  }

  async function requireSession(c: Context, next: () => Promise<void>) {
    const token = requestToken(c)
    function validate(touch: boolean) {
      const session = touch ? auth.identity(token) : auth.sessionById(c.get('sessionId'), false)
      if (!session) fail(401, 'UNAUTHENTICATED', 'Sign in required')
      if (session.user.disabled) fail(403, 'ACCOUNT_DISABLED', 'Account is disabled')
      c.set('user', session.user)
      c.set('sessionId', session.sessionId)
      return session
    }
    const session = validate(true)
    c.set('recheckAuth', () => { validate(false) })
    c.header('Cache-Control', 'no-store')
    await next()
    refreshCookie(c, token, session.expiresAt)
  }

  app.onError((error, c) => {
    if (error instanceof ApiFailure) return c.json(error.response(), error.status)
    console.error('Unhandled HTTP error:', error instanceof Error ? error.name : 'Unknown')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  })
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404))
  const browserCors = cors({
    origin: (origin, c) => allowedOrigin(origin, new URL(c.req.url).origin) ? origin : undefined,
    credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
  app.use('/api/*', browserCors)
  app.use('/uploads/*', browserCors)
  app.use('/api/*', async (c, next) => {
    const url = new URL(c.req.url)
    const method = c.req.method
    const path = url.pathname
    const incomingWebhook = method === 'POST' && /^\/api\/webhooks\/in\/[^/]+$/.test(path)
    if (method !== 'GET' && method !== 'HEAD' && !incomingWebhook && !allowedOrigin(c.req.header('Origin'), url.origin)) {
      fail(403, 'ORIGIN_DENIED', 'Origin is not permitted')
    }
    if (((method === 'GET' || method === 'HEAD') && ['/api/health', '/api/auth/bootstrap', '/api/auth/session'].includes(path)) ||
        (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) || incomingWebhook) {
      return next()
    }
    const authorization = bearer(c.req.header('Authorization'))
    if (authorization && botTokenPattern.test(authorization)) {
      const validate = () => {
        const bot = auth.botIdentity(authorization)
        if (!bot) fail(401, 'UNAUTHENTICATED', 'Invalid Bot token')
        if (bot.user.disabled) fail(403, 'ACCOUNT_DISABLED', 'Account is disabled')
        c.set('user', bot.user)
      }
      validate()
      c.set('recheckAuth', validate)
      const read = method === 'GET' && (
        ['/api/channels', '/api/search', '/api/users'].includes(path) || /^\/api\/channels\/[^/]+\/(?:messages|members)$/.test(path)
      )
      const write = (method === 'POST' && (path === '/api/uploads' || /^\/api\/channels\/[^/]+\/messages$/.test(path)))
        || (method === 'PATCH' && /^\/api\/messages\/[^/]+$/.test(path))
      if (!read && !write) fail(403, 'FORBIDDEN', 'Bot token cannot access this endpoint')
      c.header('Cache-Control', 'no-store')
      return next()
    }
    return requireSession(c, next)
  })
  if (!publicUploads) app.use('/uploads/*', requireSession)
  app.use('/api/*', (c, next) => bodyLimit({
    maxSize: c.req.path === '/api/uploads' ? uploadLimit + 65_536 : 1024 * 1024,
    onError: () => fail(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the limit'),
  })(c, next))

  app.get('/api/health', c => {
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true as const, uptime_s: Math.floor(process.uptime()) })
  })
  registerAuth(app, services, optionalUser)
  const chatRoutes = registerChat(app, services)
  registerManagement(app, services, chatRoutes)
  registerWebhooks(app, services)
  registerUploads(app, services.dataDir, uploadLimit, publicUploads)
  const defaultWebDir = import.meta.url.includes('/$bunfs/')
    ? resolve(process.cwd(), 'web')
    : fileURLToPath(new URL('../../web/dist', import.meta.url))
  registerStatic(app, options.webDistDir ?? defaultWebDir)
  return { app, allowedOrigin, ...auth, ...services }
}
