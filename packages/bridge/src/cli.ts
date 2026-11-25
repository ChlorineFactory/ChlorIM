#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { Command } from 'commander'
import { defaultConfig, pathsFor, readConfig, saveConfig, agentSchema } from './config.js'
import { daemonPid, reloadDaemon, startDaemon } from './daemon.js'
import { installService, restartService, uninstallService } from './service.js'

const program = new Command().name('chior-bridge').description('Run local Agent connections for ChiorIM')
  .version('0.1.0').option('--config <path>', 'Bridge configuration file', defaultConfig)
const paths = () => pathsFor(program.opts<{ config: string }>().config)

type AddOptions = {
  url: string; token: string; driver: string; name?: string; cwd?: string; allowedRoots?: string; allowedUsers?: string; endpoint?: string;
  apiKey?: string; permissionMode?: string; command?: string; arg?: string[]; model?: string
}
program.command('add')
  .requiredOption('--url <ws_url>').requiredOption('--token <token>').requiredOption('--driver <driver>')
  .option('--name <name>').option('--cwd <dir>').option('--allowed-roots <csv>').option('--allowed-users <csv>')
  .option('--endpoint <url>').option('--api-key <key>').option('--permission-mode <mode>')
  .option('--command <executable>').option('--arg <arg>', 'Argument for the custom command, repeatable', (arg, values: string[]) => [...values, arg], [])
  .option('--model <model>')
  .action((options: AddOptions) => {
    const { config: path, pid } = paths()
    const config = readConfig(path, true)
    const existing = config.agents.find(agent => options.name ? agent.name === options.name : agent.token === options.token)
    const name = options.name ?? existing?.name ?? `${options.driver}-${options.token.slice(-8)}`
    if (!config.agents.length) config.server = options.url
    const checked = agentSchema.safeParse({
      ...existing, name, token: options.token, driver: options.driver,
      server: options.url === config.server ? undefined : options.url,
      cwd: options.cwd ?? existing?.cwd,
      allowed_roots: options.allowedRoots?.split(',').map(value => value.trim()).filter(Boolean) ?? existing?.allowed_roots,
      permission_mode: options.permissionMode ?? existing?.permission_mode,
      allowed_users: options.allowedUsers?.split(',').map(value => value.trim()).filter(Boolean) ?? existing?.allowed_users,
      endpoint: options.endpoint ?? existing?.endpoint, api_key: options.apiKey ?? existing?.api_key,
      command: options.command ?? existing?.command, args: options.arg?.length ? options.arg : existing?.args,
      model: options.model ?? existing?.model,
    })
    if (!checked.success) throw new Error('Invalid agent flags. Check the URL, token, name, allowed users and driver settings.')
    if (config.agents.some(agent => agent !== existing && (agent.name === name || agent.token === options.token))) {
      throw new Error('Agent name or token is already configured')
    }
    config.agents = [...config.agents.filter(agent => agent !== existing), checked.data]
    saveConfig(path, config)
    reloadDaemon(pid)
    console.log(`Saved ${name}`)
  })

program.command('remove').argument('<name>').action((name: string) => {
  const { config: path, pid } = paths()
  const config = readConfig(path)
  const agents = config.agents.filter(agent => agent.name !== name)
  if (agents.length === config.agents.length) throw new Error('Agent not found')
  saveConfig(path, { ...config, agents })
  reloadDaemon(pid)
  console.log(`Removed ${name}`)
})
program.command('run').action(() => {
  const daemon = startDaemon(paths())
  const shutdown = () => { void daemon.stop().catch(error => { console.error(error.message); process.exitCode = 1 }) }
  process.on('SIGHUP', daemon.reload)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  // Keep an empty configuration alive so SIGHUP can add the first connection.
  const idle = setInterval(() => {}, 60_000)
  const clear = () => clearInterval(idle)
  process.once('SIGINT', clear)
  process.once('SIGTERM', clear)
})
program.command('status').action(() => {
  const { config, pid, status } = paths()
  const current = daemonPid(pid)
  const agents = readConfig(config, true).agents
  let running = { pid: 0, agents: [] as { name: string; connected: boolean; cwd: string; active_tasks: number }[] }
  if (current) {
    try { running = JSON.parse(readFileSync(status, 'utf8')) as typeof running } catch { /* The daemon is starting. */ }
  }
  console.log(current ? `Bridge running (PID ${current})` : 'Bridge stopped')
  for (const agent of agents) {
    const state = running.pid === current ? running.agents.find(item => item.name === agent.name) : undefined
    console.log(`${agent.name}\t${agent.driver}\t${state?.connected ? 'connected' : 'offline'}\t${state?.cwd ?? agent.cwd ?? '-'}\t${state?.active_tasks ?? 0} active`)
  }
})
program.command('logs').option('-f, --follow').action(async ({ follow }: { follow?: boolean }) => {
  const { log, logs } = paths()
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  appendFileSync(log, '', { mode: 0o600 })
  const child = spawn('tail', follow ? ['-n', '100', '-f', log] : ['-n', '100', log], { stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not read Bridge logs')))
  })
})
program.command('restart').action(() => {
  if (!restartService() && !reloadDaemon(paths().pid)) throw new Error('No installed service or running Bridge daemon')
  console.log('Bridge restart requested')
})
const service = program.command('service')
service.command('install').action(() => {
  const locations = paths()
  const config = readConfig(locations.config, true)
  saveConfig(locations.config, config)
  installService(locations)
  console.log('Bridge service installed')
})
service.command('uninstall').action(() => {
  uninstallService()
  console.log('Bridge service removed')
})

await program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : 'Bridge command failed')
  process.exitCode = 1
})
