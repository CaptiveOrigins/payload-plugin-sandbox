import type { Payload } from 'payload'

import { defaultSlugs } from './run.js'
import type { SandboxOptions } from './types.js'

/**
 * Removes sandbox documents (all, one batch, or one collection of a batch) in reverse
 * creation order, so nothing is left pointing at a deleted document. Only documents in
 * the register are touched; real data never is. Removing runs anywhere (also where
 * generating is refused), so stray sandbox data can always be cleaned up.
 */
export const removeSandbox = (payload: Payload, options: SandboxOptions, input: { batch?: string; collection?: string } = {}): Promise<Removed> => (options.around ?? ((task) => task()))(() => remove(payload, options, input))

type Removed = { removed: number; failed: { collection: string; id: string; message: string }[] }

async function remove(payload: Payload, options: SandboxOptions, { batch, collection }: { batch?: string; collection?: string }): Promise<Removed> {
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
  if (!collection) {
    const batches = (await payload.find({ collection: slugs.batches as never, where: (batch ? { id: { equals: batch } } : {}) as never, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { id: string }[]
    for (const b of batches) {
      const left = await payload.count({ collection: slugs.records as never, where: { batch: { equals: b.id } } as never, overrideAccess: true })
      if (!left.totalDocs) await payload.delete({ collection: slugs.batches as never, id: b.id, overrideAccess: true })
    }
  }
  return { removed, failed }
}
