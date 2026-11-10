import type { CollectionConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { assertCoveragePlan, checkCoveragePlan, draftCoveragePlan, selectMinimums, type CoveragePlan } from '../src/index.js'

const animals: CollectionConfig = {
  slug: 'animals',
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'sex', type: 'select', options: ['female', 'male', 'unknown'] },
    { name: 'group', type: 'relationship', relationTo: 'groups', required: true },
    { name: 'taxon', type: 'relationship', relationTo: 'taxa' },
    { name: 'notes', type: 'textarea' },
    { name: 'identifiers', type: 'array', fields: [{ name: 'system', type: 'text' }, { name: 'value', type: 'text', required: true }] },
    { name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [{ name: 'title', type: 'text' }] }] },
  ],
}
const groups: CollectionConfig = { slug: 'groups', fields: [{ name: 'title', type: 'text', required: true }] }
const taxa: CollectionConfig = { slug: 'taxa', fields: [{ name: 'name', type: 'text' }] }
const internal: CollectionConfig = { slug: 'payload-preferences', fields: [{ name: 'key', type: 'text' }] }
const config = { collections: [animals, groups, taxa, internal], globals: [{ slug: 'settings', fields: [] }] }

const plan = (): CoveragePlan => ({
  collections: {
    animals: { generate: { small: 10, big: 100 }, fields: { name: 'fill', sex: { values: { unknown: { small: 0, big: 1 } } }, group: 'fill', taxon: 'fill', notes: { skip: 'Free text comes from Claude later' }, 'identifiers[].system': 'fill', 'identifiers[].value': 'fill', 'layout[].hero.title': 'fill' } },
    groups: { generate: { small: 2, big: 20 }, fields: { title: 'fill' } },
    taxa: { existing: 'Reference data, imported from its source' },
  },
  globals: { settings: { existing: 'Copied from production' } },
})

describe('coverage plan', () => {
  it('passes a complete plan and leaves internal collections out', () => {
    const r = checkCoveragePlan(config, plan())
    expect(r.issues).toEqual([])
    expect(r).toMatchObject({ ok: true, generated: ['animals', 'groups'], existing: ['taxa'], skipped: [], globals: ['settings'] })
  })

  it('fails on a new collection, a new field and a stale entry, and names each', () => {
    const p = plan()
    delete (p.collections.animals as { fields: Record<string, unknown> }).fields.notes
    p.collections.ghosts = { skip: 'gone' }
    const r = checkCoveragePlan({ ...config, collections: [...config.collections, { slug: 'kits', fields: [] }] }, p)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => [i.code, i.collection, i.path])).toEqual([
      ['collection-unknown', 'ghosts', undefined],
      ['field-unplanned', 'animals', 'notes'],
      ['collection-unplanned', 'kits', undefined],
    ])
  })

  it('refuses skips without a reason, a skipped required field, unknown select values and relations to nothing', () => {
    const p = plan()
    const fields = (p.collections.animals as { fields: Record<string, unknown> }).fields
    fields.name = { skip: 'not needed' }
    fields.notes = { skip: '  ' }
    fields.sex = { values: { hermaphrodite: { small: 1, big: 1 } } }
    p.collections.taxa = { skip: 'Not needed' }
    p.collections.groups = { existing: '' }
    expect(checkCoveragePlan(config, p).issues.map((i) => i.code).sort()).toEqual(['reason-missing', 'reason-missing', 'relation-unplanned', 'required-skipped', 'value-unknown'])
  })

  it('gives every filled select value its minimum, with overrides and skips', () => {
    expect(selectMinimums(config, plan(), 'big')).toEqual([
      { collection: 'animals', path: 'sex', value: 'female', minimum: 3 },
      { collection: 'animals', path: 'sex', value: 'male', minimum: 3 },
      { collection: 'animals', path: 'sex', value: 'unknown', minimum: 1 },
    ])
    const p = { ...plan(), selectMinimum: { small: 2, big: 5 } }
    expect(selectMinimums(config, p, 'small').map((m) => m.minimum)).toEqual([2, 2, 0])
  })

  it('drafts a plan that passes, for review', () => {
    const draft = draftCoveragePlan(config)
    expect(Object.keys(draft.collections)).toEqual(['animals', 'groups', 'taxa'])
    expect(checkCoveragePlan(config, draft).ok).toBe(true)
  })

  it('throws with every gap listed', () => {
    expect(() => assertCoveragePlan(config, { collections: {} })).toThrow(/4 gaps:\n- “animals” has no plan/)
  })

  it('checks globals: a new one, a stale one and one without a reason', () => {
    const p = plan()
    p.globals = { ghost: { skip: 'gone' } }
    expect(checkCoveragePlan(config, p).issues.map((i) => [i.code, i.collection])).toEqual([['global-unknown', 'ghost'], ['global-unplanned', 'settings']])
    p.globals = { settings: { existing: '' } }
    expect(checkCoveragePlan(config, p).issues.map((i) => i.code)).toEqual(['reason-missing'])
  })

  it('refuses minimums the planned count can never reach, except for fields holding several values', () => {
    const p = plan()
    p.collections.animals = { ...(p.collections.animals as { generate: { small: number; big: number }; fields: Record<string, never> }), generate: { small: 1, big: 4 } }
    // sex: female 3 + male 3 + unknown 1 (override) = 7 in big, 1 + 1 + 0 = 2 in small
    expect(checkCoveragePlan(config, p).issues.map((i) => [i.code, i.path, i.message.match(/needs (\d+)/)![1]])).toEqual([
      ['minimum-unreachable', 'sex', '2'],
      ['minimum-unreachable', 'sex', '7'],
    ])
    const many: CollectionConfig = { slug: 'tags', fields: [{ name: 'labels', type: 'select', hasMany: true, options: ['a', 'b', 'c', 'd'] }] }
    const q: CoveragePlan = { collections: { tags: { generate: { small: 1, big: 1 }, fields: { labels: 'fill' } } } }
    expect(checkCoveragePlan({ collections: [many] }, q).ok).toBe(true)
  })
})
