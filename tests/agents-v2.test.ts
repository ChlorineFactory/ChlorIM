import { once } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { Attachment, Bot, BotWriteResponse, Channel, Message, Provider, SlashCommandResponse } from '@chiorim/shared'
import { client, harness, socket, upstream } from './support.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+KvT8AAAAASUVORK5CYII='

test.each(['openai_compat', 'anthropic', 'gemini'] as const)('sends real image bytes and channel instructions to %s, including on regeneration', async type => {
  const h = await harness()
  const requests: string[] = []
  const base = await upstream(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push(Buffer.concat(chunks).toString())
    const answer = 'result ' + requests.length
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = type === 'anthropic'
      ? [{ type: 'content_block_delta', delta: { text: answer } }, { type: 'message_stop' }]
      : type === 'gemini'
        ? [{ candidates: [{ content: { parts: [{ text: answer }] } }] }]
        : [{ choices: [{ delta: { content: answer } }] }]
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
  })
  const owner = await h.person('owner')
  const provider = await h.api<Provider>('POST', '/api/providers', owner.token, { name: 'Fixture', type, base_url: base }, 201)
  const room = await h.api<Channel>('POST', '/api/channels', owner.token, { type: 'private', name: 'Vision', system_context: 'Room instructions' }, 201)
  const bot = await h.api<Bot>('POST', '/api/bots', owner.token, { mode: 'provider', username: 'vision_bot', display_name: 'Vision Bot',
    model: 'fixture', provider_id: provider.id, system_prompt: 'Bot instructions', channel_ids: [room.id] }, 201)
  expect(bot.online).toBe(true)
  const live = client(h.wsUrl, owner.token)
  await vi.waitFor(() => expect(live.events[0]).toMatchObject({ type: 'ready', online_user_ids: expect.arrayContaining([bot.user_id]) }))
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(Buffer.from(png, 'base64'))], { type: 'image/png' }), 'pixel.png')
  const image = await h.api<Attachment>('POST', '/api/uploads', owner.token, form, 201)
  const path = `/api/channels/${room.id}/messages`
  await h.api('POST', path, owner.token, { content: 'Earlier image', attachments: [image] }, 201)
  const prompt = await h.api<Message>('POST', path, owner.token, { content: '@vision_bot describe', attachments: [image] }, 201)
  const response = await vi.waitFor(async () => {
    const { messages } = await h.api<{ messages: Message[] }>('GET', path, owner.token)
    expect(messages[0]).toMatchObject({ status: 'done', content: 'result 1', reply_to_id: prompt.id })
    return messages[0]
  })
  const instruction = 'Bot instructions\n\nRoom instructions'
  const messageContent = expect.stringContaining('[Attachments: pixel.png]')
  const request = JSON.parse(requests[0])
  if (type === 'openai_compat') expect(request.messages).toEqual([
    { role: 'system', content: instruction }, { role: 'user', content: [{ type: 'text', text: messageContent },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] },
  ])
  if (type === 'anthropic') expect(request).toMatchObject({ system: instruction, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: messageContent },
  ] }] })
  if (type === 'gemini') expect(request).toMatchObject({ systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ parts: [{ text: messageContent }, { inlineData: { mimeType: 'image/png', data: png } }] }] })
  expect(await h.api('POST', `/api/messages/${response.id}/regenerate`, owner.token)).toMatchObject({
    id: response.id, status: 'streaming', content: '', blocks: [], error_message: null,
  })
  await vi.waitFor(async () => expect(await h.api('GET', `/api/messages/${response.id}`, owner.token))
    .toMatchObject({ status: 'done', content: 'result 2', reply_to_id: prompt.id }))
  expect(requests[1]).toBe(requests[0])
})

test('disables a running Bridge, closes its socket, and preserves group history and human threads on default deletion', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const room = await h.general(owner.token)
  const path = `/api/channels/${room.id}/messages`
  await h.api('PATCH', `/api/channels/${room.id}`, owner.token, { system_context: 'Use channel instructions' })
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'bridge_bot', display_name: 'Bridge', driver_hint: 'custom',
  }, 201)
  const bridge = socket(h.wsUrl + '/ws/bridge', { Authorization: 'Bearer ' + bot.bot_token })
  const frames: unknown[] = []
  bridge.on('message', raw => frames.push(JSON.parse(raw.toString())))
  await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'bridge.welcome' }))
  bridge.send(JSON.stringify({ type: 'bridge.hello', hostname: 'fixture', driver: 'custom' }))
  await vi.waitFor(async () => expect((await h.api<Bot[]>('GET', '/api/bots', owner.token))[0].online).toBe(true))
  await h.api('POST', path, owner.token, { content: '@bridge_bot run' }, 201)
  const run = await vi.waitFor(() => {
    const run = frames.find(frame => (frame as { type: string }).type === 'run.start') as { message_id: string; run_id: string }
    expect(run).toMatchObject({ channel_context: 'Use channel instructions' })
    return run
  })
  await h.api('POST', `/api/messages/${run.message_id}/regenerate`, owner.token, undefined, 409)
  const ended = once(bridge, 'close')
  expect(await h.api('PATCH', '/api/bots/' + bot.user_id, owner.token, { disabled: true }))
    .toMatchObject({ online: false, user: { disabled: true } })
  expect((await ended)[0]).toBe(4001)
  expect(await h.api('GET', '/api/messages/' + run.message_id, owner.token)).toMatchObject({ status: 'aborted' })
  await h.api('GET', '/api/channels', bot.bot_token, undefined, 403)
  await h.api('POST', path, owner.token, { content: '@bridge_bot disabled' }, 201)
  const humanReply = await h.api<Message>('POST', path, owner.token, { thread_root_id: run.message_id, content: 'Keep me' }, 201)
  expect((await h.api<{ messages: Message[] }>('GET', path, owner.token)).messages.filter(row => row.author_id === bot.user_id)).toHaveLength(1)
  await h.api('PATCH', '/api/bots/' + bot.user_id, owner.token, { disabled: false })
  const dm = await h.api<Channel>('POST', '/api/channels/dm', owner.token, { target_user_id: bot.user_id })
  await h.api('DELETE', '/api/bots/' + bot.user_id, owner.token)
  expect(await h.api('GET', '/api/bots', owner.token)).toEqual([])
  expect(await h.api('GET', '/api/messages/' + run.message_id, owner.token))
    .toMatchObject({ author: { id: bot.user_id, display_name: 'Bridge', disabled: true } })
  expect(await h.api('GET', '/api/messages/' + humanReply.id, owner.token)).toMatchObject({ content: 'Keep me' })
  await h.api('GET', `/api/channels/${dm.id}/messages`, owner.token, undefined, 404)
  await h.api('GET', '/api/channels', bot.bot_token, undefined, 401)

  const purge = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'purge_bot', display_name: 'Purge',
  }, 201)
  const written = await h.api<Message>('POST', path, purge.bot_token, { content: 'Purge me' }, 201)
  await h.api('DELETE', '/api/bots/' + purge.user_id + '?purge=true', owner.token)
  await h.api('GET', '/api/messages/' + written.id, owner.token, undefined, 404)
  expect(h.sqlite.prepare('SELECT id FROM users WHERE id=?').get(purge.user_id)).toBeUndefined()
})

test('executes slash commands, dispatches explicit asks in parallel and limits session reset to visible scopes', async () => {
  const h = await harness()
  const models: string[] = []
  const base = await upstream(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    models.push(JSON.parse(Buffer.concat(chunks).toString()).model)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Start"}}]}\n\n')
  })
  const owner = await h.person('owner')
  const viewer = await h.person('viewer', await h.invite(owner.token))
  const room = await h.general(owner.token)
  const provider = await h.api<Provider>('POST', '/api/providers', owner.token, { name: 'Fixture', type: 'openai_compat', base_url: base }, 201)
  const privateRoom = await h.api<Channel>('POST', '/api/channels', owner.token, { type: 'private', name: 'Private' }, 201)
  const alpha = await h.api<Bot>('POST', '/api/bots', owner.token, { mode: 'provider', username: 'alpha', display_name: 'Alpha',
    provider_id: provider.id, model: 'old-model', channel_ids: [room.id, privateRoom.id] }, 201)
  const beta = await h.api<Bot>('POST', '/api/bots', owner.token, { mode: 'provider', username: 'beta', display_name: 'Beta',
    provider_id: provider.id, model: 'beta-model', trigger_policy: 'dm_only', channel_ids: [room.id] }, 201)
  const command = `/api/channels/${room.id}/command`
  const call = (text: string, token = owner.token) => h.api<SlashCommandResponse>('POST', command, token, { command: text })
  expect((await call('/status')).message).toMatch(/@alpha online.*old-model/)
  await h.api('POST', command, viewer.token, { command: '/model @alpha forbidden' }, 403)
  await call('/model @alpha new-model')
  expect((await call('/status')).message).toMatch(/@alpha online.*new-model/)
  const asked = await call('/ask @alpha @beta What changed?', viewer.token)
  expect(asked.created_message?.content).toBe('@alpha @beta What changed?')
  await vi.waitFor(() => expect(models.sort()).toEqual(['beta-model', 'new-model']))
  const save = h.sqlite.prepare('INSERT INTO bot_sessions VALUES (?,?,?,?)')
  save.run(alpha.user_id, 'channel:' + room.id, 'alpha-main', Date.now())
  save.run(beta.user_id, 'channel:' + room.id, 'beta-main', Date.now())
  save.run(alpha.user_id, 'channel:' + privateRoom.id, 'alpha-private', Date.now())
  expect((await call('/reset @beta', viewer.token)).message).toContain('1')
  const endpoint = `/api/bots/${alpha.user_id}/sessions`
  await h.api('DELETE', endpoint + '?channel_id=' + privateRoom.id, viewer.token, undefined, 404)
  expect(await h.api('DELETE', endpoint, viewer.token)).toEqual({ ok: true, cleared: 1 })
  expect(await h.api('DELETE', endpoint, owner.token)).toEqual({ ok: true, cleared: 1 })
  expect((await call('/reset', viewer.token)).message).toContain('0')
  expect(h.sqlite.prepare('SELECT count(*) AS n FROM bot_sessions').get()).toEqual({ n: 0 })
  expect(h.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE status='aborted'").get()).toEqual({ n: 2 })
})

test('ignores late output from an aborted run after regenerating the same message ID', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const room = await h.general(owner.token)
  const mockUrl = 'http://upstream.invalid/v1/chat/completions'
  const fetchImpl = globalThis.fetch
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) !== mockUrl) return fetchImpl(input, init)
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controllers.push(controller) },
    }), { headers: { 'Content-Type': 'text/event-stream' } }))
  })
  try {
    const provider = await h.api<Provider>('POST', '/api/providers', owner.token, {
      name: 'Controlled upstream', type: 'openai_compat', base_url: 'http://upstream.invalid/v1',
    }, 201)
    await h.api('POST', '/api/bots', owner.token, {
      mode: 'provider', username: 'late_bot', display_name: 'Late Bot', provider_id: provider.id, model: 'fixture',
    }, 201)
    const path = `/api/channels/${room.id}/messages`
    await h.api('POST', path, owner.token, { content: '@late_bot Test' }, 201)
    await vi.waitFor(() => expect(controllers).toHaveLength(1))
    const { messages } = await h.api<{ messages: Message[] }>('GET', path, owner.token)
    const location = '/api/messages/' + messages[0].id
    await h.api('POST', location + '/abort', owner.token)
    await h.api('POST', location + '/regenerate', owner.token)
    await vi.waitFor(() => expect(controllers).toHaveLength(2))
    const answer = (text: string) => Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`)
    controllers[0].enqueue(answer('stale'))
    controllers[0].close()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await h.api('GET', location, owner.token)).toMatchObject({ status: 'streaming', content: '' })
    controllers[1].enqueue(answer('fresh'))
    controllers[1].close()
    await vi.waitFor(async () => expect(await h.api('GET', location, owner.token)).toMatchObject({ status: 'done', content: 'fresh' }))
  } finally { mock.mockRestore() }
})
