import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Delta, RunStart } from '@chiorim/shared'
import { agentSchema } from '../packages/bridge/src/config.js'
import { drivers } from '../packages/bridge/src/drivers.js'

const request: RunStart = {
  type: 'run.start', run_id: 'run', message_id: 'message', channel_id: 'channel', scope_key: 'channel:channel',
  prompt: 'Summarize this note', channel_context: 'Use short bullet points', context: [],
  sender: { id: 'sender', username: 'fixture', display_name: 'Fixture' },
}

test('runs native agy in NDJSON mode, streams typed events and resumes with the conversation ID', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chiorim-agy-'))
  try {
    const fixture = join(cwd, 'agy.mjs')
    writeFileSync(join(cwd, 'agy'), '#!/bin/sh\nexec "$TEST_NODE" "$TEST_FIXTURE" "$@"\n', { mode: 0o700 })
    writeFileSync(fixture, `
import assert from 'node:assert/strict'
const args = process.argv.slice(2)
const resumed = args.includes('--conversation')
assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--mode', 'plan', '--input-format', 'stream-json', '--model', 'fixture-model',
  ...(resumed ? ['--conversation', 'agy-session'] : [])])
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const envelope = JSON.parse(Buffer.concat(chunks).toString())
assert.equal(envelope.event, 'user')
const prompt = JSON.parse(envelope.message.content)
assert.equal(prompt.channel_context, resumed ? undefined : 'Use short bullet points')
function event(event, fields) { console.log(JSON.stringify({ event, ...fields })) }
function step(step_update) { event('step_update', { step_update }) }
event('init', { conversation_id: 'agy-session' })
step({ step_type: 'thinking', text_delta: 'Reading' })
step({ step_type: 'tool', step_index: 4, state: 'RUNNING', tool_info: { name: 'list', parameters: { root: '.' } } })
step({ step_type: 'tool', step_index: 4, state: 'DONE', tool_info: { name: 'list', output: 'notes.md' } })
step({ step_type: 'agent_response', text_delta: 'One note' })
event('result', { result: { conversation_id: 'agy-session', status: 'SUCCESS', response: 'One note' } })
`)
    const config = agentSchema.parse({ name: 'test', token: 'chior_bot_' + '0'.repeat(64), cwd, driver: 'antigravity',
      model: 'fixture-model', permission_mode: 'readonly', env: { PATH: cwd, TEST_NODE: process.execPath, TEST_FIXTURE: fixture } })
    const deltas: Delta[] = []
    const id = await drivers.antigravity.run(request, config, new AbortController().signal, delta => deltas.push(delta))
    expect(id).toBe('agy-session')
    expect(deltas).toEqual([
      { part: 'thinking', delta: 'Reading' },
      { part: 'tool_start', tool: { id: '4', name: 'list', input: { root: '.' }, status: 'running', output: undefined } },
      { part: 'tool_end', tool: { id: '4', name: 'list', input: { root: '.' }, status: 'done', output: 'notes.md' } },
      { part: 'text', delta: 'One note' },
    ])
    expect(await drivers.antigravity.run({ ...request, external_session_id: id }, config, new AbortController().signal, () => {})).toBe(id)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test.each([false, true])('uses the Python backend when agy is missing or Python is selected explicitly (%s)', async force => {
  const cwd = mkdtempSync(join(tmpdir(), 'chiorim-agy-fallback-'))
  try {
    if (force) writeFileSync(join(cwd, 'agy'), '#!/bin/sh\nexit 37\n', { mode: 0o700 })
    writeFileSync(join(cwd, 'python3'), '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"text","delta":"Python"}\' \'{"type":"done","external_session_id":"python-session"}\'\n', { mode: 0o700 })
    const config = agentSchema.parse({ name: 'test', token: 'chior_bot_' + '0'.repeat(64), cwd, driver: 'antigravity',
      env: { PATH: cwd, ...(force ? { CHIOR_ANTIGRAVITY_BACKEND: 'python' } : {}) } })
    const deltas: Delta[] = []
    expect(await drivers.antigravity.run(request, config, new AbortController().signal, delta => deltas.push(delta))).toBe('python-session')
    expect(deltas).toEqual([{ part: 'text', delta: 'Python' }])
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
