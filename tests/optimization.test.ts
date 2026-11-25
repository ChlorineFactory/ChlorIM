import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { maintainDatabase } from '../apps/server/src/db.js'
import { cleanup, harness } from './support.js'

test('exposes public healthcheck, serves pre-compressed assets, streams uploads, and prunes expired sessions', async () => {
  const web = mkdtempSync(join(tmpdir(), 'chiorim-web-opt-'))
  cleanup(() => rmSync(web, { recursive: true, force: true }))
  mkdirSync(join(web, '_app', 'immutable'), { recursive: true })
  const jsBody = 'export const payload = "' + 'chiorim-'.repeat(400) + '";'
  writeFileSync(join(web, 'index.html'), '<!doctype html><div id="app">ok</div>')
  writeFileSync(join(web, '_app', 'immutable', 'app.js'), jsBody)
  writeFileSync(join(web, '_app', 'immutable', 'app.js.gz'), gzipSync(jsBody))
  writeFileSync(join(web, '_app', 'immutable', 'app.js.br'), brotliCompressSync(jsBody))

  const h = await harness({ webDistDir: web })

  // 1. Public health endpoint
  const healthRes = await h.raw('GET', '/api/health')
  expect(healthRes.status).toBe(200)
  expect(await healthRes.json()).toMatchObject({ ok: true })

  // 2. Pre-compressed static serving (br preferred over gzip when advertised)
  const brRes = await fetch(h.url + '/_app/immutable/app.js', { headers: { 'Accept-Encoding': 'gzip, br' } })
  expect(brRes.status).toBe(200)
  expect(brRes.headers.get('Vary')).toContain('Accept-Encoding')
  expect(await brRes.text()).toBe(jsBody)

  // 3. Streaming upload download with exact Content-Length
  const owner = await h.person('opt_owner')
  const payload = Buffer.from('a'.repeat(64 * 1024))
  const form = new FormData()
  form.append('file', new Blob([payload], { type: 'text/plain' }), 'large.txt')
  const uploaded = await h.raw('POST', '/api/uploads', owner.token, form)
  expect(uploaded.status).toBe(201)
  const { url } = await uploaded.json() as { url: string }
  const download = await h.raw('GET', url, owner.token)
  expect(download.status).toBe(200)
  expect(download.headers.get('Content-Length')).toBe(String(payload.length))
  expect(Buffer.from(await download.arrayBuffer()).equals(payload)).toBe(true)

  // 4. SQLite memory/storage PRAGMAs & maintenance expired session cleanup
  expect(h.sqlite.pragma('cache_size', { simple: true })).toBe(-8000)
  expect(h.sqlite.pragma('journal_size_limit', { simple: true })).toBe(8388608)
  h.sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at, last_active_at) VALUES ('expired-sess', ?, ?, ?, ?)")
    .run(owner.user.id, Date.now() - 10_000, Date.now() - 20_000, Date.now() - 20_000)
  maintainDatabase(h.sqlite, false)
  const gone = h.sqlite.prepare("SELECT id FROM sessions WHERE id = 'expired-sess'").get()
  expect(gone).toBeUndefined()
})
