import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { adminResetPasswordSchema, adminUserPatchSchema, changePasswordSchema, inviteCreateSchema, loginSchema, profilePatchSchema, registerSchema } from '@chiorim/shared'
import { publicUser } from './chat.js'
import { channelMembers, channels, invites, sessions, users } from './db.js'
import { body, fail } from './errors.js'
import { checkPassword, hashPassword, randomHex, sha256 } from './security.js'
import { SESSION_SECONDS } from './identity.js'
import { clientIp } from './rate-limit.js'
import type { App, Services } from './app.js'

export const COOKIE = 'chior_session'
export const bearer = (value?: string) => /^Bearer ([^\s]+)$/i.exec(value ?? '')?.[1]
export const adminOnly = (user: { is_admin: boolean }) => {
  if (!user.is_admin) fail(403, 'FORBIDDEN', 'Administrator access required')
}

export function registerAuth(app: App, { db, chat, realtime, engine, secureCookies, limits }: Services, optionalUser: (c: Context) => ReturnType<typeof publicUser> | null) {
  const initialized = () => Boolean(db.select({ id: users.id }).from(users).where(eq(users.kind, 'human')).get())
  const cookieOptions = { httpOnly: true, sameSite: 'Lax' as const, path: '/', secure: secureCookies }

  function loginResponse(c: Context, user: typeof users.$inferSelect) {
    const token = randomHex()
    const now = Date.now()
    db.transaction(() => {
      db.delete(sessions).where(lte(sessions.expires_at, now)).run()
      db.insert(sessions).values({
        id: sha256(token), user_id: user.id, expires_at: now + SESSION_SECONDS * 1000, created_at: now,
        last_active_at: now, user_agent: (c.req.header('User-Agent') ?? '').slice(0, 1024), ip_address: clientIp(c),
      }).run()
    })
    setCookie(c, COOKIE, token, { ...cookieOptions, maxAge: SESSION_SECONDS })
    c.header('Cache-Control', 'no-store')
    return { user: publicUser(user), token }
  }

  function revoke(userId: string, except?: string) {
    return db.delete(sessions).where(and(eq(sessions.user_id, userId), except ? ne(sessions.id, except) : undefined))
      .returning({ id: sessions.id }).all()
  }

  function disconnect(rows: { id: string }[]) {
    const ids = new Set(rows.map(row => row.id))
    for (const client of realtime.clients) if (ids.has(client.sessionId)) client.ws.close(4001, 'Session ended')
  }

  function human(id: string) {
    const user = db.select().from(users).where(and(eq(users.id, id), eq(users.kind, 'human'))).get()
    if (!user) fail(404, 'USER_NOT_FOUND', 'Human user not found')
    return user
  }

  app.get('/api/auth/session', c => {
    c.header('Cache-Control', 'no-store')
    return c.json({ initialized: initialized(), user: optionalUser(c) })
  })
  app.get('/api/auth/bootstrap', c => c.json({ initialized: initialized() }))
  app.post('/api/auth/register', async c => {
    limits.register(c, clientIp(c))
    const input = await body(c, registerSchema)
    const password_hash = await hashPassword(input.password)
    const user = db.transaction(() => {
      const first = !initialized()
      const invite = input.invite_code ? db.select().from(invites).where(eq(invites.code, input.invite_code)).get() : undefined
      const now = Date.now()
      if (!first && (!invite || invite.used_count >= invite.max_uses || (invite.expires_at !== null && invite.expires_at <= now))) {
        fail(403, 'INVALID_INVITE', 'An active invite is required')
      }
      if (db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get()) {
        fail(409, 'USERNAME_TAKEN', 'Username is already in use')
      }
      const row = db.insert(users).values({
        id: randomUUID(), kind: 'human', username: input.username, display_name: input.display_name,
        password_hash, is_admin: first, created_at: now,
      }).returning().get()
      if (!first && invite) db.update(invites).set({ used_count: invite.used_count + 1 }).where(eq(invites.code, invite.code)).run()
      if (first) {
        const home = chat.createWorkspace(row.id, { name: '客厅', icon: 'CH', color: '#1e3a34' })
        chat.createChannel(row.id, { type: 'public', name: 'general', workspace_id: home.id }, [])
        chat.createChannel(row.id, { type: 'board', name: '留言板', workspace_id: home.id }, [])
      } else {
        for (const channel of db.select().from(channels).where(inArray(channels.type, ['public', 'board'])).all()) {
          chat.addMembers(channel.id, [row.id], now)
        }
      }
      return row
    }, { behavior: 'immediate' })
    const response = loginResponse(c, user)
    realtime.memberUpdated(user.id)
    for (const channel of db.select().from(channels).where(inArray(channels.type, ['public', 'board'])).all()) chat.notifyChannel(channel.id)
    return c.json(response, 201)
  })
  app.post('/api/auth/login', async c => {
    const input = await body(c, loginSchema)
    limits.login(c, JSON.stringify([clientIp(c), input.username]))
    const user = db.select().from(users).where(and(eq(users.username, input.username), eq(users.kind, 'human'))).get()
    if (!await checkPassword(input.password, user?.password_hash) || !user) {
      fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    const current = human(user.id)
    if (current.disabled) fail(403, 'ACCOUNT_DISABLED', 'Account is disabled')
    if (current.password_hash !== user.password_hash) fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    return c.json(loginResponse(c, current))
  })
  app.post('/api/auth/logout', c => {
    const id = c.get('sessionId')
    db.delete(sessions).where(eq(sessions.id, id)).run()
    disconnect([{ id }])
    deleteCookie(c, COOKIE, cookieOptions)
    return c.json({ ok: true } as const)
  })
  app.get('/api/auth/me', c => c.json(c.get('user')))
  app.get('/api/auth/sessions', c => {
    const current = c.get('sessionId')
    const rows = db.select({
      id: sessions.id, user_agent: sessions.user_agent, ip_address: sessions.ip_address,
      created_at: sessions.created_at, last_active_at: sessions.last_active_at, expires_at: sessions.expires_at,
    }).from(sessions).where(and(eq(sessions.user_id, c.get('user').id), gt(sessions.expires_at, Date.now())))
      .orderBy(desc(sessions.last_active_at), desc(sessions.created_at), sessions.id).all()
    return c.json(rows.map(row => ({ ...row, current: row.id === current })))
  })
  app.delete('/api/auth/sessions/:id', c => {
    const id = c.req.param('id')
    const rows = db.delete(sessions).where(and(eq(sessions.user_id, c.get('user').id), eq(sessions.id, id)))
      .returning({ id: sessions.id }).all()
    if (!rows.length) fail(404, 'SESSION_NOT_FOUND', 'Session not found')
    disconnect(rows)
    if (id === c.get('sessionId')) deleteCookie(c, COOKIE, cookieOptions)
    return c.json({ ok: true } as const)
  })
  app.post('/api/auth/sessions/revoke-others', c => {
    disconnect(revoke(c.get('user').id, c.get('sessionId')))
    return c.json({ ok: true } as const)
  })
  app.post('/api/auth/change-password', async c => {
    const input = await body(c, changePasswordSchema)
    const user = human(c.get('user').id)
    if (!await checkPassword(input.current_password, user.password_hash)) fail(401, 'INVALID_CREDENTIALS', 'Current password is incorrect')
    const password_hash = await hashPassword(input.new_password)
    const rows = db.transaction(() => {
      const current = human(user.id)
      const session = db.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.id, c.get('sessionId')), gt(sessions.expires_at, Date.now()))).get()
      if (current.disabled) fail(403, 'ACCOUNT_DISABLED', 'Account is disabled')
      if (!session || current.password_hash !== user.password_hash) fail(401, 'UNAUTHENTICATED', 'Sign in again')
      db.update(users).set({ password_hash }).where(eq(users.id, user.id)).run()
      return input.revoke_others ? revoke(user.id, c.get('sessionId')) : []
    }, { behavior: 'immediate' })
    disconnect(rows)
    return c.json({ ok: true } as const)
  })
  app.patch('/api/admin/users/:id', async c => {
    adminOnly(c.get('user'))
    const patch = await body(c, adminUserPatchSchema)
    const actor = human(c.get('user').id)
    adminOnly({ is_admin: actor.is_admin && !actor.disabled })
    const target = db.select().from(users).where(eq(users.id, c.req.param('id'))).get()
    if (!target) fail(404, 'USER_NOT_FOUND', 'User not found')
    if (target.kind === 'bot') {
      if (!realtime.members([target.id]).length) fail(404, 'USER_NOT_FOUND', 'User not found')
      if (patch.is_admin) fail(400, 'INVALID_BOT_ROLE', 'Bot accounts cannot be administrators')
    }
    if (target.id === actor.id && (patch.disabled === true || patch.is_admin === false)) {
      fail(400, 'INVALID_SELF_CHANGE', 'Administrators cannot disable or demote themselves')
    }
    const { user, revoked } = db.transaction(() => {
      const user = Object.keys(patch).length ? db.update(users).set(patch).where(eq(users.id, target.id)).returning().get() : target
      return { user, revoked: user.disabled ? revoke(user.id) : [] }
    })
    disconnect(revoked)
    if (user.disabled && user.kind === 'bot') {
      engine.cancelBot(user.id)
      realtime.closeBridge(user.id, 'Bot was disabled')
    }
    realtime.memberUpdated(user.id)
    return c.json(publicUser(user))
  })
  app.post('/api/admin/users/:id/reset-password', async c => {
    adminOnly(c.get('user'))
    const { new_password } = await body(c, adminResetPasswordSchema)
    const target = human(c.req.param('id'))
    const password_hash = await hashPassword(new_password)
    const revoked = db.transaction(() => {
      const actor = human(c.get('user').id)
      adminOnly({ is_admin: actor.is_admin && !actor.disabled })
      db.update(users).set({ password_hash }).where(eq(users.id, target.id)).run()
      return revoke(target.id)
    })
    disconnect(revoked)
    if (target.id === c.get('user').id) deleteCookie(c, COOKIE, cookieOptions)
    return c.json({ ok: true } as const)
  })
  app.patch('/api/users/me', async c => {
    const patch = await body(c, profilePatchSchema)
    if (!Object.keys(patch).length) return c.json(c.get('user'))
    const user = db.update(users).set(patch).where(eq(users.id, c.get('user').id)).returning().get()
    realtime.memberUpdated(user.id)
    return c.json(publicUser(user))
  })
  app.get('/api/users', c => {
    const viewer = c.get('user')
    if (viewer.kind === 'human') return c.json(realtime.members())
    const ids = db.selectDistinct({ id: channelMembers.user_id }).from(channelMembers).where(sql`
      ${channelMembers.channel_id} IN (SELECT channel_id FROM channel_members WHERE user_id = ${viewer.id})
    `).all().map(row => row.id)
    return c.json(realtime.members(ids))
  })
  app.get('/api/invites', c => {
    adminOnly(c.get('user'))
    return c.json(db.select().from(invites).orderBy(invites.created_at).all())
  })
  app.post('/api/invites', async c => {
    const input = await body(c, inviteCreateSchema)
    adminOnly(c.get('user'))
    if (input.expires_at !== null && input.expires_at <= Date.now()) fail(400, 'INVALID_EXPIRY', 'Invite expiry must be in the future')
    return c.json(db.insert(invites).values({
      ...input, code: randomHex(16), created_by: c.get('user').id, created_at: Date.now(),
    }).returning().get(), 201)
  })
  app.delete('/api/invites/:code', c => {
    adminOnly(c.get('user'))
    db.delete(invites).where(eq(invites.code, c.req.param('code'))).run()
    return c.json({ ok: true } as const)
  })
}

export const requestToken = (c: Context) => bearer(c.req.header('Authorization')) ?? getCookie(c, COOKIE)
