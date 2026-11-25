import { readSse } from '@chiorim/shared'
import type { ContextEntry, Delta } from '@chiorim/shared'
import type { BotRow, ProviderRow } from './db.js'
import type { VisionImage } from './vision.js'

const contextLine = (entry: ContextEntry) => `${entry.author_name} (@${entry.author_username}): ${entry.content}`
const withoutSlash = (url: string) => url.replace(/\/+$/, '')
const append = (url: string, path: string) => withoutSlash(url).endsWith(path) ? withoutSlash(url) : withoutSlash(url) + path
type WireDelta = { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string; text?: string }
type WireEvent = {
  error?: unknown
  type?: string
  choices?: { delta?: WireDelta }[]
  delta?: WireDelta & { type?: string }
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
}

function headersFor(provider: ProviderRow, key: string): Record<string, string> {
  if (provider.type === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (provider.type === 'gemini') return { 'x-goog-api-key': key }
  return key ? { Authorization: `Bearer ${key}` } : {}
}

export async function* runProvider(
  provider: ProviderRow, key: string, bot: BotRow, context: ContextEntry[], scope: string, signal: AbortSignal,
  channelContext = '', images: VisionImage[] = [],
): AsyncGenerator<Delta> {
  if (!bot.model) throw new Error('No model configured')
  const headers = { ...headersFor(provider, key), 'Content-Type': 'application/json' }
  const transcript = context.map(contextLine).join('\n')
  const system = [bot.system_prompt, channelContext].filter(Boolean).join('\n\n')
  const text = { type: 'text', text: transcript }
  let url: string
  let payload: unknown
  switch (provider.type) {
    case 'openai_compat':
      url = append(provider.base_url, '/chat/completions')
      if (provider.hermes_session_header || /hermes/i.test(provider.base_url)) {
        Object.assign(headers, { 'X-Hermes-Session-Id': scope })
      }
      payload = {
        model: bot.model, stream: true, temperature: bot.temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: images.length ? [text, ...images.map(image => ({
            type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` },
          }))] : transcript },
        ],
      }
      break
    case 'anthropic':
      url = append(provider.base_url, '/messages')
      // Anthropic user content is required even for attachment-only messages.
      payload = {
        model: bot.model, stream: true, max_tokens: 4096,
        system: system || undefined,
        messages: [{ role: 'user', content: images.length ? [
          ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } })),
          text,
        ] : transcript }],
      }
      break
    case 'gemini':
      url = `${withoutSlash(provider.base_url)}/models/${encodeURIComponent(bot.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`
      payload = {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: transcript }, ...images.map(image => ({
          inlineData: { mimeType: image.mime, data: image.base64 },
        }))] }],
        generationConfig: { temperature: bot.temperature },
      }
      break
  }
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
  })
  let received = false
  let completed = false
  for await (const data of readSse(response)) {
    if (data === '[DONE]') { completed = true; break }
    const event = JSON.parse(data) as WireEvent
    if (event.error || event.type === 'error' || event.promptFeedback?.blockReason) throw new Error('Upstream reported an error')
    if (event.type === 'message_stop') completed = true
    received = true
    const choice = event.choices?.[0]?.delta
    const thinking = choice?.reasoning_content || choice?.reasoning || event.delta?.thinking
    const text = choice?.content || event.delta?.text
    if (typeof thinking === 'string' && thinking) yield { part: 'thinking', delta: thinking }
    if (typeof text === 'string' && text) yield { part: 'text', delta: text }
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) yield { part: part.thought ? 'thinking' : 'text', delta: part.text }
    }
  }
  if (!received && !completed) throw new Error('Upstream returned an empty stream')
  if (provider.type === 'anthropic' && !completed) throw new Error('Upstream closed the stream early')
}

export async function testProvider(provider: ProviderRow, key: string): Promise<string[]> {
  const base = withoutSlash(provider.base_url).replace(/\/(?:chat\/completions|messages|models)$/, '')
  const response = await fetch(`${base}/models`, {
    headers: headersFor(provider, key), signal: AbortSignal.timeout(8000), redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Upstream HTTP ${response.status}`)
  }
  const result = await response.json() as { data?: { id?: unknown }[]; models?: { name?: unknown }[] }
  return (result.data?.map(model => model.id) ?? result.models?.map(model => model.name) ?? [])
    .filter((model): model is string => typeof model === 'string')
}

export const providerError = (error: unknown) => {
  if (error instanceof Error && /^(Upstream (HTTP \d{3}|reported an error|returned an empty stream|closed the stream early|SSE event is too large)|No model configured)$/.test(error.message)) {
    return error.message
  }
  return 'Could not read the upstream response'
}
