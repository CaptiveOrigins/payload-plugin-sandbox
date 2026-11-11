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

describe('who may use the seed (test audit 2026-11-10)', () => {
  type Handler = (req: unknown) => Promise<Response>
  type Fn = (args: unknown) => unknown
  const setup = (options: Parameters<typeof seedPlugin>[0]) => {
    const config = seedPlugin(options)({ collections: [animals, groups, users] } as never) as Config
    const coll = (slug: string) => config.collections!.find((c) => c.slug === slug)!
    const endpoints = Object.fromEntries((coll('sandbox-batches').endpoints as { path: string; handler: Handler }[]).map((e) => [e.path, e.handler]))
    return { config, coll, endpoints }
  }
  // Any read or write here would mean a refusal came too late.
  const untouchable = new Proxy({}, { get: (_, key) => { throw new Error(`touched payload.${String(key)}`) } })
  const req = (user: unknown) => ({ user, payload: untouchable, json: async () => ({ collection: 'users', id: 'x' }), context: {} })

  it('refuses every endpoint, before touching the database, without a user, without access, or where allow() is false', async () => {
    const cases = [
      { options: { allow: () => true, access: () => true }, user: null },
      { options: { allow: () => true, access: () => false }, user: { id: 'u' } },
      { options: { allow: () => true }, user: { id: 'u' } },
      { options: { allow: () => false, access: () => true }, user: { id: 'u' } },
      { options: { access: () => true }, user: { id: 'u' } },
    ]
    for (const { options, user } of cases) {
      const { endpoints } = setup(options)
      expect(Object.keys(endpoints).sort()).toEqual(['/plan', '/remove', '/run', '/sign-in-as', '/size'])
      for (const [path, handler] of Object.entries(endpoints)) {
        const res = await handler(req(user))
        expect([path, res.status]).toEqual([path, 403])
      }
    }
  })

  it('refuses run and size with 403 when the database looks like production, even for an allowed admin', async () => {
    const { endpoints } = setup({ allow: () => true, access: () => true })
    const prod = { db: { url: 'mongodb://h/shop_prod' } }
    for (const path of ['/run', '/size']) {
      const res = await endpoints[path]!({ user: { id: 'u' }, payload: prod, json: async () => ({}) })
      expect([path, res.status]).toEqual([path, 403])
      expect(((await res.json()) as { error: string }).error).toMatch(/looks like production/)
    }
  })

  it('opens its own collections and settings only to people access lets in, and never to API writes', async () => {
    for (const options of [{ allow: () => true, access: () => false }, { allow: () => false, access: () => true }]) {
      const { config, coll } = setup(options)
      for (const slug of ['sandbox-batches', 'sandbox-records', 'seed-marker']) {
        const access = coll(slug).access as Record<string, Fn>
        expect([slug, await access.read!({ req: { user: { id: 'u' } } })]).toEqual([slug, false])
      }
      const settings = config.globals!.find((g) => g.slug === 'seed-settings')!.access as Record<string, Fn>
      expect(await settings.read!({ req: { user: { id: 'u' } } })).toBe(false)
      expect(await settings.update!({ req: { user: { id: 'u' } } })).toBe(false)
    }
    const { coll } = setup({ allow: () => true, access: () => true })
    expect(await (coll('sandbox-batches').access as Record<string, Fn>).read!({ req: { user: null } })).toBe(false)
    expect(await (coll('sandbox-batches').access as Record<string, Fn>).read!({ req: { user: { id: 'u' } } })).toBe(true)
    for (const slug of ['sandbox-batches', 'sandbox-records', 'seed-marker']) {
      const access = coll(slug).access as Record<string, Fn>
      expect([slug, access.create!({}), access.update!({})]).toEqual([slug, false, false])
    }
    for (const slug of ['sandbox-records', 'seed-marker']) expect((coll(slug).access as Record<string, Fn>).delete!({})).toBe(false)
  })

  it('lets only the seed set the marker and batch id, and nobody change the marker', () => {
    const { coll } = setup({ allow: () => true, access: () => true })
    for (const slug of ['animals', 'groups', 'users']) {
      const fields = coll(slug).fields as { name?: string; access?: Record<string, Fn> }[]
      const marker = fields.find((f) => f.name === 'sandbox')!.access!
      const batch = fields.find((f) => f.name === 'sandboxBatch')!.access!
      for (const context of [{}, { sandbox: undefined }, undefined]) {
        expect(marker.create!({ req: { context } })).toBe(false)
        expect(batch.create!({ req: { context } })).toBe(false)
        expect(batch.update!({ req: { context } })).toBe(false)
      }
      expect(marker.create!({ req: { context: { sandbox: { batch: 'b' } } } })).toBe(true)
      expect(marker.update!({ req: { context: { sandbox: { batch: 'b' } } } })).toBe(false)
      expect(batch.update!({ req: { context: { sandbox: { batch: 'b' } } } })).toBe(true)
    }
  })
})

describe('guard edges (test audit 2026-11-10)', () => {
  const payloadWith = (db: unknown, extra: object = {}) => ({ db, ...extra }) as unknown as Payload
  const ok = { allow: () => true }

  it('reads production in any case, from the adapter’s own name and from Postgres pools, and exempts only the exact name listed', () => {
    expect(() => assertConfigAllowed(payloadWith({ url: 'mongodb://h/MyApp_PROD' }), ok)).toThrow(/production/)
    expect(() => assertConfigAllowed(payloadWith({ url: 'mongodb://h/test', connection: { name: 'live-prod' } }), ok)).toThrow(/production/)
    expect(() => assertConfigAllowed(payloadWith({ poolOptions: { connectionString: 'postgres://u:p@h:5432/shop_prod' } }), ok)).toThrow(/production/)
    expect(() => assertConfigAllowed(payloadWith({ url: 'mongodb://h/prod' }), { ...ok, allowDatabases: ['prod-copy', 'PROD'] })).toThrow(/production/)
    expect(() => assertConfigAllowed(payloadWith({ url: 'not a url' }), ok)).toThrow(/can’t be read/)
    expect(() => assertConfigAllowed(payloadWith({ url: 'mongodb://h/test' }), { allow: () => undefined as never })).toThrow(/not allowed/)
  })

  it('refuses when the host can’t be read, before reading any marker', async () => {
    let read = false
    const p = payloadWith({ connection: { name: 'test' } }, { find: async () => { read = true; return { docs: [{ database: 'test', host: null }] } } })
    await expect(assertAllowed(p, ok)).rejects.toThrow(/host can’t be read/)
    expect(read).toBe(false)
  })

  it('refuses when assertQuiet rejects asynchronously, and isAllowed says no for every refusal', async () => {
    const { isAllowed } = await import('../src/index.js')
    const marked = (url: string) => payloadWith({ url }, { find: async () => ({ docs: [{ database: 'test', host: 'h' }] }) })
    await expect(assertAllowed(marked('mongodb://h/test'), { ...ok, assertQuiet: async () => { throw new Error('webhooks are on') } })).rejects.toThrow(/webhooks are on/)
    expect(await isAllowed(marked('mongodb://h/test'), ok)).toBe(true)
    expect(await isAllowed(marked('mongodb://h/test'), {})).toBe(false)
    expect(await isAllowed(marked('mongodb://h/prod'), ok)).toBe(false)
    expect(await isAllowed(payloadWith({ url: 'mongodb://h/test' }, { find: async () => { throw new Error('down') } }), ok)).toBe(false)
  })

  it('never marks production, an unreadable host, or a database whose name wasn’t typed, and writes nothing when it refuses', async () => {
    const { markTestDatabase } = await import('../src/index.js')
    let wrote = false
    const p = (db: unknown) => payloadWith(db, { find: async () => ({ docs: [] }), create: async () => { wrote = true; return {} } })
    await expect(markTestDatabase(p({ url: 'mongodb://h/prod' }), ok, { confirm: 'prod' })).rejects.toThrow(/production/)
    await expect(markTestDatabase(p({ url: 'mongodb://h/test' }), {}, { confirm: 'test' })).rejects.toThrow(/not allowed/)
    await expect(markTestDatabase(p({ connection: { name: 'test' } }), ok, { confirm: 'test' })).rejects.toThrow(/host can’t be read/)
    await expect(markTestDatabase(p({ url: 'mongodb://h/test' }), ok, { confirm: 'TEST' })).rejects.toThrow(/type the database name/)
    expect(wrote).toBe(false)
  })
})

describe('only an exact true from allow() and access (test audit 2026-11-11)', () => {
  type Handler = (req: unknown) => Promise<Response>
  type Fn = (args: unknown) => unknown
  const payloadWith = (url: string) => ({ db: { url } }) as unknown as Payload
  /** Truthy answers that aren't `true`, and a throw: an environment string 'false' is the one that bites. */
  const NOT_TRUE: [string, () => unknown][] = [
    ["'false'", () => 'false'],
    ["'true'", () => 'true'],
    ['1', () => 1],
    ['an object', () => ({})],
    ['a promise of true', async () => true],
    ['a thrown error', () => {
      throw new Error('settings store down')
    }],
  ]
  const untouchable = new Proxy({}, { get: (_, key) => { throw new Error(`touched payload.${String(key)}`) } })
  const setup = (options: Parameters<typeof seedPlugin>[0]) => {
    const config = seedPlugin(options)({ collections: [animals, groups, users] } as never) as Config
    const coll = (slug: string) => config.collections!.find((c) => c.slug === slug)!
    const endpoints = Object.fromEntries((coll('sandbox-batches').endpoints as { path: string; handler: Handler }[]).map((e) => [e.path, e.handler]))
    return { config, coll, endpoints }
  }

  it('refuses the guard unless allow() returns exactly true', () => {
    for (const [what, answer] of NOT_TRUE) expect(() => assertConfigAllowed(payloadWith('mongodb://h/test'), { allow: answer as never }), what).toThrow(/not allowed/)
    expect(() => assertConfigAllowed(payloadWith('mongodb://h/test'), { allow: () => true })).not.toThrow()
  })

  it('keeps the database-name check after an exact true', () => {
    expect(() => assertConfigAllowed(payloadWith('mongodb://h/shop_prod'), { allow: () => true })).toThrow(/production/)
  })

  it('hides the admin and refuses every endpoint and collection read where allow() says anything but true', async () => {
    for (const [what, answer] of NOT_TRUE) {
      const { config, coll, endpoints } = setup({ allow: answer as never, access: () => true })
      expect(config.admin?.components?.views?.seed, what).toBeUndefined()
      for (const [path, handler] of Object.entries(endpoints)) expect([what, path, (await handler({ user: { id: 'u' }, payload: untouchable, json: async () => ({}) })).status]).toEqual([what, path, 403])
      expect(await (coll('sandbox-batches').access as Record<string, Fn>).read!({ req: { user: { id: 'u' } } }), what).toBe(false)
    }
    const { config } = setup({ allow: () => true, access: () => true })
    expect(config.admin?.components?.views?.seed).toBeDefined()
  })

  it('refuses every endpoint and collection read with 403 where access says anything but true, a throw included', async () => {
    const answers: [string, () => unknown][] = [...NOT_TRUE.filter(([w]) => w !== 'a promise of true'), ['a rejected promise', async () => { throw new Error('roles store down') }]]
    for (const [what, answer] of answers) {
      const { coll, config, endpoints } = setup({ allow: () => true, access: answer as never })
      for (const [path, handler] of Object.entries(endpoints)) expect([what, path, (await handler({ user: { id: 'u' }, payload: untouchable, json: async () => ({}) })).status]).toEqual([what, path, 403])
      for (const slug of ['sandbox-batches', 'sandbox-records', 'seed-marker']) expect([what, slug, await (coll(slug).access as Record<string, Fn>).read!({ req: { user: { id: 'u' } } })]).toEqual([what, slug, false])
      expect(await (coll('sandbox-batches').access as Record<string, Fn>).delete!({ req: { user: { id: 'u' } } }), what).toBe(false)
      const settings = config.globals!.find((g) => g.slug === 'seed-settings')!.access as Record<string, Fn>
      expect(await settings.update!({ req: { user: { id: 'u' } } }), what).toBe(false)
    }
    const { coll } = setup({ allow: () => true, access: async () => true })
    expect(await (coll('sandbox-batches').access as Record<string, Fn>).read!({ req: { user: { id: 'u' } } })).toBe(true)
  })
})
