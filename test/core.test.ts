import type { CollectionConfig, Config, Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { assertAllowed, buildDoc, creationOrder, databaseName, dimensionsFor, pairCoverage, pairwise, random, readCollection, seedPlugin, withDependencies } from '../src/index.js'

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
  it('refuses without allow(), and on databases that look like production', () => {
    expect(() => assertAllowed(payloadWith('mongodb://h/test'), {})).toThrow(/not allowed/)
    expect(() => assertAllowed(payloadWith('mongodb://h/test'), { allow: () => true })).not.toThrow()
    expect(() => assertAllowed(payloadWith('mongodb+srv://u:p@h/prod?x=1'), { allow: () => true })).toThrow(/production/)
    expect(() => assertAllowed(payloadWith('mongodb+srv://u:p@h/myapp-production'), { allow: () => true, allowDatabases: ['myapp-production'] })).not.toThrow()
    expect(databaseName(payloadWith('postgres://u:p@h:5432/shop_prod'))).toBe('shop_prod')
  })

  it('adds the marker to every collection and hides its admin where not allowed', async () => {
    const config = (await seedPlugin({ allow: () => false })({ collections: [animals, groups, users] } as never)) as Config
    const slugs = config.collections!.map((c) => c.slug)
    expect(slugs).toEqual(['animals', 'groups', 'users', 'sandbox-batches', 'sandbox-records'])
    for (const c of config.collections!.slice(0, 3)) expect(c.fields.some((f) => 'name' in f && f.name === 'sandbox')).toBe(true)
    expect(config.collections!.find((c) => c.slug === 'sandbox-batches')!.admin!.hidden).toBe(true)
  })
})

describe('renamed from payload-plugin-sandbox (0.3.0)', () => {
  it('drops the old export names in 0.4.0, as 0.3.0 announced', async () => {
    const m = (await import('../src/index.js')) as Record<string, unknown>
    for (const old of ['sandboxPlugin', 'runSandbox', 'removeSandbox', 'SandboxRefused']) expect(m[old]).toBeUndefined()
    expect(typeof m.seedPlugin).toBe('function')
  })
})
