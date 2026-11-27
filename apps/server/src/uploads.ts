import { constants, createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { attachmentSchema } from '@chiorim/shared'
import type { Attachment } from '@chiorim/shared'
import { fail } from './errors.js'
import { randomHex } from './security.js'
import type { App } from './app.js'

const imageMime = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'])
const textMime = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/x-python',
  'text/x-shellscript', 'text/x-c', 'text/x-java-source', 'text/x-go', 'text/x-rust', 'text/yaml', 'application/yaml',
  'application/json', 'application/xml', 'text/xml', 'text/javascript', 'application/javascript', 'text/css', 'text/html',
  'application/typescript', 'application/x-sh', 'application/toml', 'application/sql'])
const docMime = new Set(['application/pdf', 'application/zip', 'application/x-zip-compressed', 'application/gzip'])
const sourceExtension = /\.(?:txt|md|csv|tsv|log|json|jsonl|yaml|yml|toml|xml|js|mjs|cjs|ts|tsx|jsx|py|sh|zsh|rb|go|rs|c|cpp|h|java|kt|swift|sql|css|html|vue|svelte)$/i
const MAX_HEADER_BYTES = 8192

export function uploadMime(type: string, name: string) {
  return (!type || type === 'application/octet-stream') && sourceExtension.test(name) ? 'text/plain' : type
}

async function inspectUpload(dataDir: string, id: string, maxBytes = 100 * 1024 * 1024) {
  if (!/^[a-f0-9]{32}$/.test(id)) return
  const path = join(dataDir, 'uploads', id)
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > maxBytes + MAX_HEADER_BYTES) return
      const probe = Buffer.allocUnsafe(Math.min(info.size, MAX_HEADER_BYTES + 1))
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
      const end = probe.subarray(0, bytesRead).indexOf(10)
      if (end < 0 || end > MAX_HEADER_BYTES) return
      const dataStart = end + 1
      const dataLength = info.size - dataStart
      if (dataLength < 0 || dataLength > maxBytes) return
      let meta: unknown
      try { meta = JSON.parse(probe.subarray(0, end).toString('utf8')) } catch { return }
      const parsed = attachmentSchema.safeParse(meta)
      if (!parsed.success || parsed.data.url !== `/uploads/${id}` || parsed.data.size !== dataLength) return
      return { path, metadata: parsed.data, start: dataStart }
    } finally { await handle.close() }
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
}

export async function readUpload(dataDir: string, id: string, maxBytes = 100 * 1024 * 1024) {
  const header = await inspectUpload(dataDir, id, maxBytes)
  if (!header) return
  const handle = await open(header.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const data = Buffer.allocUnsafe(header.metadata.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, header.start + offset)
      if (bytesRead === 0) return
      offset += bytesRead
    }
    return { metadata: header.metadata, data }
  } finally { await handle.close() }
}

export function registerUploads(app: App, dataDir: string, uploadLimit: number, publicUploads: boolean) {
  const directory = join(dataDir, 'uploads')
  app.post('/api/uploads', async c => {
    let fields: FormData
    try { fields = await c.req.formData() }
    catch { return fail(400, 'INVALID_UPLOAD', 'Expected multipart/form-data') }
    c.get('recheckAuth')?.()
    const file = fields.get('file')
    if (!file || typeof file === 'string') fail(400, 'INVALID_UPLOAD', 'Upload a multipart file field named file')
    if (file.size > uploadLimit) fail(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit')
    const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'attachment'
    const mime = uploadMime(file.type, name)
    if (!imageMime.has(mime) && !textMime.has(mime) && !docMime.has(mime)) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported file type')
    const id = randomHex(16)
    const attachment: Attachment = { url: `/uploads/${id}`, name, mime, size: file.size }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Write metadata line and payload with writev to avoid extra whole-file Buffer.concat copies.
    const handle = await open(join(directory, id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      const header = Buffer.from(JSON.stringify(attachment) + '\n')
      const body = new Uint8Array(await file.arrayBuffer())
      await handle.writev([header, body])
    } finally { await handle.close() }
    return c.json(attachment, 201)
  })
  app.get('/uploads/:filename', async c => {
    const upload = await inspectUpload(dataDir, c.req.param('filename'))
    if (!upload) fail(404, 'FILE_NOT_FOUND', 'File not found')
    c.header('Content-Type', upload.metadata.mime)
    c.header('Content-Length', String(upload.metadata.size))
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', "sandbox; default-src 'none'")
    c.header('Cache-Control', publicUploads ? 'public, max-age=31536000, immutable' : 'private, no-store')
    if (!imageMime.has(upload.metadata.mime)) c.header('Content-Disposition', 'attachment')
    const body = Readable.toWeb(createReadStream(upload.path, { start: upload.start })) as ReadableStream<Uint8Array>
    return c.body(body)
  })
}
