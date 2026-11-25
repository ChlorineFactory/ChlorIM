import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { BotWriteResponse, BridgeDevice, BridgeFsList, Channel, Message, MessagePage, Workspace } from '@chiorim/shared'
import { pathsFor, saveConfig } from '../packages/bridge/src/config.js'
import { startDaemon } from '../packages/bridge/src/daemon.js'
import { cleanup, harness } from './support.js'

const driverScript = `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).once('line', (line) => {
  const req = JSON.parse(line);
  console.log(JSON.stringify({ type: 'text', delta: 'OK:' + process.cwd() + ':' + req.prompt }));
  console.log(JSON.stringify({ type: 'done', external_session_id: 'remote-sess' }));
});
`

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('Timed out waiting for condition')
}

test('browses remote Bridge device folders inside allowed_roots and queues/drains tasks across device offline/online', async () => {
  const h = await harness()
  const owner = await h.person('remote_owner')

  const root = mkdtempSync(join(tmpdir(), 'chiorim-remote-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))
  const projectsRoot = join(root, 'Projects')
  const appDir = join(projectsRoot, 'DemoApp')
  const webDir = join(appDir, 'web')
  const outsideDir = join(root, 'SecretOutside')
  mkdirSync(webDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  const script = join(root, 'driver.cjs')
  writeFileSync(script, driverScript)
  chmodSync(script, 0o755)

  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'devbox', display_name: 'DevBox Agent', driver_hint: 'custom',
  }, 201)

  const bridgeDir = join(root, 'bridge')
  const paths = pathsFor(join(bridgeDir, 'bridge.yaml'))
  saveConfig(paths.config, {
    server: h.wsUrl,
    allowed_roots: [projectsRoot],
    agents: [{
      name: 'devbox',
      token: bot.bot_token!,
      driver: 'custom',
      cwd: projectsRoot,
      permission_mode: 'default',
      allowed_users: ['*'],
      command: process.execPath,
      args: [script],
      env: {},
    }],
  })

  // 1. Connect device and verify /api/bridges + remote folder browser RPC
  let daemon = startDaemon(paths)
  cleanup(() => daemon.stop())

  const devices = await waitFor(async () => {
    const list = await h.api<BridgeDevice[]>('GET', '/api/bridges', owner.token)
    return list.find(d => d.bot_id === bot.user_id && d.online) ? list : undefined
  })
  const dev = devices.find(d => d.bot_id === bot.user_id)!
  expect(dev.online).toBe(true)
  expect(dev.hostname).toBeTruthy()
  expect(dev.allowed_roots).toContain(realpathSync(projectsRoot))

  // List top-level roots
  const topFs = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs`, owner.token)
  expect(topFs.path).toBe('')
  expect(topFs.entries).toEqual([expect.objectContaining({ name: 'Projects', path: realpathSync(projectsRoot), kind: 'dir' })])

  // Drill into Projects -> DemoApp -> web
  const projectsFs = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(realpathSync(projectsRoot))}`, owner.token)
  expect(projectsFs.entries.map(e => e.name)).toEqual(['DemoApp'])
  const appFs = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(realpathSync(appDir))}`, owner.token)
  expect(appFs.entries.map(e => e.name)).toEqual(['web'])
  expect(appFs.parent).toBe(realpathSync(projectsRoot))

  // Reject browsing outside allowed_roots
  await h.api('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(realpathSync(outsideDir))}`, owner.token, undefined, 400)

  // 2. Bind folder group to this device and create subfolder channel
  const folder = await h.api<Workspace>('POST', '/api/workspaces', owner.token, {
    name: 'DemoApp',
    work_dir: realpathSync(appDir),
    host_bot_id: bot.user_id,
    create_default_channel: false,
  }, 201)
  expect(folder.host_bot_id).toBe(bot.user_id)
  expect(folder.host_name).toBe(dev.hostname)

  const webChannel = await h.api<Channel>('POST', '/api/channels', owner.token, {
    type: 'public',
    name: 'web',
    workspace_id: folder.id,
    work_dir: 'web',
  }, 201)
  expect(webChannel.effective_work_dir).toBe(`${realpathSync(appDir)}/web`)

  // 3. Take device offline: browsing returns 503, mentioning queues tasks
  await daemon.stop()
  await waitFor(async () => {
    const list = await h.api<BridgeDevice[]>('GET', '/api/bridges', owner.token)
    return list.find(d => d.bot_id === bot.user_id && !d.online) ? true : undefined
  })
  await h.api('GET', `/api/bridges/${bot.user_id}/fs`, owner.token, undefined, 503)

  // Queue two tasks while offline; cancel the second one
  await h.api<Message>('POST', `/api/channels/${webChannel.id}/messages`, owner.token, { content: '@devbox first task' }, 201)
  await h.api<Message>('POST', `/api/channels/${webChannel.id}/messages`, owner.token, { content: '@devbox cancel me' }, 201)

  const queuedPage = await h.api<MessagePage>('GET', `/api/channels/${webChannel.id}/messages`, owner.token)
  const botQueued = queuedPage.messages.filter(m => m.author_id === bot.user_id).reverse()
  expect(botQueued).toHaveLength(2)
  expect(botQueued[0].status).toBe('queued')
  expect(botQueued[1].status).toBe('queued')

  // Abort/cancel the second queued task
  await h.api('POST', `/api/messages/${botQueued[1].id}/abort`, owner.token)
  const afterAbort = await h.api<Message>('GET', `/api/messages/${botQueued[1].id}`, owner.token)
  expect(afterAbort.status).toBe('aborted')

  // 4. Bring device back online -> queued task auto-drains & completes in target subfolder!
  daemon = startDaemon(paths)
  const completed = await waitFor(async () => {
    const msg = await h.api<Message>('GET', `/api/messages/${botQueued[0].id}`, owner.token)
    return msg.status === 'done' ? msg : undefined
  })
  expect(completed.content).toBe(`OK:${realpathSync(webDir)}:@devbox first task`)

  // Cancelled task remains aborted
  const stillAborted = await h.api<Message>('GET', `/api/messages/${botQueued[1].id}`, owner.token)
  expect(stillAborted.status).toBe('aborted')
})
