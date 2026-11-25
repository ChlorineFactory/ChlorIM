import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Attachment, AuthResponse, Bot, Channel, Member, Message, Provider } from '@chiorim/shared'
import { memberListSchema, messageSchema } from '@chiorim/shared'
import { uploadMime } from '../apps/server/src/uploads.js'
import { openDatabase } from '../apps/server/src/db.js'
import { client, harness, upstream } from './support.js'

test('bootstraps one admin, enforces invite limits and revokes sessions on logout', async () => {
  const h = await harness()
  expect(await h.api('GET', '/api/auth/bootstrap')).toEqual({ initialized: false })
  const admin = await h.person('admin')
  expect(admin.user.is_admin).toBe(true)
  expect(await h.api('GET', '/api/auth/bootstrap')).toEqual({ initialized: true })
  expect((await h.api<Channel[]>('GET', '/api/channels', admin.token)).map(room => room.name).sort()).toEqual(['general', '留言板'])
  const credentials = { username: 'member', display_name: 'Member', password: 'chior-password' }
  await h.api('POST', '/api/auth/register', undefined, credentials, 403)
  const code = await h.invite(admin.token)
  const member = await h.person('member', code)
  expect(member.user.is_admin).toBe(false)
  await h.api('POST', '/api/auth/register', undefined, { ...credentials, username: 'another', invite_code: code }, 403)
  await h.api('GET', '/api/invites', member.token, undefined, 403)
  await h.api('POST', '/api/auth/login', undefined, { username: 'member', password: 'incorrect' }, 401)
  const login = await h.raw('POST', '/api/auth/login', undefined, credentials, { Origin: 'http://localhost:5173' })
  const { token } = await login.json() as AuthResponse
  expect(login.status).toBe(200)
  expect(login.headers.get('Set-Cookie')).toMatch(/chior_session=.*Path=\/.*HttpOnly.*SameSite=Lax/)
  expect(login.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  expect(login.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  expect((await h.raw('GET', '/api/auth/me', undefined, undefined, { Cookie: `chior_session=${token}` })).status).toBe(200)
  await h.api('PATCH', '/api/users/me', token, { bio: 'hello' })
  const live = client(h.wsUrl, token, true)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  const closed = once(live.ws, 'close')
  await h.api('POST', '/api/auth/logout', token)
  expect((await closed)[0]).toBe(4001)
  await h.api('GET', '/api/auth/me', token, undefined, 401)
  const persisted = h.sqlite.prepare('SELECT id FROM sessions WHERE user_id=?').all(member.user.id)
  expect(persisted).toEqual([{ id: createHash('sha256').update(member.token).digest('hex') }])
  expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
})

test('makes first registration and single-use invites atomic across simultaneous requests', async () => {
  const h = await harness()
  const register = (username: string, invite_code?: string) =>
    h.raw('POST', '/api/auth/register', undefined, { username, display_name: username, password: 'chior-password', invite_code })
  const responses = await Promise.all([register('first'), register('second')])
  expect(responses.map(r => r.status).sort()).toEqual([201, 403])
  const admin = await responses.find(r => r.status === 201)!.json() as AuthResponse
  const code = await h.invite(admin.token)
  const members = await Promise.all([register('member_a', code), register('member_b', code)])
  expect(members.map(r => r.status).sort()).toEqual([201, 403])
})

test('handles private channels, idempotent DMs, unread cursors, main pagination and thread isolation', async () => {
  const h = await harness()
  const admin = await h.person('admin')
  const member = await h.person('member', await h.invite(admin.token))
  const outsider = await h.person('outsider', await h.invite(admin.token))
  const room = await h.api<Channel>('POST', '/api/channels', admin.token, {
    type: 'private', name: 'Planning', member_ids: [member.user.id],
  }, 201)
  expect(room.member_count).toBe(2)
  const list = (token: string) => h.api<Channel[]>('GET', '/api/channels', token)
  expect((await list(outsider.token)).some(channel => channel.id === room.id)).toBe(false)
  await h.api('GET', `/api/channels/${room.id}/messages`, outsider.token, undefined, 404)
  const dm = await h.api<Channel>('POST', '/api/channels/dm', admin.token, { target_user_id: member.user.id })
  const dmFromPeer = await h.api<Channel>('POST', '/api/channels/dm', member.token, { target_user_id: admin.user.id })
  expect(dm.id).toBe(dmFromPeer.id)
  expect(dm.dm_peer?.id).toBe(member.user.id)
  const base = `/api/channels/${room.id}/messages`
  const send = (content: string, thread_root_id?: string) => h.api<Message>('POST', base, admin.token, { content, thread_root_id }, 201)
  const first = await send('first')
  const second = await send('second')
  const reply = await send('reply', first.id)
  await h.api('POST', base, member.token, { content: 'deep reply', thread_root_id: reply.id }, 404)
  const reader = client(h.wsUrl, member.token)
  await vi.waitFor(() => expect(reader.events[0]?.type).toBe('ready'))
  expect((await list(member.token)).find(channel => channel.id === room.id)?.unread_count).toBe(3)
  reader.ws.send(JSON.stringify({ type: 'read.ack', channel_id: room.id, last_read_message_id: second.id }))
  await vi.waitFor(() => expect(reader.events).toContainEqual(expect.objectContaining({
    type: 'channel.updated', channel: expect.objectContaining({ unread_count: 1 }),
  })))
  await h.api('POST', `/api/channels/${room.id}/read`, member.token, { last_read_message_id: first.id })
  expect((await list(member.token)).find(channel => channel.id === room.id)?.unread_count).toBe(1)
  const page = await h.api<{ messages: Message[]; next_before: string }>('GET', base + '?limit=1', member.token)
  expect(page.messages.map(message => message.id)).toEqual([second.id])
  const past = await h.api<{ messages: Message[] }>('GET', base + '?before=' + page.next_before, member.token)
  expect(past.messages.map(message => [message.id, message.reply_count, message.author.username])).toEqual([[first.id, 1, 'admin']])
  const thread = await h.api<{ messages: Message[] }>('GET', base + '?thread_root_id=' + first.id, member.token)
  expect(thread.messages.map(message => message.id)).toEqual([reply.id])
  await h.api('PATCH', `/api/channels/${room.id}`, admin.token, { pinned_message_id: first.id })
  await h.api('PATCH', `/api/messages/${first.id}`, member.token, { content: 'edit' }, 403)
  await h.api('PATCH', `/api/messages/${first.id}`, admin.token, { content: 'edit' })
  await h.api('DELETE', `/api/messages/${second.id}`, admin.token)
  const stable = await h.api<{ messages: Message[] }>('GET', base + '?before=' + page.next_before, member.token)
  expect(stable.messages.map(message => message.id)).toEqual([first.id])
  await h.api('DELETE', `/api/messages/${first.id}`, admin.token)
  await vi.waitFor(() => expect(reader.events.filter(event => event.type === 'message.deleted').map(event => event.message_id).sort())
    .toEqual([first.id, second.id, reply.id].sort()))
  expect((await list(member.token)).find(channel => channel.id === room.id)?.pinned_message_id).toBeNull()
  await h.api('DELETE', `/api/channels/${room.id}/members/${member.user.id}`, admin.token)
  await vi.waitFor(() => expect(reader.events).toContainEqual({ type: 'channel.removed', channel_id: room.id }))
})

test('validates uploads and serves exact bytes with the registered MIME and cache policy', async () => {
  const h = await harness()
  const user = await h.person('admin')
  const form = new FormData()
  form.append('file', new Blob(['export const x = 1\n'], { type: 'application/octet-stream' }), 'source.ts')
  const uploaded = await h.api<Attachment>('POST', '/api/uploads', user.token, form, 201)
  expect(uploaded).toMatchObject({ name: 'source.ts', mime: 'text/plain', size: 19 })
  await h.api('GET', uploaded.url, undefined, undefined, 401)
  const response = await h.raw('GET', uploaded.url, user.token)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('export const x = 1\n')
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('Content-Type')).toBe('text/plain')
  expect(response.headers.get('Content-Disposition')).toBe('attachment')
  await h.api('GET', '/uploads/%2e%2e%2fchiorim.db', user.token, undefined, 404)
  const svg = new FormData()
  svg.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg')
  await h.api('POST', '/api/uploads', user.token, svg, 415)
})

test('encrypts Provider keys, redacts every response, probes models and nulls deleted provider references', async () => {
  const h = await harness()
  const base = await upstream((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer durable-secret') { res.writeHead(401).end(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
  })
  const user = await h.person('admin')
  const input = { name: 'Local', type: 'openai_compat', base_url: base + '/v1', api_key: 'durable-secret', models: ['local-model'] }
  const provider = await h.api<Provider>('POST', '/api/providers', user.token, input, 201)
  expect(provider.has_api_key).toBe(true)
  expect(provider.api_key_masked).toBe('••••••••')
  expect(JSON.stringify(provider)).not.toContain(input.api_key)
  const disk = h.sqlite.prepare('SELECT api_key_enc FROM providers WHERE id=?').get(provider.id) as { api_key_enc: string }
  expect(disk.api_key_enc).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
  expect(disk.api_key_enc).not.toContain(input.api_key)
  expect(readFileSync(join(h.dataDir, '.secret'), 'utf8')).toMatch(/^[a-f0-9]{64}$/)
  const reopened = openDatabase(join(h.dataDir, 'chiorim.db'))
  expect(reopened.sqlite.prepare('SELECT count(*) AS total FROM providers').get()).toEqual({ total: 1 })
  reopened.sqlite.close()
  expect(await h.api('POST', `/api/providers/${provider.id}/test`, user.token)).toEqual({ ok: true, models: ['local-model'] })
  expect(await h.api<Provider[]>('GET', '/api/providers', user.token)).toEqual([provider])
  const bot = await h.api<Bot>('POST', '/api/bots', user.token, {
    mode: 'provider', username: 'helper', display_name: 'Helper', model: 'local-model', provider_id: provider.id,
  }, 201)
  expect((await h.api<Provider>('PATCH', `/api/providers/${provider.id}`, user.token, { api_key: '' })).has_api_key).toBe(false)
  await h.api('DELETE', `/api/providers/${provider.id}`, user.token)
  expect((await h.api<Bot[]>('GET', '/api/bots', user.token)).find(row => row.user_id === bot.user_id)?.provider_id).toBeNull()
})

test('returns an authorized, sorted channel roster and fetches pinned messages by ID beyond the first page', async () => {
  const h = await harness()
  const admin = await h.person('z_admin')
  const participant = await h.person('a_member', await h.invite(admin.token))
  const outsider = await h.person('outsider', await h.invite(admin.token))
  const room = await h.api<Channel>('POST', '/api/channels', admin.token, {
    type: 'private', name: 'Audit room', member_ids: [participant.user.id],
  }, 201)
  const bot = await h.api<Bot>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'b_agent', display_name: 'Agent', driver_hint: 'custom', channel_ids: [room.id],
  }, 201)
  const live = client(h.wsUrl, participant.token)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  const memberPath = `/api/channels/${room.id}/members`
  const roster = memberListSchema.parse(await h.api('GET', memberPath, admin.token))
  expect(roster.map(member => member.username)).toEqual(['a_member', 'b_agent', 'z_admin'])
  expect(roster[0]).toMatchObject({ online: true, bot: null })
  expect(roster[1]).toMatchObject({ id: bot.user_id, online: false, bot: { mode: 'bridge', driver_hint: 'custom', runtime_meta: null } })
  expect(roster).toEqual((await h.api<Member[]>('GET', '/api/users', admin.token)).filter(member => member.id !== outsider.user.id))
  await h.api('GET', memberPath, outsider.token, undefined, 404)
  await h.api('GET', memberPath, undefined, undefined, 401)

  const base = `/api/channels/${room.id}/messages`
  const pinned = await h.api<Message>('POST', base, admin.token, { content: 'pinned' }, 201)
  const newer = await h.api<Message>('POST', base, admin.token, { content: 'newer' }, 201)
  await h.api('PATCH', `/api/channels/${room.id}`, admin.token, { pinned_message_id: pinned.id })
  expect((await h.api<{ messages: Message[] }>('GET', base + '?limit=1', participant.token)).messages.map(row => row.id)).toEqual([newer.id])
  expect(messageSchema.parse(await h.api('GET', `/api/messages/${pinned.id}`, participant.token))).toEqual(pinned)
  await h.api('GET', `/api/messages/${pinned.id}`, outsider.token, undefined, 404)
  await h.api('GET', `/api/messages/${pinned.id}`, undefined, undefined, 401)
})

test('broadcasts registration, profile changes, and Bot additions, edits and deletions to online clients', async () => {
  const h = await harness()
  const admin = await h.person('admin')
  const live = client(h.wsUrl, admin.token)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  const user = await h.person('guest', await h.invite(admin.token))
  async function memberUpdated(id: string, name: string) {
    await vi.waitFor(() => expect(live.events).toContainEqual(expect.objectContaining({
      type: 'member.updated', member: expect.objectContaining({ id, display_name: name }),
    })))
  }
  await memberUpdated(user.user.id, 'GUEST')
  await h.api('PATCH', '/api/users/me', user.token, { display_name: 'Guest Name', bio: 'Bonjour' })
  await memberUpdated(user.user.id, 'Guest Name')
  const bot = await h.api<Bot>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'bridge_agent', display_name: 'New Agent', driver_hint: 'codex',
  }, 201)
  await memberUpdated(bot.user_id, 'New Agent')
  await h.api('PATCH', `/api/bots/${bot.user_id}`, admin.token, { display_name: 'Updated Agent', driver_hint: 'custom' })
  await memberUpdated(bot.user_id, 'Updated Agent')
  expect(live.events).toContainEqual(expect.objectContaining({
    type: 'member.updated', member: expect.objectContaining({
      id: bot.user_id, online: false, bot: expect.objectContaining({ mode: 'bridge', driver_hint: 'custom' }),
    }),
  }))
  await h.api('DELETE', `/api/bots/${bot.user_id}`, admin.token)
  await vi.waitFor(() => expect(live.events).toContainEqual({ type: 'member.removed', user_id: bot.user_id }))
})

test('accepts source names with blank browser MIME and keeps explicit MIME intact', async () => {
  for (const name of ['config.yaml', 'entry.ts', 'View.svelte', 'README.MD']) expect(uploadMime('', name)).toBe('text/plain')
  expect(uploadMime('', 'file.bin')).toBe('')
  expect(uploadMime('image/svg+xml', 'entry.ts')).toBe('image/svg+xml')
  const h = await harness()
  const user = await h.person('admin')
  const file = new File(['<div>Component</div>'], 'View.svelte')
  expect(file.type).toBe('')
  const form = new FormData()
  form.append('file', file)
  expect(await h.api<Attachment>('POST', '/api/uploads', user.token, form, 201)).toMatchObject({
    name: 'View.svelte', mime: 'text/plain', size: file.size,
  })
})
