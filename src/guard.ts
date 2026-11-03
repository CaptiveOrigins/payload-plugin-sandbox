import type { Payload } from 'payload'

import type { SandboxOptions } from './types.js'

export class SandboxRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxRefused'
  }
}

/** The database name the adapter uses (MongoDB/Postgres URL path, or the adapter's own name). */
export function databaseName(payload: Payload): string | null {
  const db = payload.db as unknown as { url?: string; connection?: { name?: string }; poolOptions?: { connectionString?: string } }
  if (db.connection?.name) return db.connection.name
  const url = db.url ?? db.poolOptions?.connectionString
  if (!url) return null
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null
  } catch {
    return null
  }
}

/**
 * Throws unless the sandbox may run here: `allow()` must say so, and the database
 * must not look like production (unless explicitly listed in `allowDatabases`).
 */
export function assertAllowed(payload: Payload, options: SandboxOptions): void {
  if (!options.allow?.()) throw new SandboxRefused('The sandbox is not allowed in this environment (allow() is missing or false).')
  const name = databaseName(payload)
  if (name && /prod/i.test(name) && !(options.allowDatabases ?? []).includes(name))
    throw new SandboxRefused(`Refusing to write sandbox data to database “${name}”: it looks like production.`)
}

export const isAllowed = (payload: Payload, options: SandboxOptions) => {
  try {
    assertAllowed(payload, options)
    return true
  } catch {
    return false
  }
}
