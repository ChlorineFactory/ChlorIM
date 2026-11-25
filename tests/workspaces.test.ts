import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { BotWriteResponse, Channel, Message, Workspace } from '@chiorim/shared'
import { pathsFor, saveConfig } from '../packages/bridge/src/config.js'
import { startDaemon } from '../packages/bridge/src/daemon.js'
import { cleanup, harness } from './support.js'

test('manages folder workspaces, resolves channel subfolder work_dir, and routes Bridge agents inside allowed_roots', async () => {
  const h = await harness()
  const admin = await h.person('admin')

  // Default workspace seeded on bootstrap
  const initialWorkspaces = await h.api<Workspace[]>('GET', '/api/workspaces', admin.token)
  expect(initialWorkspaces).toHaveLength(1)
  expect(initialWorkspaces[0].name).toBe('客厅')

  const repoRoot = join(h.dataDir, 'repos', 'chiorim')
  const webDir = join(repoRoot, 'apps', 'web')
  const outsideDir = join(h.dataDir, 'secret-outside')
  mkdirSync(webDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  // Create a folder-bound workspace (auto-creates #general)
  const projectWs = await h.api<Workspace>('POST', '/api/workspaces', admin.token, {
    name: 'ChiorIM Repo',
    icon: 'CH',
    work_dir: repoRoot,
  }, 201)
  expect(projectWs.work_dir).toBe(repoRoot)

  // Reject path traversal in work_dir
  await h.api('POST', '/api/channels', admin.token, {
    type: 'public', name: 'bad', workspace_id: projectWs.id, work_dir: '../escape',
  }, 400)

  // Create a sub-folder channel and an outside-folder channel
  const webChannel = await h.api<Channel>('POST', '/api/channels', admin.token, {
    type: 'public', name: 'frontend', workspace_id: projectWs.id, work_dir: 'apps/web',
  }, 201)
  expect(webChannel.effective_work_dir).toBe(`${repoRoot}/apps/web`)

  const outsideChannel = await h.api<Channel>('POST', '/api/channels', admin.token, {
    type: 'public', name: 'outside', workspace_id: projectWs.id, work_dir: outsideDir,
  }, 201)
  expect(outsideChannel.effective_work_dir).toBe(outsideDir)

  // Create Bridge Bot that echoes process.cwd()
  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', admin.token, {
    mode: 'bridge', username: 'folderbot', display_name: 'Folder Bot', driver_hint: 'custom',
  }, 201)
  const script = join(h.dataDir, 'cwd-echo.mjs')
  writeFileSync(script, `
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
console.log(JSON.stringify({ type: 'text', delta: 'CWD=' + process.cwd() }))
console.log(JSON.stringify({ type: 'done' }))
`)

  const paths = pathsFor(join(h.dataDir, 'bridge.yaml'))
  saveConfig(paths.config, {
    server: h.wsUrl,
    allowed_roots: [join(h.dataDir, 'repos')],
    agents: [{
      name: 'folderbot',
      token: bot.bot_token!,
      driver: 'custom',
      cwd: repoRoot,
      permission_mode: 'default',
      allowed_users: ['*'],
      env: {},
      command: process.execPath,
      args: [script],
    }],
  })
  const daemon = startDaemon(paths)
  cleanup(daemon.stop)
  await vi.waitFor(async () => {
    const bots = await h.api<{ user_id: string; online: boolean }[]>('GET', '/api/bots', admin.token)
    expect(bots.find(b => b.user_id === bot.user_id)?.online).toBe(true)
  })

  // Mention bot in #frontend -> executes in repoRoot/apps/web!
  await h.api<Message>('POST', `/api/channels/${webChannel.id}/messages`, admin.token, { content: '@folderbot pwd' }, 201)
  await vi.waitFor(async () => {
    const { messages } = await h.api<{ messages: Message[] }>('GET', `/api/channels/${webChannel.id}/messages`, admin.token)
    expect(messages[0]).toMatchObject({ status: 'done', content: 'CWD=' + realpathSync(webDir) })
  })

  // Mention bot in #outside -> rejected by Bridge allowed_roots guard!
  await h.api<Message>('POST', `/api/channels/${outsideChannel.id}/messages`, admin.token, { content: '@folderbot pwd' }, 201)
  await vi.waitFor(async () => {
    const { messages } = await h.api<{ messages: Message[] }>('GET', `/api/channels/${outsideChannel.id}/messages`, admin.token)
    expect(messages[0]).toMatchObject({ status: 'error', error_message: expect.stringContaining('allowed_roots') })
  })

  // Deleting workspace removes its channels
  await h.api('DELETE', `/api/workspaces/${projectWs.id}`, admin.token)
  const remaining = await h.api<Channel[]>('GET', '/api/channels', admin.token)
  expect(remaining.some(c => c.workspace_id === projectWs.id)).toBe(false)
})
