import { once } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { Attachment, AuthResponse, SessionInfo } from '@chiorim/shared'
import { client, harness } from './support.js'

const original = 'chior-password'
const changed = 'new-chior-password'
const login = (username: string, password = original) => ({ username, password })

test('uses sliding windows with separate login identities, IP registration limits and Retry-After', async () => {
  const h = await harness({ rateLimit: true })
  const user = await h.person('admin')
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    for (let index = 0; index < 10; index++) {
      await h.api('POST', '/api/auth/login', undefined, login('admin', 'incorrect password'), 401)
    }
    const result = await h.raw('POST', '/api/auth/login', undefined, login('admin'), { 'x-forwarded-for': '192.0.2.1' })
    expect(result.status).toBe(429)
    expect(result.headers.get('Retry-After')).toBe('300')
    expect(await result.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    await h.api('POST', '/api/auth/login', undefined, login('someone'), 401)
    clock.mockReturnValue(now + 300_001)
    await h.api('POST', '/api/auth/login', undefined, login('admin'))
    for (let index = 0; index < 4; index++) {
      await h.api('POST', '/api/auth/register', undefined, { ...login('somebody'), display_name: 'Somebody' }, 403)
    }
    const response = await h.raw('POST', '/api/auth/register', undefined, {
      ...login('somebody'), display_name: 'Somebody', invite_code: await h.invite(user.token),
    })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  } finally { clock.mockRestore() }
})

test('probes a session without 401, records devices and renews a valid cookie after five minutes', async () => {
  const h = await harness()
  expect(await h.api('GET', '/api/auth/session')).toEqual({ initialized: false, user: null })
  const response = await h.raw('POST', '/api/auth/register', undefined, {
    ...login('admin'), display_name: 'Admin',
  }, { 'User-Agent': 'chior-device-fixture' })
  expect(response.status).toBe(201)
  const auth = await response.json() as AuthResponse
  expect(await h.api('GET', '/api/auth/session')).toEqual({ initialized: true, user: null })
  expect(await h.api('GET', '/api/auth/session', '0'.repeat(64))).toEqual({ initialized: true, user: null })
  const before = (await h.api<SessionInfo[]>('GET', '/api/auth/sessions', auth.token))[0]
  expect(before).toMatchObject({ current: true, user_agent: 'chior-device-fixture', ip_address: '127.0.0.1' })
  expect(before.id).not.toBe(auth.token)
  expect(before.last_active_at).toBe(before.created_at)
  h.sqlite.prepare('UPDATE sessions SET last_active_at=?, expires_at=? WHERE id=?')
    .run(Date.now() - 300_001, Date.now() + 60_000, before.id)
  const probe = await h.raw('GET', '/api/auth/session', undefined, undefined, { Cookie: `chior_session=${auth.token}` })
  expect(await probe.json()).toEqual({ initialized: true, user: auth.user })
  expect(probe.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
  const after = (await h.api<SessionInfo[]>('GET', '/api/auth/sessions', auth.token))[0]
  expect(after.expires_at - after.last_active_at).toBe(2_592_000_000)
  expect(h.sqlite.pragma('user_version', { simple: true })).toBe(3)
})

test('changes passwords and revokes individual or other devices immediately over WebSocket', async () => {
  const h = await harness()
  const auth = await h.person('admin')
  const other = await h.api<AuthResponse>('POST', '/api/auth/login', undefined, login('admin'))
  const live = client(h.wsUrl, other.token)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  const ended = once(live.ws, 'close')
  await h.api('POST', '/api/auth/change-password', auth.token, { current_password: 'not-my-password', new_password: changed }, 401)
  await h.api('POST', '/api/auth/change-password', auth.token, { current_password: original, new_password: changed })
  expect((await ended)[0]).toBe(4001)
  await h.api('GET', '/api/auth/me', other.token, undefined, 401)
  await h.api('POST', '/api/auth/login', undefined, login('admin'), 401)
  const another = await h.api<AuthResponse>('POST', '/api/auth/login', undefined, login('admin', changed))
  const devices = await h.api<SessionInfo[]>('GET', '/api/auth/sessions', auth.token)
  expect(devices).toHaveLength(2)
  await h.api('DELETE', '/api/auth/sessions/' + devices.find(row => !row.current)!.id, auth.token)
  await h.api('GET', '/api/auth/me', another.token, undefined, 401)
  const fourth = await h.api<AuthResponse>('POST', '/api/auth/login', undefined, login('admin', changed))
  await h.api('POST', '/api/auth/sessions/revoke-others', auth.token)
  await h.api('GET', '/api/auth/me', fourth.token, undefined, 401)
  await h.api('GET', '/api/auth/me', auth.token)
})

test('updates presence and gates admin disabling, roles and password resets', async () => {
  const h = await harness()
  const admin = await h.person('admin')
  const member = await h.person('friend', await h.invite(admin.token))
  const adminSocket = client(h.wsUrl, admin.token)
  const memberSocket = client(h.wsUrl, member.token)
  const memberPath = '/api/admin/users/' + member.user.id
  await vi.waitFor(() => expect(memberSocket.events[0]?.type).toBe('ready'))
  await h.api('PATCH', '/api/users/me', member.token, { presence_status: 'busy', status_text: 'Deep work' })
  await vi.waitFor(() => expect(adminSocket.events).toContainEqual(expect.objectContaining({
    type: 'member.updated', member: expect.objectContaining({ id: member.user.id, presence_status: 'busy', status_text: 'Deep work' }),
  })))
  await h.api('PATCH', memberPath, member.token, { is_admin: true }, 403)
  await h.api('PATCH', '/api/admin/users/' + admin.user.id, admin.token, { disabled: true }, 400)
  await h.api('PATCH', '/api/admin/users/' + admin.user.id, admin.token, { is_admin: false }, 400)
  await h.api('PATCH', memberPath, admin.token, { is_admin: true })
  expect(await h.api('GET', '/api/auth/me', member.token)).toMatchObject({ is_admin: true })
  const loggedOut = once(memberSocket.ws, 'close')
  await h.api('PATCH', memberPath, admin.token, { disabled: true, is_admin: false })
  expect((await loggedOut)[0]).toBe(4001)
  expect(await h.api('GET', '/api/auth/session', member.token)).toEqual({ initialized: true, user: null })
  expect(await h.api('POST', '/api/auth/login', undefined, login('friend'), 403)).toMatchObject({ error: { code: 'ACCOUNT_DISABLED' } })
  await vi.waitFor(() => expect(adminSocket.events).toContainEqual(expect.objectContaining({
    type: 'member.updated', member: expect.objectContaining({ id: member.user.id, disabled: true, online: false }),
  })))
  await h.api('PATCH', memberPath, admin.token, { disabled: false })
  const again = await h.api<AuthResponse>('POST', '/api/auth/login', undefined, login('friend'))
  const socket = client(h.wsUrl, again.token)
  await vi.waitFor(() => expect(socket.events[0]?.type).toBe('ready'))
  const ended = once(socket.ws, 'close')
  await h.api('POST', memberPath + '/reset-password', admin.token, { new_password: changed })
  expect((await ended)[0]).toBe(4001)
  await h.api('GET', '/api/auth/me', again.token, undefined, 401)
  await h.api('POST', '/api/auth/login', undefined, login('friend'), 401)
  await h.api('POST', '/api/auth/login', undefined, login('friend', changed))
})

test('allows explicit public upload hosting and retains cache control', async () => {
  const h = await harness({ publicUploads: true })
  const owner = await h.person('admin')
  const form = new FormData()
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt')
  const file = await h.api<Attachment>('POST', '/api/uploads', owner.token, form, 201)
  const response = await h.raw('GET', file.url)
  expect(await response.text()).toBe('hello')
  expect(response.headers.get('Cache-Control')).toContain('public')
})
