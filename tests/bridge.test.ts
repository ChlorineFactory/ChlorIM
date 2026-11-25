import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Bot, BotWriteResponse, Channel, Message } from '@chiorim/shared'
import { pathsFor, saveConfig } from '../packages/bridge/src/config.js'
import type { AgentConfig } from '../packages/bridge/src/config.js'
import { startDaemon } from '../packages/bridge/src/daemon.js'
import { launchdPlist, systemdUnit } from '../packages/bridge/src/service.js'
import { cleanup, client, harness, socket } from './support.js'

test('runs a multi-Agent Bridge daemon, resumes custom sessions, aborts a subprocess, rejects users, and rotates tokens', async () => {
  const h = await harness()
  const admin = await h.person('admin')
  const member = await h.person('member', await h.invite(admin.token))
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'localbot', display_name: 'Local bot', driver_hint: 'custom',
  }, 201)
  expect(bot.bot_token).toMatch(/^chior_bot_[a-f0-9]{64}$/)
  expect(bot.connect_command).toContain('chior-bridge add')
  const secondary = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'secondary', display_name: 'Secondary Bot', driver_hint: 'custom',
  }, 201)
  const stored = () => h.sqlite.prepare('SELECT token_hash, runtime_meta_json FROM bots WHERE user_id=?').get(bot.user_id) as {
    token_hash: string; runtime_meta_json: string | null
  }
  expect(stored().token_hash).toBe(createHash('sha256').update(bot.bot_token!).digest('hex'))
  const botList = () => h.api<Bot[]>('GET', '/api/bots', admin.token)
  expect(JSON.stringify(await botList())).not.toContain(bot.bot_token)
  const dm = await h.api<Channel>('POST', '/api/channels/dm', admin.token, { target_user_id: bot.user_id })
  const messageUrl = (id: string) => `/api/channels/${id}/messages`
  const send = (id: string, content: string, token = admin.token) =>
    h.api<Message>('POST', messageUrl(id), token, { content }, 201)
  const listMessages = async (id: string, token = admin.token) =>
    (await h.api<{ messages: Message[] }>('GET', messageUrl(id), token)).messages

  await send(dm.id, 'offline test')
  const queuedOffline = (await listMessages(dm.id))[0]
  expect(queuedOffline).toMatchObject({ status: 'queued' })
  await h.api('POST', `/api/messages/${queuedOffline.id}/abort`, admin.token)
  expect((await listMessages(dm.id))[0]).toMatchObject({ status: 'aborted' })
  const script = join(h.dataDir, 'fixture.mjs')
  const cancelled = join(h.dataDir, 'cancelled')
  const invoked = join(h.dataDir, 'invoked')
  writeFileSync(script, `
import { appendFileSync, writeFileSync } from 'node:fs'
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const request = JSON.parse(Buffer.concat(chunks).toString())
const [cancelled, invoked] = process.argv.slice(2)
appendFileSync(invoked, request.sender.username + '\\n')
if (request.prompt === 'slow') {
  process.on('SIGTERM', () => { writeFileSync(cancelled, 'yes'); process.exit(0) })
  console.log(JSON.stringify({ type: 'text', delta: 'partial' }))
  setInterval(() => {}, 1000)
} else {
  console.log(JSON.stringify({ type: 'thinking', delta: 'local thought' }))
  console.log(JSON.stringify({ type: 'tool_start', tool: { id: '1', name: 'fixture', status: 'running', input: 'details' } }))
  console.log(JSON.stringify({ type: 'tool_end', tool: { id: '1', name: 'fixture', status: 'done', output: 'ok' } }))
  console.log(JSON.stringify({ type: 'text', delta: request.external_session_id ? 'resumed ' + request.external_session_id : 'new' }))
  console.log(JSON.stringify({ type: 'done', external_session_id: 'custom-session' }))
}
`)
  const paths = pathsFor(join(h.dataDir, 'bridge.yaml'))
  const definition: AgentConfig = {
    name: 'localbot', token: bot.bot_token!, driver: 'custom', cwd: h.dataDir, permission_mode: 'default',
    allowed_users: ['admin'], env: {}, command: process.execPath, args: [script, cancelled, invoked],
  }
  const save = (token: string) => saveConfig(paths.config, { server: h.wsUrl, agents: [{ ...definition, token }] })
  saveConfig(paths.config, { server: h.wsUrl, agents: [
    definition, { ...definition, name: 'secondary', token: secondary.bot_token! },
  ] })
  const stream = client(h.wsUrl, admin.token)
  await vi.waitFor(() => expect(stream.events[0]?.type).toBe('ready'))
  const daemon = startDaemon(paths)
  cleanup(daemon.stop)
  await vi.waitFor(async () => expect((await botList())[0]).toMatchObject({ online: true, runtime_meta: { driver: 'custom', cwd: h.dataDir } }))
  expect(JSON.parse(stored().runtime_meta_json!)).toMatchObject({ driver: 'custom' })
  await vi.waitFor(async () => expect((await botList()).filter(row => row.online)).toHaveLength(2))
  save(bot.bot_token!)
  daemon.reload()
  await vi.waitFor(async () => expect((await botList()).filter(row => row.online).map(row => row.user_id)).toEqual([bot.user_id]))
  await h.api('DELETE', `/api/bots/${secondary.user_id}`, admin.token)

  await send(dm.id, 'first run')
  await vi.waitFor(async () => expect((await listMessages(dm.id))[0]).toMatchObject({
    status: 'done', content: 'new', blocks: [
      { type: 'thinking', text: 'local thought' }, { type: 'tool_call', name: 'fixture', status: 'done', input: 'details', output: 'ok' },
    ],
  }))
  expect(h.sqlite.prepare('SELECT scope_key, external_session_id FROM bot_sessions WHERE bot_id=?').get(bot.user_id))
    .toEqual({ scope_key: `channel:${dm.id}`, external_session_id: 'custom-session' })
  await send(dm.id, 'second run')
  await vi.waitFor(async () => expect((await listMessages(dm.id))[0]).toMatchObject({ status: 'done', content: 'resumed custom-session' }))
  await send(dm.id, 'slow')
  const partial = await vi.waitFor(() => {
    const event = stream.events.find(event => event.type === 'message.delta' && event.delta === 'partial')
    expect(event).toBeDefined()
    return event!
  })
  if (partial.type !== 'message.delta') throw new Error('Expected a streaming delta')
  await h.api('POST', `/api/messages/${partial.message_id}/abort`, admin.token)
  await vi.waitFor(() => expect(existsSync(cancelled)).toBe(true))
  expect((await listMessages(dm.id))[0]).toMatchObject({ status: 'aborted', content: 'partial' })

  const memberDm = await h.api<Channel>('POST', '/api/channels/dm', member.token, { target_user_id: bot.user_id })
  await send(memberDm.id, 'blocked', member.token)
  await vi.waitFor(async () => expect((await listMessages(memberDm.id, member.token))[0]).toMatchObject({
    status: 'error', error_message: expect.stringContaining('allowed_users'),
  }))
  expect(readFileSync(invoked, 'utf8').trim().split('\n')).toEqual(['admin', 'admin', 'admin'])
  await h.api('POST', `/api/bots/${bot.user_id}/rotate-token`, member.token, undefined, 403)
  const rotated = await h.api<{ bot_token: string }>('POST', `/api/bots/${bot.user_id}/rotate-token`, admin.token)
  expect(rotated.bot_token).not.toBe(bot.bot_token)
  expect(stored().token_hash).toBe(createHash('sha256').update(rotated.bot_token).digest('hex'))
  expect((await botList())[0].online).toBe(false)
  const stale = socket(h.wsUrl + '/ws/bridge', { Authorization: `Bearer ${bot.bot_token}` })
  const rejected = await new Promise<number | undefined>(resolve => {
    stale.once('unexpected-response', (request, response) => {
      response.resume()
      request.destroy()
      stale.terminate()
      resolve(response.statusCode)
    })
  })
  expect(rejected).toBe(401)
  save(rotated.bot_token)
  daemon.reload()
  await vi.waitFor(async () => expect((await botList())[0].online).toBe(true))
  await h.api('DELETE', `/api/bots/${bot.user_id}`, admin.token)
  expect(await botList()).toEqual([])
  expect((await h.api<Channel[]>('GET', '/api/channels', admin.token)).some(channel => channel.id === dm.id)).toBe(false)
})

test('generates service templates with the absolute runtime, CLI and escaped shell PATH', () => {
  const options = {
    node: '/opt/homebrew/bin/node', cli: '/Work & Notes/chior/cli.js',
    config: '/Home/me/$project 100%/bridge.yaml', path: '/opt/homebrew/bin:/Work & Notes/bin', logs: '/Home/me/.chiorim/logs',
  }
  const plist = launchdPlist(options)
  expect(plist).toContain('<key>RunAtLoad</key><true/>')
  expect(plist).toContain('<key>KeepAlive</key><true/>')
  expect(plist).toContain('<string>/opt/homebrew/bin/node</string>')
  expect(plist).toContain('<string>/Work &amp; Notes/chior/cli.js</string>')
  expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/Work &amp; Notes/bin</string>')
  expect(plist).toContain('/Home/me/.chiorim/logs/service.err.log')
  const unit = systemdUnit(options)
  expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/Work & Notes/bin"')
  expect(unit).toContain('ExecStart="/opt/homebrew/bin/node" "/Work & Notes/chior/cli.js" "--config" "/Home/me/$$project 100%%/bridge.yaml" "run"')
  expect(unit).toContain('WantedBy=default.target')
})

test('sends attachment names to a Bridge in both the message context and current prompt', async () => {
  const h = await harness()
  const user = await h.person('admin')
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', user.token, {
    mode: 'bridge', username: 'attachment_bot', display_name: 'Files', driver_hint: 'custom',
  }, 201)
  const bridge = socket(h.wsUrl + '/ws/bridge', { Authorization: `Bearer ${bot.bot_token}` })
  const frames: unknown[] = []
  bridge.on('message', raw => frames.push(JSON.parse(raw.toString())))
  await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'bridge.welcome' }))
  bridge.send(JSON.stringify({ type: 'bridge.hello', hostname: 'fixture', driver: 'custom', cwd: '/project' }))
  const room = await h.api<Channel>('POST', '/api/channels/dm', user.token, { target_user_id: bot.user_id })
  await vi.waitFor(async () => expect(await h.api('GET', `/api/channels/${room.id}/members`, user.token)).toContainEqual(expect.objectContaining({
    id: bot.user_id, online: true, bot: expect.objectContaining({ runtime_meta: { hostname: 'fixture', driver: 'custom', cwd: '/project' } }),
  })))
  await h.api('POST', `/api/channels/${room.id}/messages`, user.token, {
    content: '', attachments: [{ name: 'draft.md', size: 4, mime: 'text/plain', url: '/uploads/' + 'd'.repeat(32) }],
  }, 201)
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
    type: 'run.start', prompt: '[Attachments: draft.md]',
    context: [expect.objectContaining({ content: '[Attachments: draft.md]' })],
  })))
})
