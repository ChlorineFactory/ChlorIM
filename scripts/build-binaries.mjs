#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const target = process.argv.find(arg => arg.startsWith('--target='))?.slice('--target='.length)
const label = target ?? `${process.platform}-${process.arch}`
const outDir = join(root, 'release', label)
const bunBin = process.env.BUN_BIN ?? (existsSync(`${process.env.HOME}/.bun/bin/bun`) ? `${process.env.HOME}/.bun/bin/bun` : 'bun')
const ext = label.includes('windows') ? '.exe' : ''

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

function compile(entry, outfile, extraArgs = []) {
  const args = ['build', entry, '--compile', '--minify', ...extraArgs, '--outfile', outfile]
  if (target) args.push('--target', target)
  console.log(`Building ${outfile}...`)
  execFileSync(bunBin, args, { cwd: root, stdio: 'inherit' })
  if (process.platform === 'darwin' && (!target || target.includes('darwin'))) {
    execFileSync('codesign', ['--force', '--sign', '-', outfile], { stdio: 'inherit' })
  }
}

// 1. Standalone CLI binaries (zero external dependencies)
compile('packages/bridge/src/cli.ts', join(outDir, `chior-bridge${ext}`))
compile('packages/mcp/src/cli.ts', join(outDir, `chior-mcp${ext}`))

// 2. Server binary (uses built-in bun:sqlite, zero external native addons) + pre-compressed web assets
compile('apps/server/bun-entry.ts', join(outDir, `chiorim-server${ext}`), ['--external', 'better-sqlite3', '--external', 'drizzle-orm/better-sqlite3'])

const webDist = join(root, 'apps', 'web', 'dist')
if (existsSync(join(webDist, 'index.html'))) {
  cpSync(webDist, join(outDir, 'web'), { recursive: true })
}

// 3. Emit SHA-256 checksums for release binaries
const bins = [`chiorim-server${ext}`, `chior-bridge${ext}`, `chior-mcp${ext}`]
const lines = bins.map(name => {
  const file = join(outDir, name)
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const mb = (statSync(file).size / (1024 * 1024)).toFixed(1)
  console.log(`  ${name.padEnd(20)} ${mb.padStart(6)} MiB  sha256:${hash.slice(0, 12)}`)
  return `${hash}  ${name}`
})
writeFileSync(join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
console.log(`\nRelease bundle ready in ${outDir}`)
