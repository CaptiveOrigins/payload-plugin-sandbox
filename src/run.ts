import { randomBytes } from 'node:crypto'
import type { CollectionConfig, Payload } from 'payload'

import { pairCoverage, pairwise } from './coverage.js'
import { creationOrder, withDependencies } from './graph.js'
import { assertAllowed } from './guard.js'
import { buildDoc, dimensionsFor } from './plan.js'
import { placeholderPng } from './png.js'
import { random } from './random.js'
import { readCollection, type CollectionModel } from './schema.js'
import type { BatchReport, Failure, RecipeContext, SandboxOptions } from './types.js'

export const MARKER = 'sandbox'
export const defaultSlugs = (o: SandboxOptions) => ({ batches: o.slugs?.batches ?? 'sandbox-batches', records: o.slugs?.records ?? 'sandbox-records' })

/** Collections the sandbox may generate: everything except its own, excluded and recipe-skipped ones. */
export function generatable(collections: readonly CollectionConfig[], options: SandboxOptions): CollectionModel[] {
  const { batches, records } = defaultSlugs(options)
  const skip = new Set([batches, records, 'payload-preferences', 'payload-migrations', 'payload-locked-documents', 'payload-jobs', 'payload-kv', 'payload-folders', ...(options.exclude ?? [])])
  return collections.filter((c) => !skip.has(c.slug) && !options.recipes?.[c.slug]?.skip).map(readCollection)
}

const message = (e: unknown) => {
  const err = e as { message?: string; data?: { errors?: { path?: string; message?: string }[] } }
  const details = err.data?.errors?.map((x) => `${x.path}: ${x.message}`).join('; ')
  return details ? `${err.message} (${details})` : (err.message ?? String(e))
}

/**
 * Creates one sandbox batch: every selected collection (and what it depends on) in
 * dependency order, one document per pairwise coverage case, through Payload's Local
 * API (validation and hooks run). Every document is marked and registered for removal.
 */
export async function runSandbox(payload: Payload, options: SandboxOptions, { seed = String(Date.now()), collections, name }: { seed?: string; collections?: string[]; name?: string } = {}): Promise<BatchReport> {
  assertAllowed(payload, options)
  const slugs = defaultSlugs(options)
  const all = generatable(payload.config.collections, options)
  const selected = collections?.length ? withDependencies(all, collections) : all.map((m) => m.slug)
  const models = all.filter((m) => selected.includes(m.slug))
  const { order, deferred, cycles } = creationOrder(models)
  const rnd = random(seed)
  const batchDoc = await payload.create({ collection: slugs.batches as never, data: { name: name ?? `Sandbox ${new Date().toISOString().slice(0, 16)}`, seed, status: 'running', selection: selected } as never, overrideAccess: true })
  const batch = String(batchDoc.id)
  const pools = new Map<string, string[]>()
  const failures: Failure[] = []
  let serial = 0
  let position = 0
  const context = { sandbox: { batch }, disableRevalidate: true }
  const emailDomain = options.emailDomain ?? 'example.invalid'
  const configOf = (slug: string) => payload.config.collections.find((c) => c.slug === slug)

  const register = async (collection: string, id: string) => {
    pools.set(collection, [...(pools.get(collection) ?? []), id])
    await payload.create({ collection: slugs.records as never, data: { batch, collection, docId: id, order: position++ } as never, overrideAccess: true })
  }
  const create = async (collection: string, data: Record<string, unknown>, opts: { draft?: boolean } = {}): Promise<string | null> => {
    const cfg = configOf(collection)
    const body: Record<string, unknown> = { ...data, [MARKER]: true }
    if (cfg?.auth && !body.password) body.password = randomBytes(24).toString('base64url') // never usable: not stored anywhere
    let file: { data: Buffer; mimetype: string; name: string; size: number } | undefined
    if (cfg?.upload) {
      const mimeTypes = (typeof cfg.upload === 'object' ? cfg.upload.mimeTypes : undefined) ?? []
      const wantsImage = !mimeTypes.length || mimeTypes.some((m) => m.startsWith('image/') || m === '*/*')
      if (wantsImage) {
        const hue = (): [number, number, number] => [rnd.int(80, 240), rnd.int(80, 240), rnd.int(80, 240)]
        const png = placeholderPng(64, 48, hue(), hue())
        file = { data: png, mimetype: 'image/png', name: `sandbox-${serial++}.png`, size: png.length }
        if (!body.alt) body.alt = 'Sandbox placeholder image'
      } else {
        const text = Buffer.from(`Sandbox file ${serial++}\n`)
        file = { data: text, mimetype: mimeTypes.find((m) => m.startsWith('text/')) ?? 'text/plain', name: `sandbox-${serial}.txt`, size: text.length }
      }
    }
    try {
      const doc = await payload.create({ collection: collection as never, data: body as never, overrideAccess: true, context, ...(opts.draft ? { draft: true } : {}), ...(file ? { file } : {}) })
      await register(collection, String(doc.id))
      return String(doc.id)
    } catch (e) {
      failures.push({ collection, message: message(e) })
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
  const baseCtx = { payload, rnd, batch, created: (c: string) => pools.get(c) ?? [], create, update }
  const deferredPaths = new Set(deferred.map((d) => `${d.from}:${d.path}`))
  const reports: BatchReport['collections'] = []

  for (const slug of order) {
    const model = models.find((m) => m.slug === slug)!
    const recipe = options.recipes?.[slug]
    const crnd = rnd.fork(slug)
    const dims = recipe?.dimensions ? recipe.dimensions(dimensionsFor(model)) : dimensionsFor(model)
    const cases = pairwise(dims, crnd, { maxCases: recipe?.maxCases ?? 40 })
    const before = failures.length
    let created = 0
    for (const c of cases) {
      const ctx = {
        rnd: crnd,
        serial: () => ++serial,
        emailDomain,
        pick: (col: string) => {
          const pool = pools.get(col) ?? []
          return pool.length ? crnd.pick(pool) : null
        },
        pickMany: (col: string, n: number) => {
          const pool = [...(pools.get(col) ?? [])]
          const out: string[] = []
          while (pool.length && out.length < n) out.push(pool.splice(crnd.int(0, pool.length - 1), 1)[0]!)
          return out
        },
        defer: (path: string) => deferredPaths.has(`${slug}:${path}`),
      }
      let data: Record<string, unknown> | null = buildDoc(model, c, ctx)
      if (recipe?.prepare) data = await recipe.prepare(data, { ...baseCtx, rnd: crnd, case: c })
      if (!data) continue
      const n = failures.length
      const id = await create(slug, data, { draft: data._status === 'draft' })
      if (id) created++
      else failures[n] = { ...failures[n]!, case: c }
    }
    reports.push({ collection: slug, created, cases: cases.length, dimensions: dims.length, pairs: pairCoverage(dims, cases), failures: failures.length - before })
  }

  // Second pass: self-references and deferred links make shapes (multi-generation chains with gaps).
  for (const d of deferred) {
    const ids = pools.get(d.from) ?? []
    const targets = pools.get(d.to) ?? []
    if (!ids.length || !targets.length || d.path.includes('[]')) continue
    const hasMany = Boolean(models.find((m) => m.slug === d.from)?.fields.find((f) => f.path === d.path)?.hasMany)
    for (let i = 0; i < ids.length; i++) {
      if (i % 5 === 4) continue // a missing link every fifth record
      const value = d.from === d.to
        ? i === 0 ? null : hasMany ? [ids[Math.floor((i - 1) / 2)]!, ...(i > 2 ? [ids[Math.floor((i - 2) / 2)]!] : [])] : ids[Math.floor((i - 1) / 2)]! // a tree: several generations
        : hasMany ? [targets[i % targets.length]!] : targets[i % targets.length]!
      if (value === null) continue
      const [top, ...rest] = d.path.split('.')
      const data = rest.length ? { [top!]: { [rest.join('.')]: value } } : { [top!]: value }
      await update(d.from, ids[i]!, data)
    }
  }
  for (const slug of order) await options.recipes?.[slug]?.after?.(baseCtx as Omit<RecipeContext, 'case'>)

  const report: BatchReport = { batch, seed, order, collections: reports, failures, cycles }
  await payload.update({ collection: slugs.batches as never, id: batch, data: { status: failures.length ? 'done-with-failures' : 'done', report } as never, overrideAccess: true })
  return report
}
