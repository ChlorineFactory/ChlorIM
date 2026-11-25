import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePrivate } from './config.js'
import type { BridgePaths } from './config.js'

const label = 'dev.chiorim.bridge'
const unit = 'chior-bridge.service'
type ServiceTemplateOptions = { node: string; cli?: string; config: string; path: string; logs: string }
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!)
const unitQuote = (value: string) => '"' + value.replace(/[%\\"\r\n\t]/g, char => ({ '%': '%%', '\\': '\\\\', '"': '\\"', '\r': '\\r', '\n': '\\n', '\t': '\\t' })[char]!) + '"'
const execQuote = (value: string) => unitQuote(value.replaceAll('$', () => '$$'))
const serviceArgs = (options: ServiceTemplateOptions) => [
  options.node,
  ...(options.cli && options.cli !== options.node ? [options.cli] : []),
  '--config', options.config, 'run',
]

export function launchdPlist(options: ServiceTemplateOptions) {
  const args = serviceArgs(options)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(options.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(options.logs, 'service.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.logs, 'service.err.log'))}</string>
</dict>
</plist>
`
}

export function systemdUnit(options: ServiceTemplateOptions) {
  const args = serviceArgs(options)
  return `[Unit]
Description=ChiorIM Bridge Daemon
After=network-online.target

[Service]
Type=simple
Environment=${unitQuote(`PATH=${options.path}`)}
ExecStart=${args.map(execQuote).join(' ')}
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`
}

const command = (name: string, args: string[]) => execFileSync(name, args, { stdio: 'pipe' })
const launchDomain = () => `gui/${process.getuid?.()}`
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', label + '.plist')
const systemdPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', unit)
function checkPlatform() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Service management is supported on macOS and Linux')
}

export function installService(paths: BridgePaths) {
  checkPlatform()
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  const execPath = realpathSync(process.execPath)
  const isStandalone = import.meta.url.includes('/$bunfs/') || !existsSync(resolve(fileURLToPath(import.meta.url), '../cli.js'))
  const options: ServiceTemplateOptions = {
    node: execPath,
    cli: isStandalone ? undefined : resolve(fileURLToPath(import.meta.url), '../cli.js'),
    config: paths.config, path: process.env.PATH ?? '/usr/bin:/bin', logs: paths.logs,
  }
  if (process.platform === 'darwin') {
    const path = plistPath()
    writePrivate(path, launchdPlist(options))
    try { command('launchctl', ['bootout', `${launchDomain()}/${label}`]) } catch { /* No previously loaded job. */ }
    command('launchctl', ['bootstrap', launchDomain(), path])
  } else {
    const path = systemdPath()
    const existing = existsSync(path)
    writePrivate(path, systemdUnit(options))
    command('systemctl', ['--user', 'daemon-reload'])
    command('systemctl', ['--user', 'enable', '--now', unit])
    if (existing) command('systemctl', ['--user', 'restart', unit])
  }
}

export function uninstallService() {
  checkPlatform()
  if (process.platform === 'darwin') {
    try { command('launchctl', ['bootout', `${launchDomain()}/${label}`]) }
    catch (error) {
      if ((error as { status?: number }).status !== 3) throw error
    }
    rmSync(plistPath(), { force: true })
  } else {
    command('systemctl', ['--user', 'disable', '--now', unit])
    rmSync(systemdPath(), { force: true })
    command('systemctl', ['--user', 'daemon-reload'])
  }
}

export function restartService() {
  if (process.platform === 'darwin') {
    try { command('launchctl', ['print', `${launchDomain()}/${label}`]) } catch { return false }
    command('launchctl', ['kickstart', '-k', `${launchDomain()}/${label}`])
    return true
  }
  if (process.platform === 'linux') {
    try { command('systemctl', ['--user', 'is-enabled', unit]) } catch { return false }
    command('systemctl', ['--user', 'restart', unit])
    return true
  }
  return false
}
