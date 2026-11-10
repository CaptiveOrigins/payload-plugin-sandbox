import type { Payload } from 'payload'

import { creationOrder } from './graph.js'
import { markerSlug } from './guard.js'
import { defaultSlugs, MARKER, MARKER_BATCH } from './run.js'
import { readCollection } from './schema.js'
import type { SeedOptions } from './types.js'

/**
 * Removes seeded documents (all, one batch, or one collection of a batch) in reverse
 * creation order, so nothing is left pointing at a deleted document. Only documents that
 * carry the seed marker and a batch (or are in the older register) are touched; real data
 * never is. Removing runs anywhere (also where
 * generating is refused), so stray sandbox data can always be cleaned up.
 */
export const removeSeed = (payload: Payload, options: SeedOptions, input: { batch?: string; collection?: string } = {}): Promise<Removed> => (options.around ?? ((task) => task()))(() => remove(payload, options, input))

type Removed = {
  removed: number
  failed: { collection: string; id: string; message: string }[]
  kept: { collection: string; id: string }[]
  /** Register rows pointing at a document without the seed's marker: never deleted, rows left for a person to look at. */
  notSeeded: { collection: string; id: string }[]
}

async function remove(payload: Payload, options: SeedOptions, { batch, collection }: { batch?: string; collection?: string }): Promise<Removed> {
  const slugs = defaultSlugs(options)
  const where = { and: [...(batch ? [{ batch: { equals: batch } }] : []), ...(collection ? [{ collection: { equals: collection } }] : [])] }
  const records = (await payload.find({ collection: slugs.records as never, where: where as never, sort: '-order', pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { id: string; collection: string; docId: string }[]
  let removed = 0
  const failed: { collection: string; id: string; message: string }[] = []
  const kept: { collection: string; id: string }[] = []
  const notSeeded: { collection: string; id: string }[] = []
  // Documents the site keeps whatever happens (`keep`): never deleted, even when marked; reported as kept.
  const keepCache = new Map<string, Set<string>>()
  const isKept = async (slug: string, id: string) => {
    const where = options.keep?.[slug]
    if (!where) return false
    if (!keepCache.has(slug)) keepCache.set(slug, new Set(((await payload.find({ collection: slug as never, where: where as never, pagination: false, depth: 0, overrideAccess: true, select: {} as never })).docs as unknown as { id: unknown }[]).map((d) => String(d.id))))
    if (!keepCache.get(slug)!.has(String(id))) return false
    kept.push({ collection: slug, id: String(id) })
    return true
  }
  for (const r of records) {
    if (await isKept(r.collection, r.docId)) continue
    // The register is the seed's own, but a stale or bad row must never delete a real document:
    // only a document that still carries the seed's marker goes. One that's gone drops its row.
    // draft: a seeded document that only exists as a draft is still seeded. A read that fails is not
    // "gone": the row stays (reported as failed), so the document never loses its link to the batch.
    let doc: Record<string, unknown> | null
    try {
      doc = ((await payload.find({ collection: r.collection as never, where: { id: { equals: r.docId } } as never, limit: 1, depth: 0, overrideAccess: true, draft: true, select: { [MARKER]: true } as never })).docs[0] as unknown as Record<string, unknown> | undefined) ?? null
    } catch (e) {
      failed.push({ collection: r.collection, id: r.docId, message: `couldn’t check it’s seeded: ${(e as Error).message ?? String(e)}` })
      continue
    }
    if (doc && doc[MARKER] !== true) {
      notSeeded.push({ collection: r.collection, id: r.docId })
      continue
    }
    if (!doc) {
      await payload.delete({ collection: slugs.records as never, id: r.id, overrideAccess: true })
      continue
    }
    try {
      await payload.delete({ collection: r.collection as never, id: r.docId, overrideAccess: true, context: { sandbox: { removing: true }, disableRevalidate: true } })
      removed++
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      // Already gone (e.g. deleted by a cascade): fine.
      if (!/not found/i.test(msg)) {
        failed.push({ collection: r.collection, id: r.docId, message: msg })
        continue
      }
    }
    await payload.delete({ collection: slugs.records as never, id: r.id, overrideAccess: true })
  }
  // Batches since 0.3.0 keep the batch id on each document: collections in reverse dependency
  // order, and newest first within one, so parents outlive their offspring until they go too.
  const internal = new Set([slugs.batches, slugs.records, markerSlug(options), 'payload-preferences', 'payload-migrations', 'payload-locked-documents', 'payload-jobs', 'payload-kv', 'payload-folders'])
  const models = payload.config.collections.filter((c) => !internal.has(c.slug) && c.fields.some((f) => 'name' in f && f.name === MARKER_BATCH)).map(readCollection)
  // The order the batches really created collections in, reversed: a site's hooks may need what was
  // made first (a group) while removing what came after (a weight that updates its animal). The
  // schema's own order is the fallback for collections a batch didn't record.
  const batchDocs = (await payload.find({ collection: slugs.batches as never, where: (batch ? { id: { equals: batch } } : {}) as never, pagination: false, depth: 0, overrideAccess: true, sort: 'createdAt' })).docs as unknown as { report?: { order?: string[] } }[]
  for (const slug of removalOrder(batchDocs.map((b) => b.report?.order ?? []), creationOrder(models).order, models.map((m) => m.slug))) {
    if (collection && slug !== collection) continue
    // Collections the site names as safe to remove in bulk (no delete hooks it relies on): one deleteMany,
    // still only records carrying the marker and this batch. Never where the site keeps some of them.
    // (Never for a collection with versions: the plugin refuses that at start-up, and this checks again.)
    if (options.bulkRemove?.includes(slug) && !options.keep?.[slug] && !payload.config.collections.find((c) => c.slug === slug)?.versions) {
      const where = { and: [{ [MARKER]: { equals: true } }, batch ? { [MARKER_BATCH]: { equals: batch } } : { [MARKER_BATCH]: { exists: true } }] }
      const { totalDocs } = await payload.count({ collection: slug as never, where: where as never, overrideAccess: true })
      if (totalDocs) {
        await payload.db.deleteMany({ collection: slug, where: where as never })
        removed += totalDocs
      }
      continue
    }
    const skip: string[] = []
    for (;;) {
      const where = { and: [{ [MARKER]: { equals: true } }, batch ? { [MARKER_BATCH]: { equals: batch } } : { [MARKER_BATCH]: { exists: true } }, ...(skip.length ? [{ id: { not_in: skip } }] : [])] }
      const { docs } = await payload.find({ collection: slug as never, where: where as never, sort: '-id', limit: 200, depth: 0, overrideAccess: true, select: {} as never })
      if (!docs.length) break
      for (const d of docs as unknown as { id: string }[]) {
        // A deleted document can't come back. Anything else (kept, failed, or "not found" while find still
        // returns it: a stale copy, a hiding hook) is skipped from then on, so the loop always ends and the
        // skip list stays small.
        if (await isKept(slug, String(d.id))) {
          skip.push(String(d.id))
          continue
        }
        try {
          await payload.delete({ collection: slug as never, id: d.id, overrideAccess: true, context: { sandbox: { removing: true }, disableRevalidate: true } })
          removed++
        } catch (e) {
          skip.push(String(d.id))
          const msg = (e as Error).message ?? String(e)
          if (!/not found/i.test(msg)) failed.push({ collection: slug, id: String(d.id), message: msg })
        }
      }
    }
  }
  if (!collection) {
    const batches = (await payload.find({ collection: slugs.batches as never, where: (batch ? { id: { equals: batch } } : {}) as never, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { id: string }[]
    for (const b of batches) {
      const left = await payload.count({ collection: slugs.records as never, where: { batch: { equals: b.id } } as never, overrideAccess: true })
      if (!left.totalDocs && !failed.length && !kept.length && !notSeeded.length) await payload.delete({ collection: slugs.batches as never, id: b.id, overrideAccess: true })
    }
  }
  return { removed, failed, kept, notSeeded }
}

/**
 * Collections in the order to remove them: the reverse of the order the batches really created them
 * in (oldest batch's order first), then the schema's order for collections no batch recorded, then
 * the rest. Pure; exported for tests.
 */
export function removalOrder(recordedOrders: string[][], schemaOrder: string[], all: string[]): string[] {
  const recorded: string[] = []
  for (const order of recordedOrders) for (const slug of order) if (!recorded.includes(slug) && all.includes(slug)) recorded.push(slug)
  const order = [...recorded, ...schemaOrder.filter((s) => !recorded.includes(s))]
  return [...order].reverse().concat(all.filter((s) => !order.includes(s)))
}
