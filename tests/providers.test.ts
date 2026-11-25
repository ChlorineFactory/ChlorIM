import { expect, test, vi } from 'vitest'
import type { Bot, Channel, Message, Provider } from '@chiorim/shared'
import { client, harness, upstream } from './support.js'

test('streams thinking and text, propagates abort, and caps bot-to-bot routing at two hops', async () => {
  const h = await harness()
  const calls: { model: string; content: string; hermes?: string }[] = []
  let aborted = false
  const base = await upstream(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: { content: string }[] }
    const content = payload.messages.at(-1)!.content
    calls.push({ model: payload.model, content, hermes: String(req.headers['x-hermes-session-id'] ?? '') })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (delta: object) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\r\n\r\n'
    if (content.endsWith('please wait')) {
      res.write(event({ content: 'partial' }))
      res.once('close', () => { aborted = true })
      return
    }
    const answer = payload.model === 'alpha' ? '@beta' : '@alpha'
    const first = event({ reasoning_content: 'checking' })
    res.write(first.slice(0, -1))
    setTimeout(() => res.end(first.slice(-1) + event({ content: answer }) + 'data: [DONE]\n\n'), 25)
  })
  const user = await h.person('admin')
  const provider = await h.api<Provider>('POST', '/api/providers', user.token, {
    type: 'openai_compat', name: 'Mock', base_url: base + '/v1', hermes_session_header: true,
  }, 201)
  const room = await h.api<Channel>('POST', '/api/channels', user.token, { type: 'private', name: 'Test' }, 201)
  for (const username of ['alpha', 'beta']) {
    await h.api<Bot>('POST', '/api/bots', user.token, { mode: 'provider', username, display_name: username,
      provider_id: provider.id, model: username, channel_ids: [room.id] }, 201)
  }
  const { ws, events } = client(h.wsUrl, user.token)
  await vi.waitFor(() => expect(events[0]?.type).toBe('ready'))
  ws.send(JSON.stringify({ type: 'message.send', channel_id: room.id, content: '@ALPHA hello', client_nonce: 'n-1' }))
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
    type: 'message.updated', message: expect.objectContaining({ author: expect.objectContaining({ username: 'beta' }), status: 'done', bot_hop_count: 2 }),
  })))
  expect(events).toContainEqual(expect.objectContaining({ type: 'message.created', client_nonce: 'n-1' }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'message.delta', part: 'thinking', delta: 'checking' }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'message.delta', part: 'text', delta: '@beta' }))
  const page = `/api/channels/${room.id}/messages`
  const history = await h.api<{ messages: Message[] }>('GET', page, user.token)
  expect(history.messages.map(message => [message.content, message.bot_hop_count])).toEqual([
    ['@alpha', 2], ['@beta', 1], ['@ALPHA hello', 0],
  ])
  expect(history.messages[1].blocks).toEqual([{ type: 'thinking', text: 'checking' }])
  expect(calls.map(call => call.model)).toEqual(['alpha', 'beta'])
  expect(calls[0]).toMatchObject({ content: 'ADMIN (@admin): @ALPHA hello', hermes: `channel:${room.id}` })
  expect(calls[1].content).toContain('alpha (@alpha): @beta')

  await h.api('POST', page, user.token, { content: '@alpha please wait' }, 201)
  const delta = await vi.waitFor(() => {
    const event = events.find(event => event.type === 'message.delta' && event.delta === 'partial')
    expect(event).toBeDefined()
    return event!
  })
  if (delta.type !== 'message.delta') throw new Error('Expected a delta')
  ws.send(JSON.stringify({ type: 'message.abort', message_id: delta.message_id }))
  await vi.waitFor(() => {
    expect(aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.updated', message: expect.objectContaining({ id: delta.message_id, status: 'aborted', content: 'partial' }),
    }))
  })
})

test.each(['anthropic', 'gemini'] as const)('maps %s SSE text and thinking to the same message blocks', async type => {
  const h = await harness()
  const requests: { path?: string; key?: string | string[] }[] = []
  const base = await upstream((req, res) => {
    req.resume()
    requests.push({ path: req.url, key: req.headers[type === 'gemini' ? 'x-goog-api-key' : 'x-api-key'] })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = type === 'gemini'
      ? [{ candidates: [{ content: { parts: [{ text: 'thought', thought: true }, { text: 'result' }] }, finishReason: 'STOP' }] }]
      : [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'thought' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'result' } }, { type: 'message_stop' }]
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const user = await h.person('admin')
  const provider = await h.api<Provider>('POST', '/api/providers', user.token, {
    type, name: 'Mock', base_url: base + '/v1', api_key: 'mock-key',
  }, 201)
  const bot = await h.api<Bot>('POST', '/api/bots', user.token, {
    mode: 'provider', username: 'assistant', display_name: 'Assistant', model: 'test-model', provider_id: provider.id,
  }, 201)
  const dm = await h.api<Channel>('POST', '/api/channels/dm', user.token, { target_user_id: bot.user_id })
  const path = `/api/channels/${dm.id}/messages`
  await h.api('POST', path, user.token, { content: 'DM without mention' }, 201)
  await vi.waitFor(async () => {
    const { messages } = await h.api<{ messages: Message[] }>('GET', path, user.token)
    expect(messages[0]).toMatchObject({ status: 'done', content: 'result', blocks: [{ type: 'thinking', text: 'thought' }] })
  })
  expect(requests).toEqual([{ path: type === 'gemini' ? '/v1/models/test-model:streamGenerateContent?alt=sse' : '/v1/messages', key: 'mock-key' }])
})

test('passes names for text and attachment-only history without modifying stored user content', async () => {
  const h = await harness()
  const prompts: string[] = []
  const base = await upstream(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { content: string }[] }
    prompts.push(body.messages.at(-1)!.content)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"received"}}]}\n\ndata: [DONE]\n\n')
  })
  const user = await h.person('admin')
  const provider = await h.api<Provider>('POST', '/api/providers', user.token, {
    type: 'openai_compat', name: 'Mock', base_url: base + '/v1',
  }, 201)
  const bot = await h.api<Bot>('POST', '/api/bots', user.token, {
    mode: 'provider', username: 'files', display_name: 'Files', model: 'files', provider_id: provider.id,
  }, 201)
  const room = await h.api<Channel>('POST', '/api/channels/dm', user.token, { target_user_id: bot.user_id })
  const path = `/api/channels/${room.id}/messages`
  const attachment = (name: string, key: string) => ({ name, url: '/uploads/' + key.repeat(32), size: 3, mime: 'text/plain' })
  const first = await h.api<Message>('POST', path, user.token, { content: 'See notes', attachments: [
    attachment('notes.md', 'a'), attachment('main.ts', 'b'),
  ] }, 201)
  const second = await h.api<Message>('POST', path, user.token, { content: '', attachments: [attachment('config.yaml', 'c')] }, 201)
  await vi.waitFor(() => expect(prompts).toHaveLength(2))
  expect(prompts[0]).toContain('See notes\n[Attachments: notes.md, main.ts]')
  expect(prompts[1]).toContain('See notes\n[Attachments: notes.md, main.ts]')
  expect(prompts[1]).toContain('ADMIN (@admin): [Attachments: config.yaml]')
  expect((await h.api<Message>('GET', `/api/messages/${first.id}`, user.token)).content).toBe('See notes')
  expect((await h.api<Message>('GET', `/api/messages/${second.id}`, user.token)).content).toBe('')
})
