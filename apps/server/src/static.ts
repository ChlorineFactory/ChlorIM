import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { App } from './app.js'
import { fail } from './errors.js'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
}
const compressible = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg'])

export function registerStatic(app: App, directory: string) {
  const root = resolve(directory)
  if (!existsSync(join(root, 'index.html'))) return
  const base = realpathSync(root)

  async function file(relative: string) {
    try {
      const filename = await realpath(join(base, relative))
      if (!filename.startsWith(base + sep)) fail(404, 'NOT_FOUND', 'File not found')
      const info = await stat(filename)
      if (info.isFile()) return { filename, size: info.size }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }

  async function precompressed(entry: { filename: string; size: number }, acceptEncoding: string, extension: string) {
    if (!compressible.has(extension)) return { ...entry, encoding: undefined as 'br' | 'gzip' | undefined }
    const candidates: Array<{ ext: string; encoding: 'br' | 'gzip' }> = []
    if (/\bbr\b/i.test(acceptEncoding)) candidates.push({ ext: '.br', encoding: 'br' })
    if (/\bgzip\b/i.test(acceptEncoding)) candidates.push({ ext: '.gz', encoding: 'gzip' })
    for (const candidate of candidates) {
      try {
        const compressedPath = await realpath(entry.filename + candidate.ext)
        if (!compressedPath.startsWith(base + sep)) continue
        const info = await stat(compressedPath)
        if (info.isFile() && info.size < entry.size) return { filename: compressedPath, size: info.size, encoding: candidate.encoding }
      } catch { /* Sidecar optional */ }
    }
    return { ...entry, encoding: undefined as 'br' | 'gzip' | undefined }
  }

  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) return next()
    const encoded = new URL(c.req.url).pathname
    let path: string
    try { path = decodeURIComponent(encoded) } catch { fail(404, 'NOT_FOUND', 'File not found') }
    if (/^\/(?:api|uploads|ws)(?:\/|$)/.test(path)) return next()
    if (/%(?:2f|5c)/i.test(encoded) || path.includes('\\') || /[\x00-\x1f]/.test(path) ||
        path.split('/').some(part => part.startsWith('.'))) fail(404, 'NOT_FOUND', 'File not found')
    const relative = path.replace(/^\/+/, '')
    const asset = relative ? await file(relative) : undefined
    if (!asset && relative.startsWith('_app/')) return next()
    const entry = asset ?? await file('index.html')
    if (!entry) return next()
    const extension = extname(entry.filename)
    const immutable = Boolean(asset && relative.startsWith('_app/immutable/'))
    const served = await precompressed(entry, c.req.header('Accept-Encoding') ?? '', extension)
    const headers: Record<string, string> = {
      'Content-Type': types[extension] ?? 'application/octet-stream',
      'Content-Length': String(served.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    }
    if (served.encoding) {
      headers['Content-Encoding'] = served.encoding
      headers['Vary'] = 'Accept-Encoding'
    }
    const body = c.req.method === 'HEAD' ? null : Readable.toWeb(createReadStream(served.filename)) as ReadableStream<Uint8Array>
    return new Response(body, { headers })
  })
}
