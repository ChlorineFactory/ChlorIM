import { Database as BunDatabase } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { setSqliteDriver } from './src/db.js'

setSqliteDriver((filename: string) => {
  const client = new BunDatabase(filename, { create: true }) as unknown as {
    query(sql: string): { all(): Record<string, unknown>[] }
    pragma?: (source: string, options?: { simple?: boolean }) => unknown
  }
  client.pragma = (source: string, options?: { simple?: boolean }) => {
    const rows = client.query(`PRAGMA ${source}`).all()
    if (options?.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows
  }
  return {
    sqlite: client as never,
    wrap: (raw) => drizzle(raw as never) as never,
  }
})

await import('./src/index.js')
