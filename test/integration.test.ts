import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { markTestDatabase, measureCluster, removeSeed, runSeed, seedPlugin, type SeedOptions } from '../src/index.js'

/** A real Payload on a throwaway MongoDB database (MONGODB_URL, default the local test container). */
const BASE = process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27018/?directConnection=true'
const dbName = `sandbox_test_${Date.now().toString(36)}`
const url = BASE.replace(/\/(\?|$)/, `/${dbName}$1`)

const users: CollectionConfig = { slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }, { name: 'roles', type: 'select', hasMany: true, options: ['admin', 'keeper', 'member'] }] }
const media: CollectionConfig = { slug: 'media', upload: { mimeTypes: ['image/*'] }, fields: [{ name: 'alt', type: 'text', required: true }] }
const groups: CollectionConfig = { slug: 'groups', fields: [{ name: 'title', type: 'text', required: true }, { name: 'owner', type: 'relationship', relationTo: 'users', required: true }] }
/** Its delete always says "not found", as a stale copy or a hiding hook would. */
const ghosts: CollectionConfig = { slug: 'ghosts', fields: [{ name: 'title', type: 'text' }], hooks: { beforeDelete: [() => { throw new Error('Document not found') }] } }
const animals: CollectionConfig = {
  slug: 'animals',
  versions: { drafts: true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'sex', type: 'select', options: ['female', 'male', 'unknown'] },
    { name: 'group', type: 'relationship', relationTo: 'groups', required: true },
    { name: 'photo', type: 'upload', relationTo: 'media' },
    { name: 'parents', type: 'relationship', relationTo: 'animals', hasMany: true },
    { name: 'identifiers', type: 'array', fields: [{ name: 'value', type: 'text', required: true }] },
    { name: 'born', type: 'date' },
  ],
}

let payload: Payload
const options: SeedOptions = {
  allow: () => true,
  access: () => true,
  recipes: {
    // A site rule the schema can't express: names are unique per group.
    animals: { prepare: (data, ctx) => ({ ...data, name: `${data.name} #${ctx.created('animals').length + 1}` }) },
  },
}

beforeAll(async () => {
  payload = await getPayload({
    config: await buildConfig({
      secret: 'sandbox-test-secret',
      db: mongooseAdapter({ url }),
      collections: [users, media, groups, animals, ghosts],
      plugins: [seedPlugin(options)],
      typescript: { autoGenerate: false },
      upload: {},
    }),
  })
  await markTestDatabase(payload, options, { confirm: dbName, by: 'integration test' })
})

afterAll(async () => {
  await (payload?.db as unknown as { connection?: { dropDatabase: () => Promise<void> } })?.connection?.dropDatabase()
  await payload?.destroy?.()
})

describe('a real sandbox run', () => {
  it('creates every collection in order with full pair coverage, marks and registers every document', async () => {
    const report = await runSeed(payload, options, { seed: 'test-1' })
    expect(report.order).toEqual(['ghosts', 'media', 'users', 'groups', 'animals'])
    expect(report.failures).toEqual([])
    for (const c of report.collections) {
      expect(c.created).toBe(c.cases)
      expect(c.pairs.covered).toBe(c.pairs.total)
    }
    const animalsReport = report.collections.find((c) => c.collection === 'animals')!
    const { docs } = await payload.find({ collection: 'animals', draft: true, pagination: false, depth: 0 })
    expect(docs.length).toBe(animalsReport.created)
    expect(docs.every((d) => (d as { sandbox?: boolean }).sandbox)).toBe(true)
    expect(new Set(docs.map((d) => (d as { sex?: string }).sex ?? 'empty'))).toEqual(new Set(['female', 'male', 'unknown', 'empty']))
    expect(new Set(docs.map((d) => (d as { _status?: string })._status))).toEqual(new Set(['draft', 'published']))
    // Shapes: several generations with gaps (self-referencing parents).
    const withParents = docs.filter((d) => ((d as { parents?: unknown[] }).parents ?? []).length)
    expect(withParents.length).toBeGreaterThan(docs.length / 2)
    expect(withParents.length).toBeLessThan(docs.length)
    const user = (await payload.find({ collection: 'users', limit: 1 })).docs[0] as unknown as { email: string }
    expect(user.email).toMatch(/@example\.invalid$/)
  })

  it('removes everything it created, and nothing else', async () => {
    const real = await payload.create({ collection: 'users', data: { email: 'real@example.com', password: 'a-real-password-1' } })
    const result = await removeSeed(payload, options)
    expect(result.failed).toEqual([])
    for (const c of ['animals', 'groups', 'media', 'sandbox-records', 'sandbox-batches'] as const) expect((await payload.count({ collection: c as never })).totalDocs).toBe(0)
    expect((await payload.find({ collection: 'users' })).docs.map((d) => d.id)).toEqual([real.id])
  })

  it('refuses to run where it is not allowed', async () => {
    await expect(runSeed(payload, { ...options, allow: () => false })).rejects.toThrow(/not allowed/)
  })

  it('marks a test database only when the name is typed, once, and never through the API', async () => {
    await expect(markTestDatabase(payload, options, { confirm: 'test' })).rejects.toThrow(/type the database name/)
    await expect(markTestDatabase(payload, { ...options, allow: () => false }, { confirm: dbName })).rejects.toThrow(/not allowed/)
    expect((await markTestDatabase(payload, options, { confirm: dbName })).created).toBe(false)
    expect((await payload.count({ collection: 'seed-marker' as never })).totalDocs).toBe(1)
    await expect(payload.create({ collection: 'seed-marker' as never, data: { database: dbName, host: 'x' } as never, overrideAccess: false })).rejects.toThrow()
  })

  it('refuses a database whose marker was written on another host (a restored copy)', async () => {
    const marker = (await payload.find({ collection: 'seed-marker' as never, depth: 0 })).docs[0] as unknown as { id: string; host: string }
    await payload.update({ collection: 'seed-marker' as never, id: marker.id, data: { host: 'elsewhere.example.net' } as never, overrideAccess: true })
    try {
      await expect(runSeed(payload, options, { collections: ['users'] })).rejects.toThrow(/another database or host/)
    } finally {
      await payload.update({ collection: 'seed-marker' as never, id: marker.id, data: { host: marker.host } as never, overrideAccess: true })
    }
  })

  it('doesn’t report seed data as misplaced on a test database that isn’t marked yet', async () => {
    const report = await runSeed(payload, options, { seed: 'oninit-1', collections: ['users'] })
    const errors: string[] = []
    const logger = { ...payload.logger, error: (m: unknown) => errors.push(String(m)) }
    const onInit = (seedPlugin(options)({ collections: [users], onInit: undefined } as never) as { onInit: (p: Payload) => Promise<void> }).onInit
    // Unmarked: the marker can't be found, but the configuration says this is a test database.
    await onInit({ ...payload, logger, find: async () => ({ docs: [] }), count: payload.count.bind(payload) } as unknown as Payload)
    expect(errors).toEqual([])
    // Configuration says production: marked records are reported, and nothing is removed.
    await onInit({ ...payload, logger, count: payload.count.bind(payload) } as unknown as Payload)
    await (seedPlugin({ ...options, allow: () => false })({ collections: [users] } as never) as { onInit: (p: Payload) => Promise<void> }).onInit({ ...payload, logger, count: payload.count.bind(payload) } as unknown as Payload)
    expect(errors.some((e) => /Seed data found in “users”/.test(e))).toBe(true)
    expect((await payload.count({ collection: 'users', where: { sandboxBatch: { equals: report.batch } } })).totalDocs).toBeGreaterThan(0)
    await removeSeed(payload, options, { batch: report.batch })
  })

  it('refuses while outgoing effects are on', async () => {
    await expect(runSeed(payload, { ...options, assertQuiet: () => { throw new Error('payments are on') } }, { collections: ['users'] })).rejects.toThrow(/payments are on/)
  })
})

describe('plans, personas and signing in', () => {
  const planOptions: SeedOptions = {
    ...options,
    about: 'A site for reptile keepers.',
    personas: [{ collection: 'users', name: 'Site Persona', story: 'Written by the site.', data: { roles: ['keeper'] } }],
    ai: async ({ prompt }) => {
      const seen = JSON.parse(prompt) as { site: string; collections: { slug: string; textFields: string[] }[] }
      expect(seen.site).toBe('A site for reptile keepers.')
      expect(seen.collections.find((c) => c.slug === 'groups')!.textFields).toEqual(['title'])
      return {
        summary: 'A keeper with a few groups.',
        collections: [
          { slug: 'groups', note: 'Racks', samples: [{ field: 'title', values: ['Rack A', 'Hatchling tubs'] }, { field: 'nonsense', values: ['x'] }] },
          { slug: 'nope', note: '', samples: [] },
        ],
        personas: [
          { collection: 'users', name: 'Ana Keeper', story: 'Keeps ten pythons. Try adding a clutch.', traits: ['keeper'] },
          { collection: 'groups', name: 'Not an account', story: '', traits: [] },
        ],
      }
    },
  }

  it('an AI plan is checked, then used: its wording and people, never fields that don’t exist', async () => {
    const { writePlan } = await import('../src/index.js')
    const plan = await writePlan(payload, planOptions, { collections: ['groups', 'users'] })
    expect(plan.source).toBe('ai')
    expect(plan.collections.map((c) => c.slug).sort()).toEqual(['groups', 'users'])
    expect(plan.collections.find((c) => c.slug === 'groups')!.samples).toEqual({ title: ['Rack A', 'Hatchling tubs'] })
    expect(plan.personas.map((p) => p.name)).toEqual(['Site Persona', 'Ana Keeper'])

    const report = await runSeed(payload, planOptions, { seed: 'plan-1', plan })
    expect(report.failures).toEqual([])
    expect(report.personas!.map((p) => p.name)).toEqual(['Site Persona', 'Ana Keeper'])
    expect(report.personas![0]!.email).toMatch(/^site\.persona\.[a-z0-9]+@example\.invalid$/)
    const titles = (await payload.find({ collection: 'groups', pagination: false, depth: 0 })).docs.map((d) => (d as unknown as { title: string }).title)
    expect(titles.some((t) => t === 'Rack A' || t === 'Hatchling tubs')).toBe(true)
    const site = await payload.findByID({ collection: 'users', id: report.personas![0]!.id, depth: 0 })
    expect((site as { roles?: string[] }).roles).toEqual(['keeper'])
  })

  it('a failing AI falls back to a plain plan and says why', async () => {
    const { writePlan } = await import('../src/index.js')
    const plan = await writePlan(payload, { ...options, ai: async () => { throw new Error('no key') } })
    expect(plan.source).toBe('plain')
    expect(plan.aiError).toBe('no key')
  })

  it('signs in as sandbox accounts only, and only where allowed', async () => {
    const { signInAs } = await import('../src/index.js')
    const sandboxUser = (await payload.find({ collection: 'users', where: { sandbox: { equals: true } }, limit: 1 })).docs[0]!
    const real = await payload.create({ collection: 'users', data: { email: `real-${Date.now()}@example.com`, password: 'a-real-password-1' } })
    const req = { payload, headers: new Headers() } as never
    const { cookie } = await signInAs(req, options, 'users', String(sandboxUser.id))
    expect(cookie).toMatch(/^payload-token=.+; Path=\/; HttpOnly/)
    const token = /payload-token=([^;]+)/.exec(cookie)![1]!
    const me = await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })
    expect(me.user?.id).toBe(sandboxUser.id)
    await expect(signInAs(req, options, 'users', String(real.id))).rejects.toThrow(/Only seeded accounts/)
    await expect(signInAs(req, { ...options, allow: () => false }, 'users', String(sandboxUser.id))).rejects.toThrow(/not allowed/)
    await payload.delete({ collection: 'users', id: real.id })
    await removeSeed(payload, options)
  })

  it('offers the admin area only where the sandbox is allowed', async () => {
    const base = { secret: 'x', db: {} as never, collections: [users] }
    const on = seedPlugin({ allow: () => true })(base as never) as { admin?: { components?: { views?: Record<string, unknown> } } }
    const off = seedPlugin({ allow: () => false })(base as never) as { admin?: { components?: { views?: Record<string, unknown> } } }
    expect(on.admin?.components?.views?.seed).toBeTruthy()
    expect(off.admin?.components?.views?.seed).toBeUndefined()
  })
})

describe('sites with their own records', () => {
  it('refers to existing documents instead of generating them, and generates only what it’s told', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `owner-${Date.now()}@example.com`, password: 'a-real-password-1', name: 'Real owner' } })
    let wrapped = 0
    const report = await runSeed(
      payload,
      {
        ...options,
        recipes: {},
        only: ['groups'],
        existing: { users: { where: { id: { equals: owner.id } } } },
        around: async (task) => {
          wrapped++
          return task()
        },
      },
      { seed: 'existing-1' },
    )
    expect(report.order).toEqual(['groups'])
    expect(report.failures).toEqual([])
    expect(wrapped).toBe(1)
    const groupsMade = (await payload.find({ collection: 'groups', pagination: false, depth: 0 })).docs as unknown as { owner: string }[]
    expect(groupsMade.length).toBeGreaterThan(0)
    expect(new Set(groupsMade.map((g) => g.owner))).toEqual(new Set([owner.id]))
    await removeSeed(payload, options)
    expect((await payload.findByID({ collection: 'users', id: owner.id })).id).toBe(owner.id)
    await payload.delete({ collection: 'users', id: owner.id })
  })
})

describe('the batch id on the marker (0.3.0)', () => {
  it('writes no register documents, puts the batch on every document, and removes one batch without touching another', async () => {
    const first = await runSeed(payload, options, { seed: 'marker-1', collections: ['users', 'groups'] })
    const second = await runSeed(payload, options, { seed: 'marker-2', collections: ['users', 'groups'] })
    expect((await payload.count({ collection: 'sandbox-records' as never })).totalDocs).toBe(0)
    const groups = (await payload.find({ collection: 'groups', pagination: false, depth: 0 })).docs as unknown as { sandboxBatch?: string }[]
    expect(new Set(groups.map((g) => g.sandboxBatch))).toEqual(new Set([first.batch, second.batch]))
    const result = await removeSeed(payload, options, { batch: first.batch })
    expect(result.failed).toEqual([])
    const left = (await payload.find({ collection: 'groups', pagination: false, depth: 0 })).docs as unknown as { sandboxBatch?: string }[]
    expect(left.length).toBeGreaterThan(0)
    expect(left.every((g) => g.sandboxBatch === second.batch)).toBe(true)
    await removeSeed(payload, options)
    for (const c of ['users', 'groups'] as const) expect([c, (await payload.count({ collection: c, where: { sandbox: { equals: true } } })).totalDocs]).toEqual([c, 0])
    expect((await payload.count({ collection: 'sandbox-batches' as never })).totalDocs).toBe(0)
  })

  it('still keeps a register when asked, and removes it the same way', async () => {
    const legacy: SeedOptions = { ...options, register: 'records' }
    const report = await runSeed(payload, legacy, { seed: 'records-1', collections: ['users'] })
    expect((await payload.count({ collection: 'sandbox-records' as never })).totalDocs).toBe(report.collections[0]!.created)
    expect(((await payload.find({ collection: 'users', where: { sandbox: { equals: true } }, limit: 1, depth: 0 })).docs[0] as { sandboxBatch?: string }).sandboxBatch).toBeFalsy()
    expect((await removeSeed(payload, legacy)).failed).toEqual([])
    expect((await payload.count({ collection: 'users', where: { sandbox: { equals: true } } })).totalDocs).toBe(0)
    for (const c of ['sandbox-records', 'sandbox-batches'] as const) expect((await payload.count({ collection: c as never })).totalDocs).toBe(0)
  })

  it('never deletes a document a register row points at unless it still carries the seed marker', async () => {
    const legacy: SeedOptions = { ...options, register: 'records' }
    const report = await runSeed(payload, legacy, { seed: 'records-2', collections: ['users'] })
    // A bad register row pointing at a real, unmarked account; and one pointing at a document that's gone.
    const real = await payload.create({ collection: 'users', data: { email: `real-reg-${Date.now()}@example.com`, password: 'a-real-password-1' } })
    await payload.create({ collection: 'sandbox-records' as never, data: { batch: report.batch, collection: 'users', docId: String(real.id), order: 9999 } as never, overrideAccess: true })
    await payload.create({ collection: 'sandbox-records' as never, data: { batch: report.batch, collection: 'users', docId: '000000000000000000000000', order: 9998 } as never, overrideAccess: true })
    const result = await removeSeed(payload, legacy, { batch: report.batch })
    expect(result.failed).toEqual([])
    expect(result.notSeeded).toEqual([{ collection: 'users', id: String(real.id) }])
    expect((await payload.findByID({ collection: 'users', id: real.id, depth: 0 })).id).toBe(real.id)
    // The bad row stays for a person to look at; the gone one was dropped; the batch is kept while a row is left.
    expect((await payload.count({ collection: 'sandbox-records' as never, where: { batch: { equals: report.batch } } as never })).totalDocs).toBe(1)
    expect((await payload.count({ collection: 'sandbox-batches' as never, where: { id: { equals: report.batch } } as never })).totalDocs).toBe(1)
    expect((await payload.count({ collection: 'users', where: { sandboxBatch: { equals: report.batch } } as never })).totalDocs).toBe(0)
    // A row whose document can't be read (here, a collection that doesn't exist) is kept and reported, never dropped.
    await payload.create({ collection: 'sandbox-records' as never, data: { batch: report.batch, collection: 'no-such-collection', docId: '000000000000000000000001', order: 9997 } as never, overrideAccess: true })
    const again = await removeSeed(payload, legacy, { batch: report.batch })
    expect(again.failed.map((f) => f.collection)).toEqual(['no-such-collection'])
    expect((await payload.count({ collection: 'sandbox-records' as never, where: { batch: { equals: report.batch } } as never })).totalDocs).toBe(2)
    await payload.delete({ collection: 'sandbox-records' as never, where: { batch: { equals: report.batch } } as never, overrideAccess: true })
    await payload.delete({ collection: 'sandbox-batches' as never, id: report.batch, overrideAccess: true })
    await payload.delete({ collection: 'users', id: real.id })
  })

  it('counts draft-only seeded documents as seeded when removing through the register', async () => {
    const legacy: SeedOptions = { ...options, register: 'records' }
    const report = await runSeed(payload, legacy, { seed: 'records-3', collections: ['animals'] })
    const drafts = (await payload.count({ collection: 'animals', where: { and: [{ sandbox: { equals: true } }, { _status: { equals: 'draft' } }] }, draft: true } as never)).totalDocs
    expect(drafts).toBeGreaterThan(0)
    const result = await removeSeed(payload, legacy, { batch: report.batch })
    expect(result.notSeeded).toEqual([])
    expect(result.failed).toEqual([])
    expect((await payload.count({ collection: 'animals', where: { sandbox: { equals: true } }, draft: true } as never)).totalDocs).toBe(0)
  })

  it('adopts a document a recipe made itself, so removal takes it too', async () => {
    const adopting: SeedOptions = {
      ...options,
      recipes: {
        users: {
          after: async (ctx) => {
            const doc = await ctx.payload.create({ collection: 'users', data: { email: 'made-by-recipe@example.invalid', password: 'x-unused-password-1', sandbox: true } as never, overrideAccess: true, context: { sandbox: { batch: ctx.batch } } })
            await ctx.track('users', String(doc.id))
          },
        },
      },
    }
    const report = await runSeed(payload, adopting, { seed: 'track-1', collections: ['users'] })
    const adopted = (await payload.find({ collection: 'users', where: { email: { equals: 'made-by-recipe@example.invalid' } }, depth: 0 })).docs[0] as unknown as { sandboxBatch?: string }
    expect(adopted.sandboxBatch).toBe(report.batch)
    await removeSeed(payload, adopting, { batch: report.batch })
    expect((await payload.count({ collection: 'users', where: { email: { equals: 'made-by-recipe@example.invalid' } } })).totalDocs).toBe(0)
  })

  it('ends even when a delete always says "not found"', async () => {
    const report = await runSeed(payload, options, { seed: 'ghosts-1', collections: ['ghosts'] })
    expect(report.collections[0]!.created).toBeGreaterThan(0)
    const result = await removeSeed(payload, options, { batch: report.batch, collection: 'ghosts' })
    expect(result.failed).toEqual([])
    expect(result.removed).toBe(0)
  })

  it('never deletes what the site keeps, even when marked, and reports it', async () => {
    const report = await runSeed(payload, options, { seed: 'keep-1', collections: ['users'] })
    const seeded = (await payload.find({ collection: 'users', where: { sandboxBatch: { equals: report.batch } }, depth: 0, pagination: false })).docs as unknown as { id: string; email: string }[]
    const keeper = seeded[0]!
    const keeping: SeedOptions = { ...options, keep: { users: { email: { equals: keeper.email } } } }
    const result = await removeSeed(payload, keeping, { batch: report.batch })
    expect(result.kept).toEqual([{ collection: 'users', id: String(keeper.id) }])
    expect(result.removed).toBe(seeded.length - 1)
    expect((await payload.findByID({ collection: 'users', id: keeper.id, depth: 0 })).id).toBe(keeper.id)
    // A batch with kept documents isn't forgotten.
    expect((await payload.count({ collection: 'sandbox-batches' as never, where: { id: { equals: report.batch } } as never })).totalDocs).toBe(1)
  })
})

describe('measuring the cluster', () => {
  it('measures documents plus indexes, grows with a load, and refuses a database it can’t measure', async () => {
    await expect(measureCluster(payload, { databases: [] })).rejects.toThrow(/Name every database/)
    await expect(measureCluster(payload, { databases: ['other'] })).rejects.toThrow(/include the current one/)
    const before = await measureCluster(payload, { databases: [dbName] })
    expect(Object.keys(before.byDatabase)).toEqual([dbName])
    const report = await runSeed(payload, options, { seed: 'size-1', collections: ['users', 'groups'] })
    const after = await measureCluster(payload, { databases: [dbName] })
    expect(after.usedBytes).toBeGreaterThan(before.usedBytes)
    expect(after.byDatabase[dbName]!.indexBytes).toBeGreaterThan(0)
    await removeSeed(payload, options, { batch: report.batch })
    // A mistyped or missing database is an error, never 0.
    await expect(measureCluster(payload, { databases: [dbName, `${dbName}_typo`] })).rejects.toThrow(/no collections/)
    await expect(measureCluster(payload, { databases: [dbName, 'bad/name'] })).rejects.toThrow()
  })
})

describe('big seeds (0.3.0)', () => {
  const big: SeedOptions = { ...options, concurrency: 6 }

  it('makes the coverage cases, then more up to the counts, with full pair coverage', async () => {
    const report = await runSeed(payload, big, { seed: 'big-1', collections: ['animals'], counts: { animals: 150, groups: 30 } })
    expect(report.failures).toEqual([])
    const a = report.collections.find((c) => c.collection === 'animals')!
    expect(a.pairs.covered).toBe(a.pairs.total)
    expect(a.created).toBe(150)
    expect(report.collections.find((c) => c.collection === 'groups')!.created).toBe(30)
    expect((await payload.count({ collection: 'animals', where: { sandboxBatch: { equals: report.batch } }, draft: true } as never)).totalDocs).toBe(150)
    await removeSeed(payload, big, { batch: report.batch })
  })

  it('sizes counts from the settings and the cluster, and refuses before writing when they don’t fit', async () => {
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { counts: { groups: { ceiling: 200, minimum: 20, bulk: true }, users: { ceiling: 50, minimum: 5 } }, bytesPerRecord: { groups: 40_000, users: 900 }, databases: [dbName], limitMB: 1, targetShare: 0.8 } as never })
    const batchesBefore = (await payload.count({ collection: 'sandbox-batches' as never })).totalDocs
    await expect(runSeed(payload, big, { seed: 'big-2', collections: ['groups'], size: 'big' })).rejects.toThrow(/Refusing a big seed/)
    expect((await payload.count({ collection: 'sandbox-batches' as never })).totalDocs).toBe(batchesBefore)
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { limitMB: 4096 } as never })
    const report = await runSeed(payload, big, { seed: 'big-2', collections: ['groups'], size: 'big' })
    expect(report.sizing?.ok).toBe(true)
    expect(report.counts).toEqual({ groups: 200, users: 50 })
    expect(report.collections.find((c) => c.collection === 'groups')!.created).toBe(200)
    await removeSeed(payload, big, { batch: report.batch })
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { counts: {}, bytesPerRecord: {}, databases: [], limitMB: null, targetShare: null } as never })
  })

  it('carries on after an interruption, keeping what was made and making the rest', async () => {
    let made = 0
    const failing: SeedOptions = { ...big, recipes: { groups: { prepare: (data) => { if (++made > 60) throw new Error('connection lost'); return data } } } }
    await expect(runSeed(payload, failing, { seed: 'resume-1', collections: ['groups'], counts: { groups: 120 } })).rejects.toThrow(/connection lost/)
    const batch = (await payload.find({ collection: 'sandbox-batches' as never, where: { seed: { equals: 'resume-1' } } as never, depth: 0 })).docs[0] as unknown as { id: string; status: string }
    expect(batch.status).toBe('running')
    const partial = (await payload.count({ collection: 'groups', where: { sandboxBatch: { equals: batch.id } } })).totalDocs
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(120)
    const report = await runSeed(payload, big, { resume: batch.id })
    expect(report.batch).toBe(batch.id)
    expect((await payload.count({ collection: 'groups', where: { sandboxBatch: { equals: batch.id } } })).totalDocs).toBe(120)
    await expect(runSeed(payload, big, { resume: batch.id })).rejects.toThrow(/Only a batch that was interrupted/)
    await removeSeed(payload, big, { batch: batch.id })
  })

  it('measures again before carrying on a sized batch, and refuses if the rest no longer fits', async () => {
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { counts: { groups: { ceiling: 80, minimum: 10, bulk: true } }, bytesPerRecord: { groups: 400, users: 900 }, databases: [dbName], limitMB: 4096 } as never })
    let made = 0
    const failing: SeedOptions = { ...big, recipes: { groups: { prepare: (data) => { if (++made > 30) throw new Error('connection lost'); return data } } } }
    await expect(runSeed(payload, failing, { seed: 'resize-1', collections: ['groups'], size: 'big' })).rejects.toThrow(/connection lost/)
    const batch = (await payload.find({ collection: 'sandbox-batches' as never, where: { seed: { equals: 'resize-1' } } as never, depth: 0 })).docs[0] as unknown as { id: string }
    // The rest (50 groups at a measured 1 MB each) no longer fits in the configured limit.
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { limitMB: 1, bytesPerRecord: { groups: 1_000_000, users: 900 } } as never })
    await expect(runSeed(payload, big, { resume: batch.id })).rejects.toThrow(/Refusing to carry on/)
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { limitMB: 4096, bytesPerRecord: { groups: 400, users: 900 } } as never })
    await runSeed(payload, big, { resume: batch.id })
    expect((await payload.count({ collection: 'groups', where: { sandboxBatch: { equals: batch.id } } })).totalDocs).toBe(80)
    await removeSeed(payload, big, { batch: batch.id })
    await payload.updateGlobal({ slug: 'seed-settings' as never, data: { counts: {}, bytesPerRecord: {}, databases: [], limitMB: null } as never })
  })

  it('writes text from a text source onto the fields it describes, never ids, and leaves edge cases alone', async () => {
    const seen: { describe: string; fields: string[] }[] = []
    const report = await runSeed(payload, big, {
      seed: 'texts-1',
      collections: ['groups'],
      counts: { groups: 25 },
      texts: async (jobs) => {
        for (const j of jobs) seen.push({ describe: j.describe, fields: j.fields.map((f) => f.path) })
        return new Map(jobs.map((j) => [j.key, { title: `Written ${j.key}` }]))
      },
    })
    const groupJobs = seen.filter((s) => s.describe.startsWith('groups;'))
    // Edge cases keep their deliberately odd text: the rest is written.
    expect(groupJobs.length).toBeGreaterThan(20)
    expect(groupJobs.length).toBeLessThan(25)
    expect(report.texts!.requested).toBe(seen.length)
    expect(report.texts!.written).toBe(seen.length)
    expect(groupJobs.every((s) => s.fields.join() === 'title')).toBe(true)
    expect(seen.every((s) => !/[0-9a-f]{24}/.test(s.describe))).toBe(true)
    const titles = (await payload.find({ collection: 'groups', where: { sandboxBatch: { equals: report.batch } }, pagination: false, depth: 0 })).docs.map((d) => (d as unknown as { title: string }).title)
    expect(titles.filter((t) => t.startsWith('Written groups:')).length).toBe(groupJobs.length)
    await removeSeed(payload, big, { batch: report.batch })
  })

  it('small seeds never call the site’s text source', async () => {
    let called = false
    const report = await runSeed(payload, { ...big, texts: async () => { called = true; return new Map() } }, { seed: 'texts-2', collections: ['users'] })
    expect(called).toBe(false)
    await removeSeed(payload, big, { batch: report.batch })
  })
})

describe('asking before spending (0.3.0)', () => {
  it('stops before writing anything when text could cost more than "ask above", and runs once the amount is confirmed', async () => {
    const { estimateRun, SpendNeedsConfirmation } = await import('../src/index.js')
    let wrote = 0
    const texts = Object.assign(
      async (jobs: { key: string }[]) => {
        wrote += jobs.length
        return new Map(jobs.map((j) => [j.key, { title: 'Confirmed text' }]))
      },
      { estimate: () => ({ requests: 2, worstUSD: 20, expectedUSD: 6, cached: 0 }) },
    )
    const costly: SeedOptions = { ...options, texts: texts as never }
    const batchesBefore = (await payload.count({ collection: 'sandbox-batches' as never })).totalDocs
    const estimate = await estimateRun(payload, costly, { seed: 'spend-1', collections: ['groups'], counts: { groups: 12 }, size: 'big' })
    expect(estimate).toMatchObject({ worstUSD: 20, expectedUSD: 6, askAboveUSD: 5, capUSD: 10 })
    await expect(runSeed(payload, costly, { seed: 'spend-1', collections: ['groups'], counts: { groups: 12 }, size: 'big' })).rejects.toThrow(SpendNeedsConfirmation)
    expect(wrote).toBe(0)
    expect((await payload.count({ collection: 'sandbox-batches' as never })).totalDocs).toBe(batchesBefore)
    await expect(runSeed(payload, costly, { seed: 'spend-1', collections: ['groups'], counts: { groups: 12 }, size: 'big', confirmSpendUSD: 19.99 })).rejects.toThrow(/up to \$20\.00/)
    const report = await runSeed(payload, costly, { seed: 'spend-1', collections: ['groups'], counts: { groups: 12 }, size: 'big', confirmSpendUSD: 20 })
    expect(wrote).toBeGreaterThan(0)
    expect(report.failures).toEqual([])
    await removeSeed(payload, costly, { batch: report.batch })
  })
})

describe('the realism audit (0.4.0)', () => {
  it('passes a clean run, and marks a run "done with problems" with what failed, changing nothing', async () => {
    const clean = await runSeed(payload, options, { seed: 'real-1', collections: ['users', 'groups'] })
    expect(clean.realism?.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)).toEqual([])
    await removeSeed(payload, options, { batch: clean.batch })

    const long = 'A long note about basking, feeding and the morning routine of this one.'
    const messy: SeedOptions = {
      ...options,
      recipes: {
        groups: {
          prepare: (data, ctx) => {
            const n = ctx.created('groups').length
            const titles = [long, `Lorem ipsum ${n}`, `Seed: group ${n}`, `Write to keeper${n}@mail.test`, `See https://realsite.test/${n}`]
            return { ...data, title: titles[n % titles.length] }
          },
        },
      },
    }
    const report = await runSeed(payload, messy, { seed: 'real-2', collections: ['users', 'groups'], counts: { groups: 20 } })
    const failed = Object.fromEntries(report.realism!.checks.filter((c) => !c.ok).map((c) => [c.name, c.examples?.length ?? 0]))
    expect(Object.keys(failed).sort()).toEqual(['Emails only on example domains', 'Links only on example domains', 'Long text not repeated', 'No placeholder text', 'No seed markers in visible text'])
    const batch = (await payload.findByID({ collection: 'sandbox-batches' as never, id: report.batch, depth: 0 })) as unknown as { status: string }
    expect(batch.status).toBe('done-with-problems')
    expect((await payload.count({ collection: 'groups', where: { sandboxBatch: { equals: report.batch } } })).totalDocs).toBe(20)
    await removeSeed(payload, options, { batch: report.batch })
  })

  it('checks that people’s names are distinct once there are enough of them', async () => {
    const same: SeedOptions = { ...options, recipes: { users: { prepare: (data) => ({ ...data, name: 'Pat Same' }) } } }
    const report = await runSeed(payload, same, { seed: 'real-4', collections: ['users'], counts: { users: 60 } })
    const check = report.realism!.checks.find((c) => c.name === 'People’s names distinct')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/of 6\d names are distinct/)
    await removeSeed(payload, options, { batch: report.batch })
  })

  it('checks select values against the coverage plan on what was really made', async () => {
    const plan = {
      collections: {
        animals: { generate: { small: 10, big: 100 }, fields: { sex: { values: { unknown: { small: 50, big: 50 } } } } },
      },
    }
    const report = await runSeed(payload, { ...options, coveragePlan: plan as never }, { seed: 'real-3', collections: ['animals'] })
    const check = report.realism!.checks.find((c) => c.name === 'Every select value at its minimum')!
    expect(check.ok).toBe(false)
    expect(check.examples!.join()).toMatch(/animals\.sex = unknown: \d+ of 50/)
    await removeSeed(payload, options, { batch: report.batch })
  })
})

describe('counts in recipes', () => {
  it('gives recipes the run’s counts, including kinds that aren’t collections', async () => {
    let seen: Record<string, number> | undefined
    const report = await runSeed(payload, { ...options, recipes: { groups: { after: async (ctx) => { seen = ctx.counts } } } }, { seed: 'counts-1', collections: ['groups'], counts: { groups: 12, 'kit-stories': 3 } })
    expect(seen).toEqual({ groups: 12, 'kit-stories': 3 })
    await removeSeed(payload, options, { batch: report.batch })
  })
})

describe('bulk removal', () => {
  it('removes a named collection in one go, only this batch’s marked records, skipping its delete hooks', async () => {
    const bulk: SeedOptions = { ...options, bulkRemove: ['ghosts'] }
    const keep = await runSeed(payload, options, { seed: 'bulk-keep', collections: ['ghosts'] })
    const report = await runSeed(payload, bulk, { seed: 'bulk-1', collections: ['ghosts'], counts: { ghosts: 30 } })
    const real = await payload.create({ collection: 'ghosts', data: { title: 'A real ghost' } })
    // One at a time, these can't be removed (their delete hook always refuses); in bulk they go.
    const result = await removeSeed(payload, bulk, { batch: report.batch })
    expect(result.removed).toBe(30)
    expect((await payload.count({ collection: 'ghosts', where: { sandboxBatch: { equals: report.batch } } as never })).totalDocs).toBe(0)
    // The other batch and the real record stay.
    expect((await payload.count({ collection: 'ghosts', where: { sandboxBatch: { equals: keep.batch } } as never })).totalDocs).toBeGreaterThan(0)
    expect((await payload.findByID({ collection: 'ghosts', id: real.id, depth: 0 })).id).toBe(real.id)
    await payload.db.deleteMany({ collection: 'ghosts', where: { id: { exists: true } } as never })
  })
})
