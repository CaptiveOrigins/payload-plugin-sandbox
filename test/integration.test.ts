import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { removeSandbox, runSandbox, sandboxPlugin, type SandboxOptions } from '../src'

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
const options: SandboxOptions = {
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
      plugins: [sandboxPlugin(options)],
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
    const report = await runSandbox(payload, options, { seed: 'test-1' })
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
    const user = (await payload.find({ collection: 'users', limit: 1 })).docs[0] as { email: string }
    expect(user.email).toMatch(/@example\.invalid$/)
  })

  it('removes everything it created, and nothing else', async () => {
    const real = await payload.create({ collection: 'users', data: { email: 'real@example.com', password: 'a-real-password-1' } })
    const result = await removeSandbox(payload, options)
    expect(result.failed).toEqual([])
    for (const c of ['animals', 'groups', 'media', 'sandbox-records', 'sandbox-batches'] as const) expect((await payload.count({ collection: c as never })).totalDocs).toBe(0)
    expect((await payload.find({ collection: 'users' })).docs.map((d) => d.id)).toEqual([real.id])
  })

  it('refuses to run where it is not allowed', async () => {
    await expect(runSandbox(payload, { ...options, allow: () => false })).rejects.toThrow(/not allowed/)
  })
})
