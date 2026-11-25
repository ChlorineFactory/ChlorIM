const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const stamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export const formatTime = (ms: number) => time.format(ms)
export const dayKey = (ms: number) => new Date(ms).toDateString()
export const formatDay = (ms: number) => dayKey(ms) === dayKey(Date.now()) ? '今天' : date.format(ms)
export const formatStamp = (ms: number) => stamp.format(ms)
export const imageMime = (mime: string) => mime.startsWith('image/')
export const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || path

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
