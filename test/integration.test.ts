import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { removeSeed, runSeed, seedPlugin, type SeedOptions } from '../src/index.js'

/** A real Payload on a throwaway MongoDB database (MONGODB_URL, default the local test container). */
const BASE = process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27018/?directConnection=true'
const dbName = `sandbox_test_${Date.now().toString(36)}`
const url = BASE.replace(/\/(\?|$)/, `/${dbName}$1`)

const users: CollectionConfig = { slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }, { name: 'roles', type: 'select', hasMany: true, options: ['admin', 'keeper', 'member'] }] }
const media: CollectionConfig = { slug: 'media', upload: { mimeTypes: ['image/*'] }, fields: [{ name: 'alt', type: 'text', required: true }] }
const groups: CollectionConfig = { slug: 'groups', fields: [{ name: 'title', type: 'text', required: true }, { name: 'owner', type: 'relationship', relationTo: 'users', required: true }] }
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
      collections: [users, media, groups, animals],
      plugins: [seedPlugin(options)],
      typescript: { autoGenerate: false },
      upload: {},
    }),
  })
})

afterAll(async () => {
  await (payload?.db as unknown as { connection?: { dropDatabase: () => Promise<void> } })?.connection?.dropDatabase()
  await payload?.destroy?.()
})

describe('a real sandbox run', () => {
  it('creates every collection in order with full pair coverage, marks and registers every document', async () => {
    const report = await runSeed(payload, options, { seed: 'test-1' })
    expect(report.order).toEqual(['media', 'users', 'groups', 'animals'])
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
    expect(report.personas![0]!.email).toMatch(/^site\.persona\.\d+@example\.invalid$/)
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
