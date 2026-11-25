import type { ZodType, ZodTypeDef } from 'zod'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiFailure extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string, readonly details?: unknown) {
    super(message)
  }

  response() {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}

export function fail(status: ContentfulStatusCode, code: string, message: string, details?: unknown): never {
  throw new ApiFailure(status, code, message, details)
}

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown) {
  const result = schema.safeParse(value)
  if (!result.success) fail(400, 'INVALID_INPUT', 'Invalid input', result.error.issues)
  return result.data
}

export async function body<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>) {
  const raw = await c.req.text()
  const recheck = c.get('recheckAuth') as (() => void) | undefined
  recheck?.()
  if (!raw.trim()) return parse(schema, {})
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail(400, 'INVALID_JSON', 'Expected a JSON request body') }
  return parse(schema, value)
}
