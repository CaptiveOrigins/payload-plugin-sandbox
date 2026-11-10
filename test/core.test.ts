import type { CollectionConfig, Config, Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { assertAllowed, assertConfigAllowed, buildDoc, databaseHost, creationOrder, databaseName, dimensionsFor, pairCoverage, pairwise, random, readCollection, seedPlugin, withDependencies } from '../src/index.js'

const animals: CollectionConfig = {
  slug: 'animals',
  versions: { drafts: true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { type: 'row', fields: [{ name: 'sex', type: 'select', options: ['female', 'male', 'unknown'] }, { name: 'status', type: 'select', required: true, options: ['alive', 'deceased'] }] },
    { name: 'group', type: 'relationship', relationTo: 'groups', required: true },
    { name: 'mother', type: 'relationship', relationTo: 'animals' },
    { type: 'tabs', tabs: [{ label: 'More', fields: [{ name: 'notes', type: 'textarea' }] }, { name: 'meta', fields: [{ name: 'weight', type: 'number', min: 1, max: 50 }] }] },
    { name: 'identifiers', type: 'array', fields: [{ name: 'value', type: 'text', required: true }] },
    { name: 'computed', type: 'text', virtual: true },
    { name: 'locked', type: 'text', admin: { readOnly: true } },
  ],
}
const groups: CollectionConfig = { slug: 'groups', fields: [{ name: 'title', type: 'text', required: true }, { name: 'owner', type: 'relationship', relationTo: 'users', required: true }] }
const users: CollectionConfig = { slug: 'users', auth: true, fields: [{ name: 'roles', type: 'select', hasMany: true, options: ['admin', 'member'] }] }

describe('schema', () => {
  it('reads data fields through rows and tabs, keeps groups and arrays, skips virtual and read-only', () => {
    const m = readCollection(animals)
    expect(m.fields.map((f) => f.path)).toEqual(['name', 'sex', 'status', 'group', 'mother', 'notes', 'meta', 'identifiers'])
    expect(m.fields.find((f) => f.path === 'meta')!.fields!.map((f) => f.path)).toEqual(['meta.weight'])
    expect(m.fields.find((f) => f.path === 'identifiers')!.fields!.map((f) => f.path)).toEqual(['identifiers[].value'])
    expect(m.drafts).toBe(true)
  })

  it('orders collections by dependency; self-references are a second pass', () => {
    const models = [animals, groups, users].map(readCollection)
    const { order, deferred } = creationOrder(models)
    expect(order).toEqual(['users', 'groups', 'animals'])
    expect(deferred).toEqual([{ from: 'animals', to: 'animals', path: 'mother' }])
    expect(withDependencies(models, ['animals']).sort()).toEqual(['animals', 'groups', 'users'])
  })
})

describe('coverage', () => {
  it('covers every pair of values with few cases, deterministically', () => {
    const dims = [
      { key: 'a', values: ['1', '2', '3'] },
      { key: 'b', values: ['x', 'y', 'z'] },
      { key: 'c', values: ['p', 'q'] },
      { key: 'd', values: ['t', 'f'] },
      { key: 'e', values: ['m', 'n', 'o'] },
    ]
    const cases = pairwise(dims, random(1))
    expect(pairCoverage(dims, cases)).toEqual({ covered: 67, total: 67 })
    expect(cases.length).toBeLessThan(20) // vs 108 for every combination
    expect(pairwise(dims, random(1))).toEqual(cases)
  })

  it('derives dimensions from fields: options, empty vs filled, drafts', () => {
    const dims = Object.fromEntries(dimensionsFor(readCollection(animals)).map((d) => [d.key, d.values]))
    expect(dims.sex).toEqual(['female', 'male', 'unknown', 'empty'])
    expect(dims.status).toEqual(['alive', 'deceased'])
    expect(dims.name).toEqual(['filled', 'edge'])
    expect(dims.mother).toEqual(['empty', 'filled'])
    expect(dims.identifiers).toEqual(['empty', 'one', 'many'])
    expect(dims['meta.weight']).toEqual(['empty', 'filled', 'edge'])
    expect(dims._status).toEqual(['draft', 'published'])
    expect(dims.group).toBeUndefined() // required single relationship: no choice
  })

  it('builds documents that follow the case', () => {
    const rnd = random('s')
    let n = 0
    const ctx = { rnd, serial: () => ++n, emailDomain: 'example.invalid', pick: () => 'g1', pickMany: () => ['g1'], defer: (p: string) => p === 'mother' }
    const doc = buildDoc(readCollection(animals), { sex: 'male', status: 'deceased', identifiers: 'many', 'meta.weight': 'edge', _status: 'draft' }, ctx)
    expect(doc).toMatchObject({ sex: 'male', status: 'deceased', group: 'g1', _status: 'draft' })
    expect((doc.identifiers as unknown[]).length).toBe(3)
    expect([1, 50]).toContain((doc.meta as { weight: number }).weight)
    expect(doc).not.toHaveProperty('mother')
    expect(typeof doc.name).toBe('string')
  })
})

describe('guard', () => {
  const payloadWith = (url: string) => ({ db: { url } }) as unknown as Payload
  it('refuses without allow(), on databases that look like production, and when the name can’t be read', () => {
    expect(() => assertConfigAllowed(payloadWith('mongodb://h/test'), {})).toThrow(/not allowed/)
    expect(() => assertConfigAllowed(payloadWith('mongodb://h/test'), { allow: () => true })).not.toThrow()
    expect(() => assertConfigAllowed(payloadWith('mongodb+srv://u:p@h/prod?x=1'), { allow: () => true })).toThrow(/production/)
    expect(() => assertConfigAllowed(payloadWith('mongodb+srv://u:p@h/myapp-production'), { allow: () => true, allowDatabases: ['myapp-production'] })).not.toThrow()
    expect(() => assertConfigAllowed(payloadWith('mongodb://h/'), { allow: () => true })).toThrow(/can’t be read/)
    expect(() => assertConfigAllowed({ db: {} } as unknown as Payload, { allow: () => true })).toThrow(/can’t be read/)
    expect(databaseName(payloadWith('postgres://u:p@h:5432/shop_prod'))).toBe('shop_prod')
  })

  it('reads the host without credentials, and the same for every host order', () => {
    expect(databaseHost(payloadWith('mongodb+srv://user:secret@Cluster0.ABC.example/test?retryWrites=true'))).toBe('cluster0.abc.example')
    expect(databaseHost(payloadWith('mongodb://u:p@b:27017,a:27017/test?replicaSet=rs0'))).toBe('a:27017,b:27017')
    expect(databaseHost(payloadWith('mongodb://a:27017,b:27017/test'))).toBe('a:27017,b:27017')
    expect(databaseHost({ db: {} } as unknown as Payload)).toBeNull()
  })

  it('refuses before reading the database when the first checks fail', async () => {
    let read = false
    const payload = { db: { url: 'mongodb://h/prod' }, find: async () => { read = true; return { docs: [] } } } as unknown as Payload
    await expect(assertAllowed(payload, { allow: () => true })).rejects.toThrow(/production/)
    expect(read).toBe(false)
  })

  it('refuses when the marker can’t be read, is missing, or belongs to another database or host', async () => {
    const withMarkers = (url: string, find: () => Promise<unknown>) => ({ db: { url }, find }) as unknown as Payload
    const ok = { allow: () => true }
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => { throw new Error('boom') }), ok)).rejects.toThrow(/can’t be read/)
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => ({ docs: [] })), ok)).rejects.toThrow(/hasn’t been marked/)
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => ({ docs: [{ database: 'test', host: 'other' }] })), ok)).rejects.toThrow(/another database or host/)
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => ({ docs: [{ database: 'dev', host: 'h' }] })), ok)).rejects.toThrow(/another database or host/)
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => ({ docs: [{ database: 'test', host: 'h' }] })), ok)).resolves.toBeUndefined()
    await expect(assertAllowed(withMarkers('mongodb://h/test', async () => ({ docs: [{ database: 'test', host: 'h' }] })), { ...ok, assertQuiet: () => { throw new Error('email is on') } })).rejects.toThrow(/outgoing effects aren’t off here \(email is on\)/)
  })

  it('adds the marker to every collection and hides its admin where not allowed', async () => {
    const config = (await seedPlugin({ allow: () => false })({ collections: [animals, groups, users] } as never)) as Config
    const slugs = config.collections!.map((c) => c.slug)
    expect(slugs).toEqual(['animals', 'groups', 'users', 'sandbox-batches', 'sandbox-records', 'seed-marker'])
    for (const c of config.collections!.slice(0, 3)) expect(c.fields.some((f) => 'name' in f && f.name === 'sandbox')).toBe(true)
    expect(config.collections!.find((c) => c.slug === 'sandbox-batches')!.admin!.hidden).toBe(true)
  })
})

describe('renamed from payload-plugin-sandbox (0.3.0)', () => {
  it('drops the old export names (gone in the first published version, 0.3.0)', async () => {
    const m = (await import('../src/index.js')) as Record<string, unknown>
    for (const old of ['sandboxPlugin', 'runSandbox', 'removeSandbox', 'SandboxRefused']) expect(m[old]).toBeUndefined()
    expect(typeof m.seedPlugin).toBe('function')
    // The component entry points load the admin UI (CSS and all), so check what they export as written.
    const { readFileSync } = await import('node:fs')
    const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    const rsc = readFileSync(new URL('../src/rsc/index.ts', import.meta.url), 'utf8')
    for (const text of [client, rsc]) expect(text).not.toMatch(/Sandbox/)
    expect(client).toMatch(/export \{ SeedPanel \}/)
    expect(rsc).toMatch(/export \{ SeedNavLink, SeedView \}/)
  })
})

describe('removal order', () => {
  it('reverses what the batches really did, before the schema’s guess', async () => {
    const { removalOrder } = await import('../src/index.js')
    // The schema's order (from a larger graph with cycles) puts groups after measurements; the batch made groups first.
    expect(removalOrder([['users', 'groups', 'animals', 'measurements']], ['users', 'animals', 'measurements', 'groups', 'notes'], ['users', 'groups', 'animals', 'measurements', 'notes', 'orphans'])).toEqual(['notes', 'measurements', 'animals', 'groups', 'users', 'orphans'])
    expect(removalOrder([], ['a', 'b'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(removalOrder([['x', 'a']], ['a'], ['a'])).toEqual(['a'])
  })
})

describe('retrying clashing writes', () => {
  it('retries write conflicts a few times, and fails anything else at once', async () => {
    const { isTransient, retryTransient } = await import('../src/index.js')
    const noWait = async () => {}
    expect(isTransient(new Error('Caused by :: Write conflict during plan execution and yielding is disabled.'))).toBe(true)
    expect(isTransient({ errorLabels: ['TransientTransactionError'] })).toBe(true)
    expect(isTransient({ message: 'wrapped', cause: { code: 112 } })).toBe(true)
    expect(isTransient(new Error('The following field is invalid: Group'))).toBe(false)
    const loop: { message: string; cause?: unknown } = { message: 'a' }
    loop.cause = { message: 'b', cause: loop }
    expect(isTransient(loop)).toBe(false)
    const deep = Array.from({ length: 10 }).reduce<unknown>((cause) => ({ message: 'wrapped', cause }), { code: 112 })
    expect(isTransient(deep)).toBe(false)
    let n = 0
    expect(await retryTransient(async () => (++n < 3 ? Promise.reject(new Error('Write conflict')) : 'ok'), 4, noWait)).toBe('ok')
    expect(n).toBe(3)
    n = 0
    await expect(retryTransient(async () => { n++; throw new Error('Write conflict') }, 4, noWait)).rejects.toThrow(/Write conflict/)
    expect(n).toBe(4)
    n = 0
    await expect(retryTransient(async () => { n++; throw new Error('invalid') }, 4, noWait)).rejects.toThrow('invalid')
    expect(n).toBe(1)
  })
})

describe('read-only links', () => {
  it('order creation but are never filled or planned', async () => {
    const accounts: CollectionConfig = { slug: 'accounts', fields: [{ name: 'name', type: 'text' }] }
    const memberships: CollectionConfig = { slug: 'memberships', fields: [{ name: 'user', type: 'relationship', relationTo: 'accounts', required: true, admin: { readOnly: true } }, { name: 'status', type: 'select', options: ['active', 'canceled'], admin: { readOnly: true } }, { name: 'note', type: 'text' }] }
    const models = [memberships, accounts].map(readCollection)
    expect(creationOrder(models).order).toEqual(['accounts', 'memberships'])
    const fields = readCollection(memberships).fields.map((f) => f.path)
    expect(fields).toEqual(['user', 'note'])
    const doc = buildDoc(readCollection(memberships), {}, { rnd: random('r'), serial: () => 1, emailDomain: 'example.invalid', pick: () => 'a1', pickMany: () => ['a1'], defer: () => false })
    expect(doc).not.toHaveProperty('user')
    const { draftCoveragePlan, checkCoveragePlan } = await import('../src/index.js')
    const plan = draftCoveragePlan({ collections: [accounts, memberships] })
    expect(Object.keys((plan.collections.memberships as { fields: object }).fields)).toEqual(['note'])
    expect(checkCoveragePlan({ collections: [accounts, memberships] }, plan).ok).toBe(true)
  })
})

describe('bulk removal settings', () => {
  it('refuses collections with versions, and names that aren’t collections, at start-up', () => {
    const base = { secret: 'x', db: {} as never, collections: [animals, groups, users] }
    expect(() => seedPlugin({ allow: () => true, bulkRemove: ['groups'] })(base as never)).not.toThrow()
    expect(() => seedPlugin({ allow: () => true, bulkRemove: ['nope'] })(base as never)).toThrow(/isn't a collection/)
    const versioned = { ...groups, slug: 'versioned', versions: { drafts: true } }
    expect(() => seedPlugin({ allow: () => true, bulkRemove: ['versioned'] })({ ...base, collections: [...base.collections, versioned] } as never)).toThrow(/keeps versions/)
  })
})
