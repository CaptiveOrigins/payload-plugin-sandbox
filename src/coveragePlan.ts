import type { CollectionConfig, GlobalConfig } from 'payload'

import { readCollection, type FieldModel } from './schema.js'

/** Least number of records (or of one select value) in each seed size. */
export type Minimum = { small: number; big: number }

/** What the seed does with one field: fill it, or leave it out for a stated reason. */
export type FieldPlan =
  | 'fill'
  | { skip: string }
  | {
      /** Per-value minimums for a select or radio field; values not named here get the plan's `selectMinimum`. */
      values?: Record<string, Minimum | { skip: string }>
    }

/**
 * What the seed does with one collection:
 * - `generate`: made by the seed, at least this many, with a plan for every field;
 * - `existing`: referred to, never generated (reference data, settings), with why;
 * - `skip`: neither generated nor referred to, with why.
 */
export type CollectionPlan = { generate: Minimum; fields: Record<string, FieldPlan> } | { existing: string } | { skip: string }

export type CoveragePlan = {
  /** Every value of a select or radio field the seed fills appears at least this often. Default 3 in big, 1 in small. */
  selectMinimum?: Minimum
  collections: Record<string, CollectionPlan>
  /** Every global: referred to as it is (`existing`), or left alone (`skip`), with why. The seed never writes globals. */
  globals?: Record<string, { existing: string } | { skip: string }>
}

export type CoverageIssue = {
  code:
    | 'collection-unplanned'
    | 'collection-unknown'
    | 'field-unplanned'
    | 'field-unknown'
    | 'value-unknown'
    | 'reason-missing'
    | 'relation-unplanned'
    | 'required-skipped'
    | 'minimum-unreachable'
    | 'global-unplanned'
    | 'global-unknown'
  collection: string
  path?: string
  message: string
}

export type CoverageReport = { ok: boolean; issues: CoverageIssue[]; generated: string[]; existing: string[]; skipped: string[]; globals: string[] }

/** Payload's own collections, and the seed's, are never part of a plan. */
const INTERNAL = /^(payload-|sandbox-|seed-)/

const DEFAULT_MINIMUM: Minimum = { small: 1, big: 3 }

/** Every planned path: groups and arrays are planned through their leaves, blocks per block (`layout[].hero.title`). */
function leaves(fields: FieldModel[]): FieldModel[] {
  return fields.flatMap((f) => (f.type === 'group' || f.type === 'array' ? leaves(f.fields ?? []) : f.type === 'blocks' ? (f.blocks ?? []).flatMap((b) => leaves(b.fields).map((l) => ({ ...l, path: l.path.replace(`${f.path}[].`, `${f.path}[].${b.slug}.`) }))) : [f]))
}

const hasReason = (v: { skip?: unknown; existing?: unknown }) => typeof (v.skip ?? v.existing) === 'string' && String(v.skip ?? v.existing).trim().length > 0

/**
 * Checks a seed plan against the schema, offline (no database, no key): every collection is
 * generated, referred to or skipped with a reason; every field of a generated collection is
 * filled or skipped with a reason; every select value has a minimum; every relationship the
 * seed fills points at something the plan generates or refers to. Anything in the plan the
 * schema no longer has is reported too, so the plan can't go stale quietly.
 */
type SchemaConfig = { collections?: CollectionConfig[]; globals?: GlobalConfig[] }

export function checkCoveragePlan(config: SchemaConfig, plan: CoveragePlan): CoverageReport {
  const issues: CoverageIssue[] = []
  const collections = (config.collections ?? []).filter((c) => !INTERNAL.test(c.slug))
  const slugs = new Set(collections.map((c) => c.slug))
  const report: CoverageReport = { ok: true, issues, generated: [], existing: [], skipped: [], globals: [] }

  for (const slug of Object.keys(plan.collections))
    if (!slugs.has(slug)) issues.push({ code: 'collection-unknown', collection: slug, message: `The plan names “${slug}”, which isn't in the schema any more.` })

  for (const c of collections) {
    const entry = plan.collections[c.slug]
    if (!entry) {
      issues.push({ code: 'collection-unplanned', collection: c.slug, message: `“${c.slug}” has no plan: generate it, mark it existing, or skip it with a reason.` })
      continue
    }
    if (!('generate' in entry)) {
      if (!hasReason(entry)) issues.push({ code: 'reason-missing', collection: c.slug, message: `“${c.slug}” is ${'skip' in entry ? 'skipped' : 'marked existing'} without a reason.` })
      ;('skip' in entry ? report.skipped : report.existing).push(c.slug)
      continue
    }
    report.generated.push(c.slug)
    const fields = leaves(readCollection(c).fields)
    const paths = new Set(fields.map((f) => f.path))
    for (const path of Object.keys(entry.fields))
      if (!paths.has(path)) issues.push({ code: 'field-unknown', collection: c.slug, path, message: `The plan for “${c.slug}” names “${path}”, which isn't in the schema any more.` })
    for (const f of fields) {
      const fp = entry.fields[f.path]
      if (fp === undefined) {
        issues.push({ code: 'field-unplanned', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” has no plan: fill it or skip it with a reason.` })
        continue
      }
      if (typeof fp === 'object' && 'skip' in fp) {
        if (!hasReason(fp)) issues.push({ code: 'reason-missing', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” is skipped without a reason.` })
        else if (f.required) issues.push({ code: 'required-skipped', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” is required, so it can't be skipped.` })
        continue
      }
      // Per-value minimums must fit in the records made: one value per record, so their sum can't exceed the count.
      // hasMany fields and fields inside arrays hold several values per record, so they're exempt.
      if (f.options?.length && !f.hasMany && !f.path.includes('[]')) {
        const values = typeof fp === 'object' ? fp.values : undefined
        for (const size of ['small', 'big'] as const) {
          const need = f.options.reduce((sum, v) => {
            const rule = values?.[v]
            return sum + (rule ? ('skip' in rule ? 0 : rule[size]) : (plan.selectMinimum ?? DEFAULT_MINIMUM)[size])
          }, 0)
          if (need > entry.generate[size]) issues.push({ code: 'minimum-unreachable', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” needs ${need} records in ${size} for its values' minimums, but the plan makes ${entry.generate[size]}.` })
        }
      }
      if (typeof fp === 'object' && fp.values) {
        const options = new Set(f.options ?? [])
        for (const [value, rule] of Object.entries(fp.values)) {
          if (!options.has(value)) issues.push({ code: 'value-unknown', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” has no option “${value}” any more.` })
          else if ('skip' in rule && !hasReason(rule)) issues.push({ code: 'reason-missing', collection: c.slug, path: `${f.path}=${value}`, message: `Value “${value}” of “${c.slug}.${f.path}” is skipped without a reason.` })
        }
      }
      for (const to of [f.relationTo ?? []].flat()) {
        const target = plan.collections[to]
        if (INTERNAL.test(to) || (target && !('skip' in target))) continue
        issues.push({ code: 'relation-unplanned', collection: c.slug, path: f.path, message: `“${c.slug}.${f.path}” points at “${to}”, which the plan ${target ? 'skips' : "doesn't cover"}: generate it, mark it existing, or skip this field.` })
      }
    }
  }
  const globals = config.globals ?? []
  const globalSlugs = new Set(globals.map((g) => g.slug))
  for (const slug of Object.keys(plan.globals ?? {}))
    if (!globalSlugs.has(slug)) issues.push({ code: 'global-unknown', collection: slug, message: `The plan names global “${slug}”, which isn't in the schema any more.` })
  for (const g of globals) {
    const entry = plan.globals?.[g.slug]
    if (!entry) issues.push({ code: 'global-unplanned', collection: g.slug, message: `Global “${g.slug}” has no plan: mark it existing or skip it, with a reason.` })
    else if (!hasReason(entry)) issues.push({ code: 'reason-missing', collection: g.slug, message: `Global “${g.slug}” has no reason.` })
    else report.globals.push(g.slug)
  }
  report.ok = issues.length === 0
  return report
}

/** The minimum each value of a filled select or radio field must reach, for the realism audit and the generator. */
export function selectMinimums(config: SchemaConfig, plan: CoveragePlan, size: keyof Minimum): { collection: string; path: string; value: string; minimum: number }[] {
  const out: { collection: string; path: string; value: string; minimum: number }[] = []
  const fallback = (plan.selectMinimum ?? DEFAULT_MINIMUM)[size]
  for (const c of config.collections ?? []) {
    const entry = plan.collections[c.slug]
    if (!entry || !('generate' in entry)) continue
    for (const f of leaves(readCollection(c).fields)) {
      const fp = entry.fields[f.path]
      if (!f.options || fp === undefined || (typeof fp === 'object' && 'skip' in fp)) continue
      const values = typeof fp === 'object' ? fp.values : undefined
      for (const value of f.options) {
        const rule = values?.[value]
        if (rule && 'skip' in rule) continue
        out.push({ collection: c.slug, path: f.path, value, minimum: rule ? rule[size] : fallback })
      }
    }
  }
  return out
}

/**
 * A first plan to review and edit: every collection generated, every field filled. Nothing in it
 * is a decision; it saves typing the paths. Write it to a file, then mark what's existing or skipped.
 */
export function draftCoveragePlan(config: SchemaConfig): CoveragePlan {
  const collections: CoveragePlan['collections'] = {}
  for (const c of config.collections ?? []) {
    if (INTERNAL.test(c.slug)) continue
    const fields = leaves(readCollection(c).fields)
    // Enough records for every value's minimum on the widest single-value select.
    const widest = Math.max(1, ...fields.filter((f) => f.options?.length && !f.hasMany && !f.path.includes('[]')).map((f) => f.options!.length))
    collections[c.slug] = { generate: { small: widest * DEFAULT_MINIMUM.small, big: widest * DEFAULT_MINIMUM.big }, fields: Object.fromEntries(fields.map((f) => [f.path, 'fill' as const])) }
  }
  const globals = Object.fromEntries((config.globals ?? []).map((g) => [g.slug, { existing: 'TODO: say why' }]))
  return { selectMinimum: DEFAULT_MINIMUM, collections, ...(config.globals?.length ? { globals } : {}) }
}

/** For a site's test suite: throws with every gap listed, one per line. */
export function assertCoveragePlan(config: SchemaConfig, plan: CoveragePlan): void {
  const { ok, issues } = checkCoveragePlan(config, plan)
  if (!ok) throw new Error(`Seed coverage plan has ${issues.length} gap${issues.length === 1 ? '' : 's'}:\n${issues.map((i) => `- ${i.message}`).join('\n')}`)
}
