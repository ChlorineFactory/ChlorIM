import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { BotWriteResponse, BridgeDevice, BridgeFsList, Channel, LocalAgentStatus, Message, Workspace } from '@chiorim/shared'
import { cleanup, client, harness } from './support.js'

function createFakeCodex(binDir: string) {
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdin += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(stdin)
  if (payload.message.includes('SLEEP_FOREVER')) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_slow' }))
    setInterval(() => {}, 10_000)
    return
  }
  const resumeIdx = args.indexOf('resume')
  const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null
  const sessionId = resumed || 'thr_local_1'
  console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'checking cwd' } }))
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'tool_1', type: 'command_execution', command: 'pwd' } }))
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'tool_1', type: 'command_execution', command: 'pwd', aggregated_output: process.cwd(), status: 'completed' } }))
  const reply = JSON.stringify({
    cwd: fs.realpathSync(process.cwd()),
    resumed,
    approval: args[args.indexOf('--ask-for-approval') + 1],
    sandbox: args[args.indexOf('--sandbox') + 1],
    model: args.includes('-m') ? args[args.indexOf('-m') + 1] : null,
    prompt: payload.message,
  })
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
})
`
  const file = join(binDir, 'codex')
  writeFileSync(file, script, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

test('runs same-host local agent directly without chior-bridge, supports folder routing, session resume, fs browse and abort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chiorim-local-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))
  const binDir = join(root, 'bin')
  const projects = join(root, 'projects')
  const repoA = join(projects, 'repo-alpha')
  const subWeb = join(repoA, 'apps', 'web')
  const outside = join(root, 'outside')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(subWeb, { recursive: true })
  mkdirSync(outside, { recursive: true })
  createFakeCodex(binDir)

  const h = await harness({
    localAgent: {
      enabled: true,
      allowedRoots: [projects],
      defaultCwd: projects,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    },
  })
  const admin = await h.person('admin')
  const member = await h.person('member', await h.invite(admin.token))

  const status = await h.api<LocalAgentStatus>('GET', '/api/local-agents/status', admin.token)
  expect(status.enabled).toBe(true)
  expect(status.drivers.codex.available).toBe(true)
  expect(status.allowed_roots).toEqual([realpathSync(projects)])

  // Non-admin cannot create local agent; custom driver and outside cwd rejected.
  await h.api('POST', '/api/bots', member.token, {
    mode: 'local', username: 'no_perm', display_name: 'No Perm', driver_hint: 'codex',
  }, 403)
  await h.api('POST', '/api/bots', admin.token, {
    mode: 'local', username: 'bad_custom', display_name: 'Bad', driver_hint: 'custom',
  }, 400)
  await h.api('POST', '/api/bots', admin.token, {
    mode: 'local', username: 'bad_dir', display_name: 'Bad Dir', driver_hint: 'codex', local_cwd: outside,
  }, 400)

  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'local',
    username: 'local_codex',
    display_name: 'Local Codex',
    driver_hint: 'codex',
    permission_mode: 'auto',
    model: 'o3-mini',
    local_cwd: repoA,
  }, 201)
  expect(bot.mode).toBe('local')
  expect(bot.online).toBe(true)
  expect(bot.bot_token).toBeUndefined()
  expect(bot.connect_command).toBeUndefined()
  expect(bot.runtime_meta).toMatchObject({ driver: 'codex', cwd: realpathSync(repoA), version: 'local' })

  // Appears in /api/bridges device list and supports remote-style folder browsing.
  const devices = await h.api<BridgeDevice[]>('GET', '/api/bridges', admin.token)
  expect(devices).toContainEqual(expect.objectContaining({
    bot_id: bot.user_id, username: 'local_codex', online: true, driver: 'codex',
  }))
  const rootList = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs`, admin.token)
  expect(rootList.entries.map(e => e.path)).toEqual([realpathSync(projects)])
  const childList = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(projects)}`, admin.token)
  expect(childList.entries.map(e => e.name)).toEqual(['repo-alpha'])
  await h.api('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(outside)}`, admin.token, undefined, 400)

  // Create folder workspace + sub-folder channel bound to local bot.
  const ws = await h.api<Workspace>('POST', '/api/workspaces', admin.token, {
    name: 'Repo Alpha', work_dir: repoA, host_bot_id: bot.user_id, create_default_channel: false,
  }, 201)
  const room = await h.api<Channel>('POST', '/api/channels', admin.token, {
    type: 'public', name: 'web', workspace_id: ws.id, work_dir: 'apps/web',
  }, 201)
  await h.api('POST', `/api/channels/${room.id}/members`, admin.token, { member_ids: [bot.user_id] })

  const live = client(h.wsUrl, admin.token)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  expect(live.events[0]).toMatchObject({
    type: 'ready',
    bridge_runtimes: { [bot.user_id]: expect.objectContaining({ driver: 'codex', version: 'local' }) },
  })

  // First turn: spawns local codex in subWeb cwd with auto permission and model override.
  await h.api('POST', `/api/channels/${room.id}/messages`, admin.token, { content: '@local_codex hello' }, 201)
  let firstReply: Message | undefined
  await vi.waitFor(async () => {
    const page = await h.api<{ messages: Message[] }>('GET', `/api/channels/${room.id}/messages`, admin.token)
    firstReply = page.messages.find(m => m.author_id === bot.user_id && m.status === 'done')
    expect(firstReply).toBeDefined()
  }, { timeout: 5000 })
  const parsedFirst = JSON.parse(firstReply!.content) as Record<string, unknown>
  expect(parsedFirst).toMatchObject({
    cwd: realpathSync(subWeb),
    resumed: null,
    approval: 'never',
    sandbox: 'workspace-write',
    model: 'o3-mini',
    prompt: '@local_codex hello',
  })
  expect(firstReply!.blocks.some(b => b.type === 'thinking')).toBe(true)
  expect(firstReply!.blocks.some(b => b.type === 'tool_call' && b.status === 'done')).toBe(true)

  // Second turn: resumes saved external_session_id automatically.
  await h.api('POST', `/api/channels/${room.id}/messages`, admin.token, { content: '@local_codex follow-up' }, 201)
  let secondReply: Message | undefined
  await vi.waitFor(async () => {
    const page = await h.api<{ messages: Message[] }>('GET', `/api/channels/${room.id}/messages`, admin.token)
    secondReply = page.messages.find(m => m.author_id === bot.user_id && m.id !== firstReply!.id && m.status === 'done')
    expect(secondReply).toBeDefined()
  }, { timeout: 5000 })
  expect(JSON.parse(secondReply!.content)).toMatchObject({ resumed: 'thr_local_1' })

  // /status and /reset work seamlessly for local bots.
  const cmdStatus = await h.api<{ ok: true; message: string }>('POST', `/api/channels/${room.id}/command`, admin.token, { command: '/status' })
  expect(cmdStatus.message).toContain('@local_codex online')
  expect(cmdStatus.message).toContain('codex')
  const cmdReset = await h.api<{ ok: true; message: string }>('POST', `/api/channels/${room.id}/command`, admin.token, { command: '/reset @local_codex' })
  expect(cmdReset.message).toContain('1')

  // Abort kills a long-running local CLI process promptly.
  await h.api('POST', `/api/channels/${room.id}/messages`, admin.token, { content: '@local_codex SLEEP_FOREVER' }, 201)
  let running: Message | undefined
  await vi.waitFor(async () => {
    const page = await h.api<{ messages: Message[] }>('GET', `/api/channels/${room.id}/messages`, admin.token)
    running = page.messages.find(m => m.author_id === bot.user_id && m.status === 'streaming')
    expect(running).toBeDefined()
  })
  await h.api('POST', `/api/messages/${running!.id}/abort`, admin.token)
  await vi.waitFor(async () => {
    const page = await h.api<{ messages: Message[] }>('GET', `/api/channels/${room.id}/messages`, admin.token)
    const stopped = page.messages.find(m => m.id === running!.id)
    expect(stopped?.status).toBe('aborted')
  })
})

test('blocks local agent creation when disabled via server option', async () => {
  const h = await harness({ localAgent: { enabled: false } })
  const admin = await h.person('admin')
  const status = await h.api<LocalAgentStatus>('GET', '/api/local-agents/status', admin.token)
  expect(status.enabled).toBe(false)
  await h.api('POST', '/api/bots', admin.token, {
    mode: 'local', username: 'disabled_local', display_name: 'Disabled', driver_hint: 'codex',
  }, 400)
})

test('auto-discovers CLIs in ~/.bun/bin and ~/.local/bin under minimal PATH and separates Hermes native credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chiorim-paths-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))
  const fakeHome = join(root, 'ubuntu')
  const bunBin = join(fakeHome, '.bun', 'bin')
  const localBin = join(fakeHome, '.local', 'bin')
  mkdirSync(bunBin, { recursive: true })
  mkdirSync(localBin, { recursive: true })
  for (const file of [join(bunBin, 'codex'), join(localBin, 'claude'), join(localBin, 'agy')]) {
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    chmodSync(file, 0o755)
  }

  const h = await harness({
    localAgent: {
      enabled: true,
      allowedRoots: [fakeHome],
      defaultCwd: fakeHome,
      env: { HOME: fakeHome, PATH: '/usr/bin:/bin' },
    },
  })
  const admin = await h.person('admin')
  const status = await h.api<LocalAgentStatus>('GET', '/api/local-agents/status', admin.token)
  expect(status.drivers.codex).toMatchObject({ available: true, path: join(bunBin, 'codex') })
  expect(status.drivers['claude-code']).toMatchObject({ available: true, path: join(localBin, 'claude') })
  expect(status.drivers.antigravity).toMatchObject({ available: true, path: join(localBin, 'agy') })
  expect('hermes' in status.drivers).toBe(false)

  // Hermes is rejected in local CLI mode and gets dedicated Hermes plugin credentials in native mode.
  await h.api('POST', '/api/bots', admin.token, {
    mode: 'local', username: 'bad_hermes', display_name: 'Hermes', driver_hint: 'hermes',
  }, 400)
  const hermesBot = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'hermes_native', display_name: 'Hermes', driver_hint: 'hermes',
  }, 201)
  expect(hermesBot.connect_command).toContain('CHLORIM_URL=')
  expect(hermesBot.connect_command).toContain('CHLORIM_BOT_TOKEN=')
  expect(hermesBot.connect_command).toContain('hermes plugins enable chlorim')
  expect(hermesBot.connect_command).not.toContain('chior-bridge')
})

test('manages host folders (mkdir, delete, git clone) and lets local AI create channels, react, and post replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chiorim-hostfs-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(home, { recursive: true })

  // Fake git binary to test clone URL normalization and folder creation without network access.
  const fakeGit = join(binDir, 'git')
  writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] !== 'clone' || args[1] !== '--') {
  console.error('unexpected git args: ' + args.join(' '))
  process.exit(2)
}
const target = path.join(process.cwd(), args[3])
fs.mkdirSync(target, { recursive: true })
fs.writeFileSync(path.join(target, 'CLONED_URL'), args[2])
`, { mode: 0o755 })
  chmodSync(fakeGit, 0o755)

  // Fake codex binary that uses injected CHIORIM_URL + CHIORIM_TOKEN to react, create a channel, and post in it.
  const fakeCodex = join(binDir, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env node
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { stdin += chunk })
process.stdin.on('end', async () => {
  const base = process.env.CHIORIM_URL
  const token = process.env.CHIORIM_TOKEN
  const wsId = process.env.CHIORIM_WORKSPACE_ID
  const triggerId = process.env.CHIORIM_TRIGGER_MESSAGE_ID
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  await fetch(base + '/api/messages/' + triggerId + '/reactions', {
    method: 'POST', headers, body: JSON.stringify({ emoji: '👀' }),
  })
  const chRes = await fetch(base + '/api/channels', {
    method: 'POST', headers, body: JSON.stringify({ type: 'public', name: 'ai-lab', workspace_id: wsId, topic: 'Created by local AI' }),
  })
  const ch = await chRes.json()
  await fetch(base + '/api/channels/' + ch.id + '/messages', {
    method: 'POST', headers, body: JSON.stringify({ content: 'Welcome to #' + ch.name }),
  })
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr_ai_ops' }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Created #' + ch.name } }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
})
`, { mode: 0o755 })
  chmodSync(fakeCodex, 0o755)

  const h = await harness({
    localAgent: {
      enabled: true,
      allowedRoots: [home],
      defaultCwd: home,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    },
  })
  const admin = await h.person('admin')
  const member = await h.person('member', await h.invite(admin.token))

  // Host FS defaults directly into home root, supports mkdir, git clone (owner/repo shorthand), and safe delete.
  const initial = await h.api<BridgeFsList>('GET', '/api/host/fs', admin.token)
  expect(initial.path).toBe(realpathSync(home))
  expect(initial.entries).toEqual([])

  await h.api('POST', '/api/host/fs/mkdir', member.token, { path: home, name: 'denied' }, 403)
  const created = await h.api<{ path: string; name: string }>('POST', '/api/host/fs/mkdir', admin.token, { path: home, name: 'my-work' }, 201)
  expect(created).toEqual({ path: realpathSync(join(home, 'my-work')), name: 'my-work' })
  await h.api('POST', '/api/host/fs/mkdir', admin.token, { path: home, name: 'my-work' }, 409)

  // Clone shorthand owner/repo expands to https://github.com/owner/repo.git and rejects flag injection.
  await h.api('POST', '/api/host/fs/clone', admin.token, { path: created.path, repo: '--upload-pack=evil' }, 400)
  const cloned = await h.api<{ path: string; name: string }>('POST', '/api/host/fs/clone', admin.token, {
    path: created.path, repo: 'ChlorineFactory/ChlorIM',
  }, 201)
  expect(cloned.name).toBe('ChlorIM')

  // Cannot delete root directory, but can delete created folders.
  await h.api('DELETE', `/api/host/fs?path=${encodeURIComponent(home)}`, admin.token, undefined, 400)
  await h.api('DELETE', `/api/host/fs?path=${encodeURIComponent(created.path)}`, admin.token)
  const afterDelete = await h.api<BridgeFsList>('GET', '/api/host/fs', admin.token)
  expect(afterDelete.entries).toEqual([])

  // Local AI bot reacts with emoji, creates a new channel, and posts in it autonomously!
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'local', username: 'ops_ai', display_name: 'Ops AI', driver_hint: 'codex',
  }, 201)
  const general = await h.general(admin.token)
  const trigger = await h.api<Message>('POST', `/api/channels/${general.id}/messages`, admin.token, {
    content: '@ops_ai 帮我建一个 ai-lab 频道并打招呼',
  }, 201)

  await vi.waitFor(async () => {
    const channels = await h.api<Channel[]>('GET', '/api/channels', admin.token)
    const aiLab = channels.find(c => c.name === 'ai-lab')
    expect(aiLab).toBeDefined()
    const msgs = await h.api<{ messages: Message[] }>('GET', `/api/channels/${aiLab!.id}/messages`, admin.token)
    expect(msgs.messages.some(m => m.content === 'Welcome to #ai-lab')).toBe(true)
    const triggerMsg = await h.api<Message>('GET', `/api/messages/${trigger.id}`, admin.token)
    expect(triggerMsg.reactions).toContainEqual(expect.objectContaining({ emoji: '👀', count: 1 }))
  }, { timeout: 5000 })
})
