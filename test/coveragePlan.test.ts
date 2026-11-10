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
const config = { collections: [animals, groups, taxa, internal] }

const plan = (): CoveragePlan => ({
  collections: {
    animals: { generate: { small: 10, big: 100 }, fields: { name: 'fill', sex: { values: { unknown: { small: 0, big: 1 } } }, group: 'fill', taxon: 'fill', notes: { skip: 'Free text comes from Claude later' }, 'identifiers[].system': 'fill', 'identifiers[].value': 'fill', 'layout[].hero.title': 'fill' } },
    groups: { generate: { small: 2, big: 20 }, fields: { title: 'fill' } },
    taxa: { existing: 'Reference data, imported from its source' },
  },
})

describe('coverage plan', () => {
  it('passes a complete plan and leaves internal collections out', () => {
    const r = checkCoveragePlan(config, plan())
    expect(r.issues).toEqual([])
    expect(r).toMatchObject({ ok: true, generated: ['animals', 'groups'], existing: ['taxa'], skipped: [] })
  })

  it('fails on a new collection, a new field and a stale entry, and names each', () => {
    const p = plan()
    delete (p.collections.animals as { fields: Record<string, unknown> }).fields.notes
    p.collections.ghosts = { skip: 'gone' }
    const r = checkCoveragePlan({ collections: [...config.collections, { slug: 'kits', fields: [] }] }, p)
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
    expect(() => assertCoveragePlan(config, { collections: {} })).toThrow(/3 gaps:\n- “animals” has no plan/)
  })
})
