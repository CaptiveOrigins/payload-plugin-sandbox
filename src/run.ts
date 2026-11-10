import { randomBytes } from 'node:crypto'
import type { CollectionConfig, Payload } from 'payload'

import { pairCoverage, pairwise } from './coverage.js'
import { creationOrder, withDependencies } from './graph.js'
import { assertAllowed, markerSlug, SeedRefused } from './guard.js'
import { buildDoc, dimensionsFor } from './plan.js'
import { applySamples } from './plans.js'
import { placeholderPng } from './png.js'
import { random } from './random.js'
import { readCollection, type CollectionModel, type FieldModel } from './schema.js'
import { readSettings, settingsProblems, settingsSlug } from './settings.js'
import { measureCluster, planCounts, type SizePlan } from './sizing.js'
import { lexical } from './values.js'
import type { BatchReport, Failure, Persona, PersonaReport, RecipeContext, SeedOptions, SeedPlan, TextEstimate, TextJob, TextSource } from './types.js'

export const MARKER = 'sandbox'
/** The batch a seeded document belongs to, kept on the document itself (0.4.0): no register document per record. */
export const MARKER_BATCH = 'sandboxBatch'
export const defaultSlugs = (o: SeedOptions) => ({ batches: o.slugs?.batches ?? 'sandbox-batches', records: o.slugs?.records ?? 'sandbox-records' })

/** Collections the sandbox may generate: everything except its own, excluded and recipe-skipped ones. */
export function generatable(collections: readonly CollectionConfig[], options: SeedOptions): CollectionModel[] {
  const { batches, records } = defaultSlugs(options)
  const skip = new Set([batches, records, markerSlug(options), settingsSlug(options), 'payload-preferences', 'payload-migrations', 'payload-locked-documents', 'payload-jobs', 'payload-kv', 'payload-folders', ...(options.exclude ?? []), ...Object.keys(options.existing ?? {})])
  return collections.filter((c) => !skip.has(c.slug) && !options.recipes?.[c.slug]?.skip && (!options.only || options.only.includes(c.slug))).map(readCollection)
}

const message = (e: unknown) => {
  const err = e as { message?: string; data?: { errors?: { path?: string; message?: string }[] } }
  const details = err.data?.errors?.map((x) => `${x.path}: ${x.message}`).join('; ')
  return details ? `${err.message} (${details})` : (err.message ?? String(e))
}

/**
 * Creates one seed batch: every selected collection (and what it depends on) in dependency
 * order, through Payload's Local API (validation and hooks run). Small: one document per
 * pairwise coverage case. Big: the coverage cases, then more records up to the counts in the
 * settings, auto-sized to fit the cluster. Every document is marked with its batch.
 */
export const runSeed = (payload: Payload, options: SeedOptions, input: RunInput = {}): Promise<BatchReport> => (options.around ?? ((task) => task()))(() => run(payload, options, input))

export type RunInput = {
  seed?: string
  collections?: string[]
  name?: string
  plan?: SeedPlan
  /** A batch already created (a reviewed plan waiting to run). */
  batch?: string
  /** small (default): coverage cases only. big: counts from the settings, sized to the cluster. */
  size?: 'small' | 'big'
  /**
   * Exact counts per collection, instead of the settings (still at least the coverage cases). Not
   * sized to the cluster: for tests and code that already checked with `planSize`. Big runs from the
   * admin always size.
   */
  counts?: Record<string, number>
  /** Carry on with an interrupted batch: what it already made is kept and counted. */
  resume?: string
  /** Writes the text people read (Claude, or anything else); without it, word lists. */
  texts?: TextSource
  /** The amount a person confirmed for writing text, when the estimate is above the settings' "ask above". */
  confirmSpendUSD?: number
  /** Internal: stop after the text estimate (see `estimateRun`). */
  estimateOnly?: boolean
}

export type RunEstimate = TextEstimate & { records: number; askAboveUSD: number; capUSD: number }

class EstimateOnly extends Error {
  constructor(public estimate: RunEstimate) {
    super('estimate only')
  }
}

/**
 * What a run's text would cost, before anything is written or spent: sizes the counts, describes
 * every record, and asks the text source for its estimate. Null when there's no text to write.
 */
export async function estimateRun(payload: Payload, options: SeedOptions, input: RunInput = {}): Promise<RunEstimate | null> {
  try {
    await run(payload, options, { ...input, estimateOnly: true })
    return null
  } catch (e) {
    if (e instanceof EstimateOnly) return e.estimate
    throw e
  }
}

const PROGRESS_EVERY = 500

/** A big seed's text could cost more than the settings' "ask above" amount: the run needs `confirmSpendUSD` of at least `worstUSD`. */
export class SpendNeedsConfirmation extends SeedRefused {
  constructor(
    public worstUSD: number,
    public expectedUSD: number,
  ) {
    super(`Writing the text could cost up to $${worstUSD.toFixed(2)} (about $${expectedUSD.toFixed(2)} expected). Confirm that amount to run.`)
    this.name = 'SpendNeedsConfirmation'
  }
}

/** Free-text fields worth writing well: text, textarea and rich text that aren't slugs, emails, links or unique. */
export function writableText(fields: FieldModel[]): FieldModel[] {
  return fields.flatMap((f) => (f.type === 'group' ? writableText(f.fields ?? []) : (f.type === 'text' || f.type === 'textarea' || f.type === 'richText') && !f.unique && !f.hasMany && !/slug|email|url|link|href|password|token|code$|key$|phone|postal|zip|colou?r/i.test(f.name) ? [f] : []))
}

/** What a record is, in words, from the values code chose: Claude writes to fit it. Never ids, never real data. */
function describe(model: CollectionModel, doc: Record<string, unknown>): string {
  const parts: string[] = []
  const walk = (fields: FieldModel[], at: Record<string, unknown> | undefined) => {
    for (const f of fields) {
      const v = at?.[f.name]
      if (v === undefined || v === null) continue
      if (f.type === 'group') walk(f.fields ?? [], v as Record<string, unknown>)
      else if (f.type === 'select' || f.type === 'radio') parts.push(`${f.path}: ${[v].flat().join(', ')}`)
      else if (f.type === 'checkbox') parts.push(`${f.path}: ${v ? 'yes' : 'no'}`)
      else if (f.type === 'number') parts.push(`${f.path}: ${v}`)
      else if (f.type === 'date') parts.push(`${f.path}: ${String(v).slice(0, 10)}`)
      else if ((f.type === 'relationship' || f.type === 'upload') && !f.hasMany) parts.push(`has a ${[f.relationTo].flat()[0]}`)
    }
  }
  walk(model.fields, doc)
  if (doc._status) parts.push(`status: ${doc._status}`)
  return `${model.slug}; ${parts.join('; ')}`.slice(0, 600)
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let at = doc
  for (const p of parts.slice(0, -1)) {
    if (!at[p] || typeof at[p] !== 'object') return
    at[p] = { ...(at[p] as object) }
    at = at[p] as Record<string, unknown>
  }
  const last = parts[parts.length - 1]!
  if (at[last] === undefined || at[last] === null) return // code chose to leave it empty
  at[last] = value
}

/** How many of each collection a big seed makes, from the settings and the cluster as it is now. */
export async function planSize(payload: Payload, options: SeedOptions): Promise<SizePlan> {
  const settings = await readSettings(payload, options)
  const problems = settingsProblems(settings)
  if (problems.length) throw new SeedRefused(`The seed settings need fixing: ${problems.join(' ')}`)
  if (!Object.keys(settings.counts).length) throw new SeedRefused('A big seed needs counts in the seed settings.')
  let usedBytes: number
  try {
    usedBytes = (await measureCluster(payload, { databases: settings.databases })).usedBytes
  } catch (e) {
    throw new SeedRefused(`Refusing a big seed: the cluster couldn’t be measured (${(e as Error).message}).`)
  }
  return planCounts({ rules: settings.counts, bytesPerRecord: settings.bytesPerRecord, indirectFactor: settings.indirectFactor, usedBytes, limitBytes: settings.limitMB * 1024 * 1024, targetShare: settings.targetShare, hardCap: settings.hardCap })
}

async function run(payload: Payload, options: SeedOptions, input: RunInput): Promise<BatchReport> {
  await assertAllowed(payload, options)
  const slugs = defaultSlugs(options)
  const resumed = input.resume ? ((await payload.findByID({ collection: slugs.batches as never, id: input.resume, depth: 0, overrideAccess: true })) as unknown as { id: string; seed?: string; selection?: string[]; report?: { progress?: Progress; sizing?: SizePlan; counts?: Record<string, number> } }) : null
  if (resumed && !['running', 'failed'].includes(String((resumed as { status?: string }).status))) throw new SeedRefused('Only a batch that was interrupted can carry on.')
  const progress: Progress = resumed?.report?.progress ?? { done: [], made: {} }
  const seed = resumed?.seed ?? input.seed ?? String(Date.now())
  const { collections, name, plan } = input

  // Counts first: a big seed that doesn't fit refuses before anything is written.
  let sizing: SizePlan | undefined = resumed?.report?.sizing
  let counts: Record<string, number> = resumed?.report?.counts ?? input.counts ?? {}
  if (!resumed && !input.counts && input.size === 'big') {
    sizing = await planSize(payload, options)
    if (!sizing.ok) throw new SeedRefused(`Refusing a big seed: ${sizing.refused}`)
    counts = sizing.counts
  }
  // Carrying on a sized batch: the cluster may have grown since it started, so check again that the
  // rest still fits under the hard cap (what's already made is in the measurement).
  if (resumed && sizing) {
    const settings = await readSettings(payload, options)
    let usedBytes: number
    try {
      usedBytes = (await measureCluster(payload, { databases: settings.databases })).usedBytes
    } catch (e) {
      throw new SeedRefused(`Refusing to carry on: the cluster couldn’t be measured (${(e as Error).message}).`)
    }
    const made = resumed.report?.progress?.made ?? {}
    const remaining = Object.entries(counts).reduce((n, [slug, target]) => n + Math.max(0, target - (made[slug] ?? 0)) * (settings.bytesPerRecord[slug] ?? 0) * settings.indirectFactor, 0)
    const projected = (usedBytes + remaining) / (settings.limitMB * 1024 * 1024)
    if (!(projected <= settings.hardCap)) throw new SeedRefused(`Refusing to carry on: the rest would take the cluster to ${(projected * 100).toFixed(1)}%, above the hard cap of ${(settings.hardCap * 100).toFixed(1)}%.`)
  }

  const all = generatable(payload.config.collections, options)
  const chosen = resumed?.selection ?? (collections?.length ? collections : plan?.collections.map((c) => c.slug))
  const selected = chosen?.length ? withDependencies(all, chosen) : all.map((m) => m.slug)
  const models = all.filter((m) => selected.includes(m.slug))
  const { order, deferred, cycles } = creationOrder(models)
  const rnd = random(seed)
  const pools = new Map<string, string[]>()
  for (const [collection, query] of Object.entries(options.existing ?? {})) {
    const { docs } = await payload.find({ collection: collection as never, where: query.where, limit: query.limit ?? 50, depth: 0, overrideAccess: true })
    pools.set(collection, (docs as unknown as { id: string }[]).map((d) => String(d.id)))
  }
  let serial = 0
  /** Makes unique values (emails, slugs) unique across batches as well as within one; set once the batch exists. */
  let tag = resumed ? String(resumed.id).slice(-5).toLowerCase() : ''
  const emailDomain = options.emailDomain ?? 'example.invalid'
  const deferredPaths = new Set(deferred.map((d) => `${d.from}:${d.path}`))
  // On resume: what the batch already made is in the pools, and counted.
  if (resumed)
    for (const slug of order) {
      const { docs } = await payload.find({ collection: slug as never, where: { [MARKER_BATCH]: { equals: resumed.id } } as never, sort: 'createdAt', pagination: false, depth: 0, overrideAccess: true, draft: true, select: {} as never })
      if (docs.length) pools.set(slug, (docs as unknown as { id: unknown }[]).map((d) => String(d.id)))
    }

  // Each document gets its own random stream, and links their own, so a document's values don't
  // depend on what exists yet: the text pass and the real pass build the same document.
  type Spec = { model: CollectionModel; c: Record<string, string>; index: number }
  const ctxFor = (slug: string, index: number, real: boolean) => {
    const drnd = rnd.fork(`${slug}:${index}`)
    const lrnd = drnd.fork('links')
    return {
      rnd: drnd,
      serial: () => `${tag}${++serial}`,
      emailDomain,
      pick: (col: string) => {
        if (!real) return 'x'
        const pool = pools.get(col) ?? []
        return pool.length ? lrnd.pick(pool) : null
      },
      pickMany: (col: string, n: number) => {
        if (!real) return Array.from({ length: n }, () => 'x')
        const pool = [...(pools.get(col) ?? [])]
        const out: string[] = []
        while (pool.length && out.length < n) out.push(pool.splice(lrnd.int(0, pool.length - 1), 1)[0]!)
        return out
      },
      defer: (path: string) => deferredPaths.has(`${slug}:${path}`),
    }
  }
  const casesOf = new Map<string, { cases: Record<string, string>[]; dims: ReturnType<typeof dimensionsFor>; target: number }>()
  for (const slug of order) {
    const model = models.find((m) => m.slug === slug)!
    const recipe = options.recipes?.[slug]
    const dims = recipe?.dimensions ? recipe.dimensions(dimensionsFor(model)) : dimensionsFor(model)
    const cases = pairwise(dims, rnd.fork(slug), { maxCases: recipe?.maxCases ?? 40 })
    casesOf.set(slug, { cases, dims, target: Math.max(cases.length, Math.floor(counts[slug] ?? 0)) })
  }
  const specs = (slug: string): Spec[] => {
    const model = models.find((m) => m.slug === slug)!
    const { cases, target } = casesOf.get(slug)!
    return Array.from({ length: target }, (_, index) => ({ model, c: cases[index] ?? {}, index }))
  }
  const settings = await readSettings(payload, options)
  const textSource = input.texts ?? (input.size === 'big' || resumed ? options.texts : undefined)
  const languageOf = (slug: string, index: number) => {
    const langs = settings.languages.length ? settings.languages : [{ code: 'en', share: 1 }]
    let x = rnd.fork(`${slug}:${index}:lang`).next()
    for (const l of langs) if ((x -= l.share) < 0) return l.code
    return langs[langs.length - 1]!.code
  }

  // Text pass: describe every document code will make, and have the text written in one go.
  let texts = new Map<string, Record<string, string>>()
  const textStats = { requested: 0, written: 0 }
  let textReport: Record<string, unknown> | undefined
  if (textSource) {
    const jobs: TextJob[] = []
    for (const slug of order) {
      if (progress.done.includes(slug)) continue
      const already = pools.get(slug)?.length ?? 0
      for (const { model, c, index } of specs(slug)) {
        if (index < already) continue
        const fieldsToWrite = writableText(model.fields).filter((f) => c[f.path] !== 'edge')
        if (!fieldsToWrite.length) continue
        const doc = buildDoc(model, c, ctxFor(slug, index, false))
        const wanted = fieldsToWrite.filter((f) => getPath(doc, f.path) !== undefined)
        if (!wanted.length) continue
        jobs.push({ key: `${slug}:${index}`, collection: slug, language: languageOf(slug, index), describe: describe(model, doc), fields: wanted.map((f) => ({ path: f.path, type: f.type as TextJob['fields'][number]['type'], ...(f.maxLength ? { maxLength: f.maxLength } : {}) })) })
      }
    }
    textStats.requested = jobs.length
    if (jobs.length) {
      const settingsForText = { models: settings.models, spend: settings.spend }
      const estimate = await textSource.estimate?.(jobs, settingsForText)
      if (input.estimateOnly) throw new EstimateOnly({ ...(estimate ?? { requests: 0, worstUSD: 0, expectedUSD: 0, cached: 0 }), records: jobs.length, askAboveUSD: settings.spend.askAboveUSD, capUSD: settings.spend.capUSD })
      if (estimate && estimate.worstUSD > settings.spend.askAboveUSD && !((input.confirmSpendUSD ?? 0) >= estimate.worstUSD))
        throw new SpendNeedsConfirmation(estimate.worstUSD, estimate.expectedUSD)
      const out = await textSource(jobs, { seed, settings: settingsForText })
      texts = out instanceof Map ? out : out.texts
      textReport = out instanceof Map ? undefined : out.report
      textStats.written = texts.size
    }
  }

  if (input.estimateOnly) return null as never
  const fields = { seed, status: 'running', selection: selected, ...(plan ? { plan } : {}) }
  const batch = resumed
    ? String(resumed.id)
    : input.batch
      ? String(((await payload.update({ collection: slugs.batches as never, id: input.batch, data: fields as never, overrideAccess: true })) as unknown as { id: string }).id)
      : String(((await payload.create({ collection: slugs.batches as never, data: { name: name ?? `Seed ${new Date().toISOString().slice(0, 16)}`, ...fields } as never, overrideAccess: true })) as unknown as { id: string }).id)
  if (resumed) await payload.update({ collection: slugs.batches as never, id: batch, data: { status: 'running' } as never, overrideAccess: true })
  tag = batch.slice(-5).toLowerCase()
  const failures: Failure[] = []
  let position = 0
  const context = { sandbox: { batch }, disableRevalidate: true }
  const configOf = (slug: string) => payload.config.collections.find((c) => c.slug === slug)
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 4))
  const saveProgress = (extra: Record<string, unknown> = {}) => payload.update({ collection: slugs.batches as never, id: batch, data: { report: { order, progress, sizing, counts, ...extra } } as never, overrideAccess: true })

  const useRecords = options.register === 'records'
  const register = async (collection: string, id: string) => {
    pools.set(collection, [...(pools.get(collection) ?? []), id])
    if (useRecords) await payload.create({ collection: slugs.records as never, data: { batch, collection, docId: id, order: position++ } as never, overrideAccess: true })
  }
  /** Adopts a document a recipe made itself (already marked) into this batch, so removing the batch removes it. */
  const track = async (collection: string, id: string) => {
    await register(collection, id)
    if (!useRecords) await payload.update({ collection: collection as never, id, data: { [MARKER_BATCH]: batch } as never, overrideAccess: true, context })
  }
  const create = async (collection: string, data: Record<string, unknown>, opts: { draft?: boolean; case?: Record<string, string> } = {}): Promise<string | null> => {
    const cfg = configOf(collection)
    const body: Record<string, unknown> = { ...data, [MARKER]: true, ...(useRecords ? {} : { [MARKER_BATCH]: batch }) }
    if (cfg?.auth && !body.password) body.password = randomBytes(24).toString('base64url') // never usable: not stored anywhere
    let file: { data: Buffer; mimetype: string; name: string; size: number } | undefined
    if (cfg?.upload) {
      const n = ++serial
      const mimeTypes = (typeof cfg.upload === 'object' ? cfg.upload.mimeTypes : undefined) ?? []
      const wantsImage = !mimeTypes.length || mimeTypes.some((m) => m.startsWith('image/') || m === '*/*')
      if (wantsImage) {
        const frnd = rnd.fork(`file:${n}`)
        const hue = (): [number, number, number] => [frnd.int(80, 240), frnd.int(80, 240), frnd.int(80, 240)]
        const png = placeholderPng(64, 48, hue(), hue())
        file = { data: png, mimetype: 'image/png', name: `seed-${n}.png`, size: png.length }
        if (!body.alt) body.alt = 'Seed placeholder image'
      } else {
        const text = Buffer.from(`Seed file ${n}\n`)
        file = { data: text, mimetype: mimeTypes.find((m) => m.startsWith('text/')) ?? 'text/plain', name: `seed-${n}.txt`, size: text.length }
      }
    }
    try {
      const doc = await payload.create({ collection: collection as never, data: body as never, overrideAccess: true, context, ...(opts.draft ? { draft: true } : {}), ...(file ? { file } : {}) })
      await register(collection, String(doc.id))
      return String(doc.id)
    } catch (e) {
      failures.push({ collection, ...(opts.case ? { case: opts.case } : {}), message: message(e) })
      return null
    }
  }
  const update = async (collection: string, id: string, data: Record<string, unknown>) => {
    try {
      await payload.update({ collection: collection as never, id, data: data as never, overrideAccess: true, context })
    } catch (e) {
      failures.push({ collection, message: `update: ${message(e)}` })
    }
  }
  const baseCtx = { payload, rnd, batch, created: (c: string) => pools.get(c) ?? [], create, update, track }
  const reports: BatchReport['collections'] = []
  const personasDone: PersonaReport[] = []
  const planned = plan?.personas ?? options.personas ?? []

  for (const slug of order) {
    const model = models.find((m) => m.slug === slug)!
    const recipe = options.recipes?.[slug]
    const { cases, dims } = casesOf.get(slug)!
    const samples = plan?.collections.find((c) => c.slug === slug)?.samples
    const before = failures.length
    let created = 0
    const already = pools.get(slug)?.length ?? 0
    const all = specs(slug)
    const crnd = rnd.fork(slug)
    if (!progress.done.includes(slug)) {
      // The people to sign in as come first, so other records can belong to them.
      if (!already)
        for (const persona of model.auth ? planned.filter((p: Persona) => p.collection === slug) : []) {
          const email = `${persona.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'persona'}.${tag}${++serial}@${emailDomain}`
          let data: Record<string, unknown> | null = { ...buildDoc(model, {}, ctxFor(slug, -1 - personasDone.length, true)), name: persona.name, ...(persona.data ?? {}), email }
          if (recipe?.prepare) data = await recipe.prepare(data, { ...baseCtx, rnd: crnd, case: {}, persona })
          if (!data) continue
          const id = await create(slug, data)
          if (id) {
            created++
            personasDone.push({ ...persona, id, email: String(data.email ?? email) })
          }
        }
      const one = async ({ c, index }: Spec) => {
        const ctx = ctxFor(slug, index, true)
        let data: Record<string, unknown> | null = applySamples(buildDoc(model, c, ctx), samples, (v) => ctx.rnd.pick(v), (path) => c[path])
        const written = texts.get(`${slug}:${index}`)
        if (written) for (const [path, value] of Object.entries(written)) setPath(data, path, writableText(model.fields).find((f) => f.path === path)?.type === 'richText' ? lexical(value) : value)
        if (recipe?.prepare) data = await recipe.prepare(data, { ...baseCtx, rnd: ctx.rnd, case: c })
        if (!data) return
        if (await create(slug, data, { draft: data._status === 'draft', case: c })) created++
      }
      const todo = all.slice(already)
      // Coverage cases one by one (recipes may read what exists so far); the bulk after them in parallel chunks.
      const coverage = todo.filter((s) => s.index < cases.length)
      for (const s of coverage) await one(s)
      const bulk = todo.filter((s) => s.index >= cases.length)
      for (let i = 0; i < bulk.length; i += concurrency) {
        await Promise.all(bulk.slice(i, i + concurrency).map(one))
        if ((i / concurrency) % Math.ceil(PROGRESS_EVERY / concurrency) === 0) {
          progress.made[slug] = already + created
          await saveProgress()
        }
      }
      progress.done.push(slug)
      progress.made[slug] = already + created
      await saveProgress()
    }
    reports.push({ collection: slug, created, cases: cases.length + (model.auth ? planned.filter((p: Persona) => p.collection === slug).length : 0), dimensions: dims.length, pairs: pairCoverage(dims, cases), failures: failures.length - before, total: pools.get(slug)?.length ?? 0 })
  }

  // Second pass: self-references and deferred links make shapes (multi-generation chains with gaps).
  if (!progress.done.includes(':links')) {
    for (const d of deferred) {
      const ids = pools.get(d.from) ?? []
      const targets = pools.get(d.to) ?? []
      if (!ids.length || !targets.length || d.path.includes('[]') || options.recipes?.[d.from]?.noLinks?.includes(d.path)) continue
      const hasMany = Boolean(models.find((m) => m.slug === d.from)?.fields.find((f) => f.path === d.path)?.hasMany)
      const jobs: (() => Promise<void>)[] = []
      for (let i = 0; i < ids.length; i++) {
        if (i % 5 === 4) continue // a missing link every fifth record
        const value = d.from === d.to
          ? i === 0 ? null : hasMany ? [ids[Math.floor((i - 1) / 2)]!, ...(i > 2 ? [ids[Math.floor((i - 2) / 2)]!] : [])] : ids[Math.floor((i - 1) / 2)]! // a tree: several generations
          : hasMany ? [targets[i % targets.length]!] : targets[i % targets.length]!
        if (value === null) continue
        const [top, ...rest] = d.path.split('.')
        const data = rest.length ? { [top!]: { [rest.join('.')]: value } } : { [top!]: value }
        jobs.push(() => update(d.from, ids[i]!, data))
      }
      for (let i = 0; i < jobs.length; i += concurrency) await Promise.all(jobs.slice(i, i + concurrency).map((j) => j()))
    }
    progress.done.push(':links')
    await saveProgress()
  }
  if (!progress.done.includes(':after')) {
    for (const slug of order) await options.recipes?.[slug]?.after?.(baseCtx as Omit<RecipeContext, 'case'>)
    progress.done.push(':after')
  }

  const report: BatchReport = { batch, seed, order, personas: personasDone, collections: reports, failures, cycles, ...(sizing ? { sizing } : {}), ...(Object.keys(counts).length ? { counts } : {}), ...(textSource ? { texts: { ...textReport, ...textStats } } : {}), progress }
  await payload.update({ collection: slugs.batches as never, id: batch, data: { status: failures.length ? 'done-with-failures' : 'done', report } as never, overrideAccess: true })
  return report
}

type Progress = { done: string[]; made: Record<string, number> }

function getPath(doc: Record<string, unknown>, path: string): unknown {
  let at: unknown = doc
  for (const p of path.split('.')) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[p] : undefined
  return at
}
