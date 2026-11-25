import type { MessageRow } from './db.js'
import { readUpload } from './uploads.js'

const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const maxImageSize = 5 * 1024 * 1024
export type VisionImage = { mime: string; base64: string }

export async function visionImages(dataDir: string, history: MessageRow[], signal: AbortSignal): Promise<VisionImage[]> {
  const images: VisionImage[] = []
  const seen = new Set<string>()
  for (const message of [...history].reverse().filter(row =>
    row.blocks_json.some(block => block.type === 'attachment' && mimeTypes.has(block.mime))).slice(0, 4)) {
    for (const block of message.blocks_json) {
      if (block.type !== 'attachment' || !mimeTypes.has(block.mime) || seen.has(block.url)) continue
      signal.throwIfAborted()
      seen.add(block.url)
      const upload = await readUpload(dataDir, block.url.slice('/uploads/'.length), maxImageSize)
      if (!upload || upload.metadata.mime !== block.mime || !upload.data.length) continue
      images.push({ mime: upload.metadata.mime, base64: upload.data.toString('base64') })
      if (images.length === 4) return images
    }
  }
  return images
}
