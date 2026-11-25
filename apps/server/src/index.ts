import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChiorServer } from './server.js'

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}

const isStandalone = import.meta.url.includes('/$bunfs/')
const defaultDataDir = isStandalone
  ? resolve(process.cwd(), 'data')
  : fileURLToPath(new URL('../../../data', import.meta.url))
const defaultWebDist = isStandalone
  ? [resolve(dirname(process.execPath), 'web'), resolve(process.cwd(), 'web'), resolve(process.cwd(), 'apps/web/dist')].find(dir => existsSync(resolve(dir, 'index.html')))
  : undefined

const port = integer('PORT', 3000, 1, 65535)
const host = process.env.HOST ?? '127.0.0.1'
const { server, close } = createChiorServer({
  dataDir: process.env.DATA_DIR ?? defaultDataDir,
  database: process.env.DATABASE_PATH,
  appSecret: process.env.APP_SECRET,
  corsOrigins: process.env.CORS_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
  secureCookies: process.env.COOKIE_SECURE === 'true',
  uploadLimit: integer('UPLOAD_MAX_BYTES', 10 * 1024 * 1024, 1, 100 * 1024 * 1024),
  webDistDir: process.env.WEB_DIST_DIR ?? defaultWebDist,
  publicUploads: process.env.PUBLIC_UPLOADS === 'true',
  bridgePublicUrl: process.env.BRIDGE_PUBLIC_URL,
})
server.listen(port, host, () => console.log(`ChiorIM listening on ${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void close().catch(error => { console.error(error); process.exitCode = 1 }) })
}
