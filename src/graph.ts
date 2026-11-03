import { relationTargets, type CollectionModel } from './schema.js'

/**
 * Creation order: a collection comes after the collections its relationships point
 * to. Required relationships must be satisfied first; optional ones are preferred
 * but may be broken to resolve cycles (filled in a second pass). Self-references
 * are always second-pass (they make shapes: chains, trees, missing links).
 */
export function creationOrder(models: CollectionModel[]): { order: string[]; deferred: { from: string; to: string; path: string }[]; cycles: string[][] } {
  const slugs = new Set(models.map((m) => m.slug))
  const deps = new Map<string, { to: string; required: boolean; path: string }[]>()
  for (const m of models) deps.set(m.slug, relationTargets(m).filter((r) => slugs.has(r.to) && r.to !== m.slug))
  const order: string[] = []
  const deferred: { from: string; to: string; path: string }[] = []
  const cycles: string[][] = []
  const done = new Set<string>()
  const remaining = new Set(slugs)
  while (remaining.size) {
    // Ready: every dependency done (or optional ones allowed to wait).
    const ready = [...remaining].filter((s) => deps.get(s)!.every((d) => done.has(d.to)))
    if (ready.length) {
      for (const s of ready.sort()) {
        order.push(s)
        done.add(s)
        remaining.delete(s)
      }
      continue
    }
    const softReady = [...remaining].filter((s) => deps.get(s)!.every((d) => done.has(d.to) || !d.required)).sort()
    if (softReady.length) {
      const s = softReady[0]!
      for (const d of deps.get(s)!) if (!done.has(d.to)) deferred.push({ from: s, to: d.to, path: d.path })
      order.push(s)
      done.add(s)
      remaining.delete(s)
      continue
    }
    // Required cycle: report it and take the alphabetically first (the recipe must handle it).
    const cycle = [...remaining].sort()
    cycles.push(cycle)
    const s = cycle[0]!
    for (const d of deps.get(s)!) if (!done.has(d.to)) deferred.push({ from: s, to: d.to, path: d.path })
    order.push(s)
    done.add(s)
    remaining.delete(s)
  }
  for (const m of models) for (const r of relationTargets(m)) if (r.to === m.slug) deferred.push({ from: m.slug, to: m.slug, path: r.path })
  return { order, deferred, cycles }
}

/** The collections a selection needs (its relationship targets, transitively, required ones only). */
export function withDependencies(models: CollectionModel[], selected: string[]): string[] {
  const bySlug = new Map(models.map((m) => [m.slug, m]))
  const out = new Set<string>()
  const stack = [...selected]
  while (stack.length) {
    const s = stack.pop()!
    if (out.has(s) || !bySlug.has(s)) continue
    out.add(s)
    for (const r of relationTargets(bySlug.get(s)!)) if (r.required && r.to !== s) stack.push(r.to)
  }
  return [...out]
}
