import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'
import { fail } from './errors.js'

export const clientIp = (c: Context) => (c.env as HttpBindings | undefined)?.incoming?.socket.remoteAddress ?? ''

export function createRateLimits(enabled: boolean) {
  function window(limit: number, duration: number) {
    const entries = new Map<string, number[]>()
    let sweepAt = 0
    return (c: Context, key: string) => {
      if (!enabled) return
      const now = Date.now()
      const cutoff = now - duration
      if (now >= sweepAt) {
        sweepAt = now + 30_000
        for (const [id, times] of entries) if (times.at(-1)! <= cutoff) entries.delete(id)
      }
      const times = (entries.get(key) ?? []).filter(time => time > cutoff)
      if (times.length >= limit || (!entries.has(key) && entries.size >= 20_000)) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(((times[0] ?? now) + duration - now) / 1000))))
        fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.')
      }
      times.push(now)
      entries.set(key, times)
    }
  }

  return { login: window(10, 300_000), register: window(5, 600_000), webhook: window(60, 60_000) }
}
