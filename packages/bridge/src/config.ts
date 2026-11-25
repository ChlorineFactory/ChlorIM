import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { driverSchema, httpUrlSchema, usernameSchema } from '@chiorim/shared'

export const defaultConfig = join(homedir(), '.chiorim', 'bridge.yaml')
export const permissionMode = z.enum(['readonly', 'default', 'auto'])
export const serverUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value)
    return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, 'Expected a ws:// or wss:// URL without credentials, query, or fragment')
export const tokenSchema = z.string().regex(/^chior_bot_[a-f0-9]{64}$/)
export const agentSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/), token: tokenSchema, driver: driverSchema,
  cwd: z.string().min(1).max(4096).optional(),
  allowed_roots: z.array(z.string().min(1).max(4096)).optional(),
  permission_mode: permissionMode.default('default'),
  allowed_users: z.array(z.union([z.literal('*'), usernameSchema])).default(['*']),
  env: z.record(z.string()).default({}),
  server: serverUrl.optional(),
  endpoint: httpUrlSchema.optional(),
  api_key: z.string().optional(),
  model: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
})
const configSchema = z.object({
  server: serverUrl,
  allowed_roots: z.array(z.string().min(1).max(4096)).optional(),
  agents: z.array(agentSchema).default([]),
}).superRefine((value, ctx) => {
  const names = new Set<string>()
  const tokens = new Set<string>()
  for (const agent of value.agents) {
    if (names.has(agent.name) || tokens.has(agent.token)) {
      ctx.addIssue({ code: 'custom', message: 'Agent names and tokens must be unique' })
    }
    names.add(agent.name)
    tokens.add(agent.token)
  }
})
export type AgentConfig = z.infer<typeof agentSchema>
export type BridgeConfig = z.infer<typeof configSchema>

export function pathsFor(configPath: string) {
  const config = resolve(configPath)
  const directory = dirname(config)
  return { config, directory, pid: join(directory, 'bridge.pid'), status: join(directory, 'status.json'),
    logs: join(directory, 'logs'), log: join(directory, 'logs', 'bridge.log') }
}
export type BridgePaths = ReturnType<typeof pathsFor>

export function readConfig(path: string, allowMissing = false): BridgeConfig {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { server: 'ws://127.0.0.1:3000', allowed_roots: [], agents: [] }
    throw error
  }
  try { return configSchema.parse(parse(raw)) }
  catch { throw new Error('Invalid bridge.yaml. Check the server URL, agent names, tokens, and driver settings.') }
}

export function writePrivate(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}

export function saveConfig(path: string, config: BridgeConfig) {
  writePrivate(path, stringify(configSchema.parse(config)))
}

export function expandHome(value: string, baseDir?: string) {
  const expanded = value.replace(/^~(?=\/|$)/, () => homedir())
  return baseDir ? resolve(baseDir, expanded) : resolve(expanded)
}

export function resolvedAgent(agent: AgentConfig, config: BridgeConfig, directory: string) {
  const cwd = agent.cwd ? expandHome(agent.cwd, directory) : homedir()
  const rawRoots = agent.allowed_roots?.length ? agent.allowed_roots : (config.allowed_roots ?? [])
  const roots = rawRoots.map(root => expandHome(root, directory))
  return {
    ...agent,
    cwd,
    allowed_roots: roots,
    server: agent.server ?? config.server,
    env: agent.driver === 'antigravity' ? { ...agent.env, CHIOR_BRIDGE_AGENT_STATE: join(directory, 'antigravity', agent.name) } : agent.env,
  }
}
