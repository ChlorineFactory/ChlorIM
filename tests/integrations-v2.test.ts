import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, test, vi } from 'vitest'
import type { BotWriteResponse, Channel, CreatedWebhook, Member, Message, Provider } from '@chiorim/shared'
import { cleanup, harness, upstream } from './support.js'

test('creates redacted Incoming Webhooks, optionally triggers a bot and rate-limits each webhook', async () => {
  const h = await harness({ rateLimit: true })
  const owner = await h.person('owner')
  const guest = await h.person('guest', await h.invite(owner.token))
  let calls = 0
  const upstreamUrl = await upstream((req, res) => {
    req.resume()
    calls++
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"hook result"}}]}\n\ndata: [DONE]\n\n')
  })
  const provider = await h.api<Provider>('POST', '/api/providers', owner.token, { name: 'Fixture', type: 'openai_compat', base_url: upstreamUrl }, 201)
  const room = await h.general(owner.token)
  await h.api('POST', '/api/bots', owner.token, { mode: 'provider', username: 'hook_bot', display_name: 'Hook Bot',
    provider_id: provider.id, model: 'fixture', trigger_policy: 'always' }, 201)
  const path = `/api/channels/${room.id}/webhooks`
  await h.api('GET', path, guest.token, undefined, 403)
  const created = await h.api<CreatedWebhook>('POST', path, owner.token, { name: 'Build Hook' }, 201)
  expect(created.token).toMatch(/^chior_wh_[a-f0-9]{64}$/)
  expect(h.sqlite.prepare('SELECT token_hash FROM webhooks WHERE id=?').get(created.id))
    .toEqual({ token_hash: createHash('sha256').update(created.token).digest('hex') })
  const list = await h.api<Record<string, string>[]>('GET', path, owner.token)
  expect(list[0]).toMatchObject({ name: 'Build Hook', channel_id: room.id })
  expect(list[0]).not.toHaveProperty('token')
  expect(list[0]).not.toHaveProperty('token_hash')
  expect(await h.api('POST', created.url, undefined, { content: 'Quiet' }, 201))
    .toMatchObject({ author_id: owner.user.id, webhook_name: 'Build Hook' })
  expect(calls).toBe(0)
  expect(await h.api('POST', created.url, undefined, { content: 'Build completed', username: 'CI', trigger_bots: true }, 201))
    .toMatchObject({ webhook_name: 'CI' })
  await vi.waitFor(() => expect(calls).toBe(1))
  for (let index = 0; index < 58; index++) await h.api('POST', created.url, undefined, { content: 'Update' }, 201)
  const limited = await h.raw('POST', created.url, undefined, { content: 'Extra' })
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
  const independent = await h.api<CreatedWebhook>('POST', path, owner.token, { name: 'Other Hook' }, 201)
  await h.api('POST', independent.url, undefined, { content: 'Independent' }, 201)
  await h.api('DELETE', '/api/webhooks/' + created.id, owner.token)
  await h.api('POST', created.url, undefined, { content: 'Revoked' }, 404)
})

test('serves an SPA and immutable assets with HEAD, while keeping reserved routes and filesystem boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chiorim-static-'))
  cleanup(() => rmSync(dir, { recursive: true, force: true }))
  const web = join(dir, 'web')
  mkdirSync(join(web, '_app', 'immutable'), { recursive: true })
  const index = '<!doctype html><title>ChiorIM</title>'
  writeFileSync(join(web, 'index.html'), index)
  writeFileSync(join(web, '_app', 'immutable', 'bundle.js'), 'export {}')
  writeFileSync(join(dir, 'outside.txt'), 'outside')
  symlinkSync(join(dir, 'outside.txt'), join(web, 'escape.txt'))
  const h = await harness({ webDistDir: web })
  expect(await (await h.raw('GET', '/')).text()).toBe(index)
  expect(await (await h.raw('GET', '/settings/profile')).text()).toBe(index)
  const asset = await h.raw('GET', '/_app/immutable/bundle.js')
  expect(await asset.text()).toBe('export {}')
  expect(asset.headers.get('Cache-Control')).toContain('immutable')
  expect(asset.headers.get('Content-Type')).toContain('javascript')
  const head = await h.raw('HEAD', '/somewhere')
  expect(head.headers.get('Content-Length')).toBe(String(Buffer.byteLength(index)))
  expect(await head.text()).toBe('')
  for (const url of ['/ws/unknown', '/escape.txt', '/asset%2f..%2foutside.txt', '/_app/immutable/missing.js']) {
    expect((await h.raw('GET', url)).status, url).toBe(404)
  }
  expect((await h.raw('GET', '/api/auth/session')).headers.get('Content-Type')).toContain('application/json')
  expect((await h.raw('GET', '/uploads/' + 'a'.repeat(32))).status).toBe(401)
})

test('uses bot credentials for MCP stdio and enforces membership, endpoint restrictions and the hop limit', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const privateOnly = await h.person('private_member', await h.invite(owner.token))
  const room = await h.api<Channel>('POST', '/api/channels', owner.token, { type: 'private', name: 'Bot scope' }, 201)
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'mcp_bot', display_name: 'MCP Bot', channel_ids: [room.id],
  }, 201)
  const third = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'third_bot', display_name: 'Third Bot', channel_ids: [room.id],
  }, 201)
  const prompt = await h.api<Message>('POST', `/api/channels/${room.id}/messages`, owner.token, { content: 'Original' }, 201)
  const general = await h.general(owner.token)
  await h.api('GET', `/api/channels/${general.id}/messages`, bot.bot_token, undefined, 404)
  await h.api('GET', '/api/search?channel_id=' + general.id, bot.bot_token, undefined, 404)
  await h.api('GET', '/api/auth/me', bot.bot_token, undefined, 403)
  await h.api('POST', '/api/invites', bot.bot_token, { max_uses: 1 }, 403)
  expect((await h.api<Member[]>('GET', '/api/users', bot.bot_token)).map(member => member.id)).not.toContain(privateOnly.user.id)

  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', resolve('packages/mcp/src/cli.ts')], {
    env: { ...process.env, CHIORIM_URL: h.url, CHIORIM_TOKEN: bot.bot_token },
  })
  const exited = once(child, 'exit')
  cleanup(async () => { child.stdin.end(); await exited })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
  let id = 0
  async function rpc(method: string, params?: object) {
    write({ jsonrpc: '2.0', id: ++id, method, params })
    const response = await lines.next()
    expect(response.done).toBe(false)
    const frame = JSON.parse(response.value)
    expect(frame).toMatchObject({ id, jsonrpc: '2.0' })
    expect(frame.error).toBeUndefined()
    return frame.result
  }
  async function call(name: string, args?: object) {
    const result = await rpc('tools/call', { name, arguments: args ?? {} })
    expect(result.isError, result.content?.[0]?.text).not.toBe(true)
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    return result.structuredContent
  }
  expect(await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }))
    .toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} } })
  write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  expect((await rpc('tools/list')).tools.map((tool: { name: string }) => tool.name))
    .toEqual(['list_workspaces', 'list_channels', 'create_channel', 'read_messages', 'post_message', 'edit_message', 'react_message', 'search_messages', 'list_members'])
  expect((await call('list_channels')).channels.map((channel: Channel) => channel.id)).toEqual([room.id])
  const workspaces = (await call('list_workspaces')).workspaces as { id: string }[]
  expect(workspaces.length).toBeGreaterThanOrEqual(1)
  const createdRoom = (await call('create_channel', { name: 'ai-created', type: 'public', workspace_id: workspaces[0].id, topic: 'From AI' })).channel as Channel
  expect(createdRoom).toMatchObject({ name: 'ai-created', type: 'public', topic: 'From AI' })
  const reacted = await call('react_message', { message_id: prompt.id, emoji: '👍' })
  expect(reacted.reactions).toContainEqual(expect.objectContaining({ emoji: '👍', count: 1 }))
  const written = (await call('post_message', { channel_id: room.id, content: '@third_bot MCP post', reply_to_id: prompt.id })).message
  expect(written).toMatchObject({ author_id: bot.user_id, bot_hop_count: 1, reply_to_id: prompt.id })
  const edited = (await call('edit_message', { message_id: written.id, content: '@third_bot MCP post (edited)' })).message
  expect(edited.content).toBe('@third_bot MCP post (edited)')
  const page = await call('read_messages', { channel_id: room.id, limit: 10 })
  expect(page.messages).toEqual([
    expect.objectContaining({ author_id: third.user_id, bot_hop_count: 2 }), expect.objectContaining({ id: written.id }), expect.objectContaining({ id: prompt.id }),
  ])
  expect((await call('search_messages', { q: 'MCP post' })).hits).toMatchObject([{ id: written.id }])
  expect((await call('list_members', { channel_id: room.id })).members).toHaveLength(3)
  child.stdin.end()
  expect((await exited)[0]).toBe(0)
})
