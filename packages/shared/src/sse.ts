/** Reads SSE data fields across arbitrary network chunk and CR/LF boundaries. */
export async function* readSse(response: Response): AsyncGenerator<string> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Upstream HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let line = ''
  let data: string[] = []
  let size = 0
  let skipLf = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      const chunk = done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true })
      for (const char of chunk) {
        if (skipLf) {
          skipLf = false
          if (char === '\n') continue
        }
        if (char === '\n' || char === '\r') {
          skipLf = char === '\r'
          if (!line && data.length) {
            yield data.join('\n')
            data = []
            size = 0
          } else if (line === 'data' || line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''))
          }
          line = ''
        } else {
          line += char
          if (++size > 2_000_000) throw new Error('Upstream SSE event is too large')
        }
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
