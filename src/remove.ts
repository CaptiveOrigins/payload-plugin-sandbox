import type { Payload } from 'payload'

import { creationOrder } from './graph.js'
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

type Removed = { removed: number; failed: { collection: string; id: string; message: string }[] }

async function remove(payload: Payload, options: SeedOptions, { batch, collection }: { batch?: string; collection?: string }): Promise<Removed> {
  const slugs = defaultSlugs(options)
  const where = { and: [...(batch ? [{ batch: { equals: batch } }] : []), ...(collection ? [{ collection: { equals: collection } }] : [])] }
  const records = (await payload.find({ collection: slugs.records as never, where: where as never, sort: '-order', pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { id: string; collection: string; docId: string }[]
  let removed = 0
  const failed: { collection: string; id: string; message: string }[] = []
  for (const r of records) {
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
  // Batches since 0.4.0 keep the batch id on each document: collections in reverse dependency
  // order, and newest first within one, so parents outlive their offspring until they go too.
  const internal = new Set([slugs.batches, slugs.records, 'payload-preferences', 'payload-migrations', 'payload-locked-documents', 'payload-jobs', 'payload-kv', 'payload-folders'])
  const models = payload.config.collections.filter((c) => !internal.has(c.slug) && c.fields.some((f) => 'name' in f && f.name === MARKER_BATCH)).map(readCollection)
  const { order } = creationOrder(models)
  const rest = models.map((m) => m.slug).filter((s) => !order.includes(s))
  for (const slug of [...order].reverse().concat(rest)) {
    if (collection && slug !== collection) continue
    const skip: string[] = []
    for (;;) {
      const where = { and: [{ [MARKER]: { equals: true } }, batch ? { [MARKER_BATCH]: { equals: batch } } : { [MARKER_BATCH]: { exists: true } }, ...(skip.length ? [{ id: { not_in: skip } }] : [])] }
      const { docs } = await payload.find({ collection: slug as never, where: where as never, sort: '-id', limit: 200, depth: 0, overrideAccess: true, select: {} as never })
      if (!docs.length) break
      for (const d of docs as unknown as { id: string }[]) {
        try {
          await payload.delete({ collection: slug as never, id: d.id, overrideAccess: true, context: { sandbox: { removing: true }, disableRevalidate: true } })
          removed++
        } catch (e) {
          const msg = (e as Error).message ?? String(e)
          if (!/not found/i.test(msg)) {
            failed.push({ collection: slug, id: String(d.id), message: msg })
            skip.push(String(d.id))
          }
        }
      }
    }
  }
  if (!collection) {
    const batches = (await payload.find({ collection: slugs.batches as never, where: (batch ? { id: { equals: batch } } : {}) as never, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { id: string }[]
    for (const b of batches) {
      const left = await payload.count({ collection: slugs.records as never, where: { batch: { equals: b.id } } as never, overrideAccess: true })
      if (!left.totalDocs && !failed.length) await payload.delete({ collection: slugs.batches as never, id: b.id, overrideAccess: true })
    }
  }
  return { removed, failed }
}
