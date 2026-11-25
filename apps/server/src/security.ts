import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
export const randomHex = (bytes = 32) => randomBytes(bytes).toString('hex')
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function hashPassword(password: string) {
  const salt = randomHex(16)
  return `${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`
}

export async function checkPassword(password: string, hash?: string | null) {
  const [salt, expected] = (hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':')
  const actual = await derive(password, salt, 64) as Buffer
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && Boolean(hash)
}

export function loadSecret(dataDir: string, secret?: string) {
  if (secret) return secret
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, '.secret')
  let value: string
  try { value = readFileSync(path, 'utf8').trim() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temporary = path + '.' + randomHex(12)
    try {
      writeFileSync(temporary, randomHex(), { flag: 'wx', mode: 0o600 })
      try { linkSync(temporary, path) } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError
      }
      value = readFileSync(path, 'utf8').trim()
    } finally { rmSync(temporary, { force: true }) }
  }
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid generated APP_SECRET file')
  return value
}

export function createSecretBox(secret: string) {
  const key = createHash('sha256').update(secret).digest()
  return {
    encrypt(value: string) {
      if (!value) return ''
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
    },
    decrypt(value: string) {
      if (!value) return ''
      const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64url'))
      const cipher = createDecipheriv('aes-256-gcm', key, iv)
      cipher.setAuthTag(tag)
      return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8')
    },
  }
}
