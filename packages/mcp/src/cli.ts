#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder'
import { createTools, tools } from './tools.js'

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const call = createTools(process.env)
const maxLine = 1024 * 1024
type Id = string | number | null
let initialized = false

function json(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n')
}
const success = (id: Id, result: unknown) => json({ jsonrpc: '2.0', id, result })
const failure = (id: Id, code: number, message: string) => json({ jsonrpc: '2.0', id, error: { code, message } })
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

async function receive(line: string) {
  let value: unknown
  try { value = JSON.parse(line) } catch { failure(null, -32700, 'Parse error'); return }
  if (!record(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    failure(null, -32600, 'Invalid request')
    return
  }
  // JSON-RPC notifications have no response. Clients may send initialized after negotiation.
  if (!Object.hasOwn(value, 'id')) return
  const id = value.id
  if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) {
    failure(null, -32600, 'Invalid request id')
    return
  }
  const params = value.params
  if (params !== undefined && !record(params)) { failure(id, -32602, 'Invalid params'); return }
  if (value.method === 'initialize') {
    const version = params?.protocolVersion
    if (typeof version !== 'string') { failure(id, -32602, 'protocolVersion is required'); return }
    initialized = true
    success(id, { protocolVersion: versions.includes(version) ? version : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'chiorim', version: '0.2.0' } })
    return
  }
  if (value.method === 'ping') { success(id, {}); return }
  if (!initialized) { failure(id, -32002, 'Initialize the server first'); return }
  if (value.method === 'tools/list') { success(id, { tools }); return }
  if (value.method !== 'tools/call') { failure(id, -32601, 'Method not found'); return }
  const tool = tools.find(tool => tool.name === params?.name)
  const args = params?.arguments ?? {}
  if (!tool || !record(args)) { failure(id, -32602, 'Unknown tool or invalid arguments'); return }
  try {
    const result = await call(tool.name, args)
    success(id, { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] })
  } catch (error) {
    success(id, { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed' }] })
  }
}

const decoder = new StringDecoder('utf8')
let buffer = ''
let discard = false
for await (const chunk of process.stdin) {
  const lines = decoder.write(chunk as Buffer).split('\n')
  for (const [index, fragment] of lines.entries()) {
    if (!discard && buffer.length + fragment.length <= maxLine) buffer += fragment
    else if (!discard) {
      failure(null, -32600, 'Request line is too large')
      buffer = ''
      discard = true
    }
    if (index === lines.length - 1) continue
    if (!discard && buffer.trim()) await receive(buffer)
    buffer = ''
    discard = false
  }
}
buffer += decoder.end()
if (!discard && buffer.trim()) await receive(buffer)
