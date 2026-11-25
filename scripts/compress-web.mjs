#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const targetDir = resolve(process.argv[2] ?? 'apps/web/dist')
const compressible = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg'])
const minBytes = 1024

let files = 0
let rawTotal = 0
let brTotal = 0
let gzTotal = 0

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (!compressible.has(ext)) continue
    const size = statSync(full).size
    if (size < minBytes) continue
    const raw = readFileSync(full)
    const br = brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    })
    const gz = gzipSync(raw, { level: 9 })
    if (br.length < raw.length) writeFileSync(full + '.br', br)
    if (gz.length < raw.length) writeFileSync(full + '.gz', gz)
    files++
    rawTotal += raw.length
    brTotal += Math.min(br.length, raw.length)
    gzTotal += Math.min(gz.length, raw.length)
  }
}

walk(targetDir)
const kb = bytes => `${(bytes / 1024).toFixed(1)} KiB`
console.log(`Pre-compressed ${files} assets in ${targetDir}: raw ${kb(rawTotal)} -> gzip ${kb(gzTotal)} / br ${kb(brTotal)}`)
