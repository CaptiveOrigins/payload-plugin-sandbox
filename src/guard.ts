import type { Payload } from 'payload'

import type { SeedOptions } from './types.js'

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedRefused'
  }
}

/** The plugin collection holding the one document that says "this database is for testing". */
export const markerSlug = (options: SeedOptions) => options.slugs?.marker ?? 'seed-marker'

type DbLike = { url?: string; connection?: { name?: string; host?: string }; poolOptions?: { connectionString?: string } }

/** The database name the adapter uses (MongoDB/Postgres URL path, or the adapter's own name). */
export function databaseName(payload: Payload): string | null {
  const db = payload.db as unknown as DbLike
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
 * Where the database lives: the host part of the connection string, lowercased, hosts sorted
 * (`cluster0.abcde.mongodb.net`, or `a:27017,b:27017`). Credentials are never part of it.
 * Null when it can't be read.
 */
export function databaseHost(payload: Payload): string | null {
  const db = payload.db as unknown as DbLike
  const url = db.url ?? db.poolOptions?.connectionString
  const fromUrl = url ? /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(url)?.[1] : undefined
  const raw = fromUrl ?? db.connection?.host
  if (!raw) return null
  return raw.toLowerCase().split(',').map((h) => h.trim()).filter(Boolean).sort().join(',') || null
}

/**
 * The first two checks, which need no database read: `allow()` says so, and the database
 * name is readable and doesn't look like production (unless listed in `allowDatabases`).
 */
export function assertConfigAllowed(payload: Payload, options: SeedOptions): void {
  if (!options.allow?.()) throw new SeedRefused('Seeding is not allowed in this environment (allow() is missing or false).')
  const name = databaseName(payload)
  if (!name) throw new SeedRefused('Refusing to seed: the database name can’t be read, so it can’t be checked.')
  if (/prod/i.test(name) && !(options.allowDatabases ?? []).includes(name)) throw new SeedRefused(`Refusing to write seed data to database “${name}”: it looks like production.`)
}

/**
 * Throws unless seeding may run here. Three independent checks, each failing closed:
 * 1. `allow()` returns true;
 * 2. the database name is readable and doesn't look like production;
 * 3. the database carries a test-database marker written for this database name on this host
 *    (`markTestDatabase`), so a copy restored elsewhere doesn't count.
 * Then, when the site gives `assertQuiet`, outgoing effects must be off.
 */
export async function assertAllowed(payload: Payload, options: SeedOptions): Promise<void> {
  assertConfigAllowed(payload, options)
  const name = databaseName(payload)!
  const host = databaseHost(payload)
  if (!host) throw new SeedRefused('Refusing to seed: the database host can’t be read, so the test-database marker can’t be checked.')
  let markers: { database?: string; host?: string }[]
  try {
    markers = (await payload.find({ collection: markerSlug(options) as never, limit: 10, depth: 0, overrideAccess: true, pagination: false })).docs as unknown as { database?: string; host?: string }[]
  } catch {
    throw new SeedRefused('Refusing to seed: the test-database marker can’t be read.')
  }
  if (!markers.length) throw new SeedRefused(`Refusing to seed: database “${name}” hasn’t been marked as a test database. A person marks it once with markTestDatabase().`)
  if (!markers.some((m) => m.database === name && m.host === host))
    throw new SeedRefused(`Refusing to seed: the test-database marker was written for another database or host, not “${name}” on this host. A restored copy has to be marked again.`)
  if (options.assertQuiet) {
    try {
      await options.assertQuiet()
    } catch (e) {
      throw new SeedRefused(`Refusing to seed: outgoing effects aren’t off here (${(e as Error).message ?? String(e)}).`)
    }
  }
}

export async function isAllowed(payload: Payload, options: SeedOptions): Promise<boolean> {
  try {
    await assertAllowed(payload, options)
    return true
  } catch {
    return false
  }
}

/**
 * Marks this database as a test database: the third check. Meant to be run once by a person,
 * who types the database name to confirm (`confirm`). Refuses where the first two checks fail,
 * so production can't be marked. Records the database name and host it was written for.
 */
export async function markTestDatabase(payload: Payload, options: SeedOptions, { confirm, by }: { confirm: string; by?: string }): Promise<{ database: string; host: string; created: boolean }> {
  assertConfigAllowed(payload, options)
  const database = databaseName(payload)!
  const host = databaseHost(payload)
  if (!host) throw new SeedRefused('Refusing to mark: the database host can’t be read.')
  if (confirm !== database) throw new SeedRefused(`Refusing to mark: type the database name exactly (“${database}”) to confirm.`)
  const slug = markerSlug(options) as never
  const existing = (await payload.find({ collection: slug, where: { and: [{ database: { equals: database } }, { host: { equals: host } }] } as never, limit: 1, depth: 0, overrideAccess: true })).docs
  if (existing.length) return { database, host, created: false }
  await payload.create({ collection: slug, data: { database, host, markedAt: new Date().toISOString(), markedBy: (by ?? '').slice(0, 120) } as never, overrideAccess: true })
  return { database, host, created: true }
}
