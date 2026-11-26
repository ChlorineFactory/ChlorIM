import { and, eq, gt } from 'drizzle-orm'
import { bots, sessions, users } from './db.js'
import type { Database } from './db.js'
import { publicUser } from './chat.js'
import { sha256 } from './security.js'

export const SESSION_SECONDS = 30 * 86400
export const botTokenPattern = /^chior_bot_[a-f0-9]{64}$/

export function createIdentity(db: Database, localBotByToken?: (token: string) => string | undefined) {
  function sessionById(id: string, touch = true) {
    const now = Date.now()
    const row = db.select({ user: users, session: sessions }).from(sessions).innerJoin(users, eq(sessions.user_id, users.id))
      .where(and(eq(sessions.id, id), gt(sessions.expires_at, now), eq(users.kind, 'human'))).get()
    if (!row) return
    const user = publicUser(row.user)
    let expiresAt = row.session.expires_at
    const renewed = touch && !user.disabled && now - row.session.last_active_at > 300_000
    if (renewed) {
      expiresAt = now + SESSION_SECONDS * 1000
      db.update(sessions).set({ last_active_at: now, expires_at: expiresAt }).where(eq(sessions.id, id)).run()
    }
    return { user, sessionId: id, expiresAt, renewed }
  }

  function identity(token?: string) {
    if (token && /^[a-f0-9]{64}$/.test(token)) return sessionById(sha256(token))
  }

  function botIdentity(token?: string) {
    if (!token || !botTokenPattern.test(token)) return
    const row = db.select({ user: users, bot: bots }).from(bots).innerJoin(users, eq(bots.user_id, users.id))
      .where(and(eq(bots.token_hash, sha256(token)), eq(users.kind, 'bot'))).get()
    if (row) return { user: publicUser(row.user), bot: row.bot }
    const localId = localBotByToken?.(token)
    if (!localId) return
    const localRow = db.select({ user: users, bot: bots }).from(bots).innerJoin(users, eq(bots.user_id, users.id))
      .where(and(eq(bots.user_id, localId), eq(bots.mode, 'local'), eq(users.kind, 'bot'))).get()
    if (localRow) return { user: publicUser(localRow.user), bot: localRow.bot }
  }

  return { identity, sessionById, botIdentity }
}
