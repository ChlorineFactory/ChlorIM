import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import type { BotWriteResponse, BridgeDevice, BridgeFsList, Channel, Message, MessagePage, Workspace } from '@chiorim/shared'
import { cleanup, harness } from './support.js'

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error('Timed out waiting for Hermes adapter test condition')
}

test('connects Hermes Gateway platform adapter plugin, browses folders, streams replies, and delivers proactive Cron messages', async () => {
  const h = await harness()
  const owner = await h.person('hermes_owner')

  const root = mkdtempSync(join(tmpdir(), 'chiorim-hermes-plugin-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))
  const projectsDir = join(root, 'HermesWork')
  const subDir = join(projectsDir, 'AlphaRepo')
  const outsideDir = join(root, 'Forbidden')
  mkdirSync(subDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'hermes_gw', display_name: 'Hermes Gateway', driver_hint: 'hermes',
  }, 201)

  const folder = await h.api<Workspace>('POST', '/api/workspaces', owner.token, {
    name: 'AlphaRepo', work_dir: realpathSync(subDir), create_default_channel: false,
  }, 201)
  const room = await h.api<Channel>('POST', '/api/channels', owner.token, {
    type: 'public', name: 'hermes-room', workspace_id: folder.id,
  }, 201)

  const runnerScript = join(root, 'run_adapter.py')
  writeFileSync(runnerScript, `
import asyncio, json, os, sys
sys.path.insert(0, ${JSON.stringify(resolve('packages/hermes-adapter'))})
import adapter as plugin

registered = {}
class DummyCtx:
    def register_platform(self, **kwargs):
        registered.update(kwargs)

plugin.register(DummyCtx())
assert registered["name"] == "chlorim"
assert registered["cron_deliver_env_var"] == "CHLORIM_HOME_CHANNEL"
assert registered["check_fn"]() is True

async def main():
    cfg = plugin.PlatformConfig(enabled=True)
    gw = registered["adapter_factory"](cfg)

    async def on_event(event):
        info = await gw.get_chat_info(event.source.chat_id)
        first = await gw.send(event.source.chat_id, f"Hermes[{info['name']}]: ", metadata={"thread_id": event.source.thread_id})
        assert first.success and first.message_id
        second = await gw.edit_message(
            event.source.chat_id,
            first.message_id,
            f"Hermes[{info['name']}]: got {event.text}",
            finalize=True,
        )
        assert second.success

    gw.set_message_handler(on_event)
    assert await gw.connect() is True
    print("READY", flush=True)

    # Wait for stdin command "PROACTIVE" -> send + edit a proactive Cron message
    line = await asyncio.to_thread(sys.stdin.readline)
    if line.strip() == "PROACTIVE":
        sent = await gw.send(${JSON.stringify(room.id)}, "Cron draft")
        assert sent.success and sent.message_id, sent
        edited = await gw.edit_message(${JSON.stringify(room.id)}, sent.message_id, "Cron final report")
        assert edited.success, edited
        print(json.dumps({"proactive_id": sent.message_id}), flush=True)

    await asyncio.to_thread(sys.stdin.readline)
    await gw.disconnect()

asyncio.run(main())
`)

  const child = spawn('python3', [runnerScript], {
    env: {
      ...process.env,
      CHLORIM_URL: h.url,
      CHLORIM_BOT_TOKEN: bot.bot_token!,
      CHLORIM_CWD: projectsDir,
      CHLORIM_ALLOWED_ROOTS: projectsDir,
      CHLORIM_HOME_CHANNEL: room.id,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = once(child, 'exit')
  cleanup(async () => {
    if (child.exitCode === null) {
      child.stdin.end()
      await Promise.race([exited, new Promise(r => setTimeout(() => { child.kill('SIGKILL'); r(null) }, 2000))])
    }
  })

  await waitFor(async () => stdout.includes('READY') ? true : (child.exitCode !== null ? Promise.reject(new Error(`Python exited early: ${stderr}`)) : undefined))

  // 1. Verify Hermes adapter appears online in /api/bridges and exposes allowed_roots
  const devices = await h.api<BridgeDevice[]>('GET', '/api/bridges', owner.token)
  const dev = devices.find(d => d.bot_id === bot.user_id)
  expect(dev).toMatchObject({ online: true, driver: 'hermes' })
  expect(dev?.allowed_roots).toContain(realpathSync(projectsDir))

  // 2. Verify remote folder browsing RPC + outside-root rejection
  const fsRes = await h.api<BridgeFsList>('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(realpathSync(projectsDir))}`, owner.token)
  expect(fsRes.entries.map(e => e.name)).toEqual(['AlphaRepo'])
  await h.api('GET', `/api/bridges/${bot.user_id}/fs?path=${encodeURIComponent(realpathSync(outsideDir))}`, owner.token, undefined, 400)

  // 3. Mention @hermes_gw in folder channel -> verify streamed reply with injected work_dir
  await h.api<Message>('POST', `/api/channels/${room.id}/messages`, owner.token, { content: '@hermes_gw hello' }, 201)
  const reply = await waitFor(async () => {
    const page = await h.api<MessagePage>('GET', `/api/channels/${room.id}/messages`, owner.token)
    return page.messages.find(m => m.author_id === bot.user_id && m.status === 'done')
  })
  expect(reply.content).toBe(`Hermes[hermes-room]: got [ChlorIM Workspace Directory: ${realpathSync(subDir)}]\n@hermes_gw hello`)

  // 4. Trigger proactive Cron send + edit via Bot REST API
  child.stdin.write('PROACTIVE\n')
  const proactiveLine = await waitFor(async () => {
    const line = stdout.split('\n').find(item => item.includes('proactive_id'))
    return line ? JSON.parse(line) as { proactive_id: string } : undefined
  })
  const proactiveMsg = await h.api<Message>('GET', `/api/messages/${proactiveLine.proactive_id}`, owner.token)
  expect(proactiveMsg.content).toBe('Cron final report')
  expect(proactiveMsg.author_id).toBe(bot.user_id)

  // 5. Clean shutdown
  child.stdin.write('QUIT\n')
  child.stdin.end()
  const [code] = await exited
  expect(code, stderr).toBe(0)
})

test('waits for background Hermes BasePlatformAdapter.handle_message tasks and surfaces empty drops as errors', async () => {
  const h = await harness()
  const owner = await h.person('hermes_bg_owner')
  const general = await h.general(owner.token)
  const root = mkdtempSync(join(tmpdir(), 'chiorim-hermes-bg-'))
  cleanup(() => rmSync(root, { recursive: true, force: true }))

  const bot = await h.api<BotWriteResponse>('POST', '/api/bots', owner.token, {
    mode: 'bridge', username: 'hermes_bg', display_name: 'Hermes BG', driver_hint: 'hermes',
  }, 201)

  const runnerScript = join(root, 'run_bg_adapter.py')
  writeFileSync(runnerScript, `
import asyncio, sys
sys.path.insert(0, ${JSON.stringify(resolve('packages/hermes-adapter'))})
import adapter as plugin

class AsyncBackgroundChlorIMAdapter(plugin.ChlorIMAdapter):
    # Simulates real Hermes BasePlatformAdapter.handle_message() which spawns a background task and returns None immediately.
    async def handle_message(self, event):
        async def _bg():
            await asyncio.sleep(0.15)
            response = await self._message_handler(event)
            if isinstance(response, str) and response:
                await self.send(event.source.chat_id, response)
        asyncio.create_task(_bg())
        return None

async def main():
    gw = AsyncBackgroundChlorIMAdapter(plugin.PlatformConfig(enabled=True))
    async def on_event(event):
        if "SILENT_DROP" in event.text:
            return None
        assert event.source.user_id == "hermes_bg_owner"
        return f"Async reply to {event.source.user_id}: {event.text}"
    gw.set_message_handler(on_event)
    assert await gw.connect() is True
    print("READY", flush=True)
    await asyncio.to_thread(sys.stdin.readline)
    await gw.disconnect()

asyncio.run(main())
`)

  const child = spawn('python3', [runnerScript], {
    env: { ...process.env, CHLORIM_URL: h.url, CHLORIM_BOT_TOKEN: bot.bot_token! },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = once(child, 'exit')
  cleanup(async () => {
    if (child.exitCode === null) {
      child.stdin.end()
      await Promise.race([exited, new Promise(r => setTimeout(() => { child.kill('SIGKILL'); r(null) }, 2000))])
    }
  })

  await waitFor(async () => stdout.includes('READY') ? true : (child.exitCode !== null ? Promise.reject(new Error(`Python exited early: ${stderr}`)) : undefined))

  // 1. Background handler returns text 150ms AFTER handle_message() returns None -> must NOT finish empty or double-post!
  await h.api<Message>('POST', `/api/channels/${general.id}/messages`, owner.token, { content: '@hermes_bg 你好' }, 201)
  const reply = await waitFor(async () => {
    const page = await h.api<MessagePage>('GET', `/api/channels/${general.id}/messages`, owner.token)
    return page.messages.find(m => m.author_id === bot.user_id && m.status === 'done')
  })
  expect(reply.content).toBe('Async reply to hermes_bg_owner: @hermes_bg 你好')
  const afterFirst = await h.api<MessagePage>('GET', `/api/channels/${general.id}/messages`, owner.token)
  expect(afterFirst.messages.filter(m => m.author_id === bot.user_id)).toHaveLength(1)

  // 2. Silent drop (e.g. Hermes ALLOWED_USERS rejection) must surface as status: 'error' with actionable hint, NOT blank done!
  await h.api<Message>('POST', `/api/channels/${general.id}/messages`, owner.token, { content: '@hermes_bg SILENT_DROP' }, 201)
  const errMsg = await waitFor(async () => {
    const page = await h.api<MessagePage>('GET', `/api/channels/${general.id}/messages`, owner.token)
    return page.messages.find(m => m.author_id === bot.user_id && m.status === 'error')
  })
  expect(errMsg.error_message).toContain('CHLORIM_ALLOW_ALL_USERS')

  child.stdin.write('QUIT\n')
  child.stdin.end()
  const [code] = await exited
  expect(code, stderr).toBe(0)
})
