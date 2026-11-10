import type { Payload } from 'payload'

import type { SeedOptions } from './types.js'

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedRefused'
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
export function assertAllowed(payload: Payload, options: SeedOptions): void {
  if (!options.allow?.()) throw new SeedRefused('Seeding is not allowed in this environment (allow() is missing or false).')
  const name = databaseName(payload)
  if (name && /prod/i.test(name) && !(options.allowDatabases ?? []).includes(name))
    throw new SeedRefused(`Refusing to write seed data to database “${name}”: it looks like production.`)
}

export const isAllowed = (payload: Payload, options: SeedOptions) => {
  try {
    assertAllowed(payload, options)
    return true
  } catch {
    return false
  }
}
