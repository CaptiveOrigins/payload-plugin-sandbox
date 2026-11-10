import type { Payload } from 'payload'

/** How many records of one kind to make: never more than `ceiling`, never fewer than `minimum`. Bulk kinds shrink first. */
export type CountRule = { ceiling: number; minimum: number; bulk?: boolean }

export type SizeInput = {
  rules: Record<string, CountRule>
  /**
   * Bytes one record of each kind adds, as the host measures it (documents plus their indexes).
   * Kinds without a figure count as 0, so give every kind one.
   */
  bytesPerRecord: Record<string, number>
  /**
   * Multiplies every projection, for what records cause besides themselves (versions, audit
   * entries, search records). From `calibrate()` after a measured load. Default 1.
   */
  indirectFactor?: number
  /** What the cluster holds now, every database on it, before this load. */
  usedBytes: number
  /** The host's enforced limit (MongoDB Atlas M0: 512 MiB). */
  limitBytes: number
  /** Fill up to this share of the limit (default 0.8). */
  targetShare?: number
  /** Never project above this share, whatever the target says (default 0.95). */
  hardCap?: number
}

export type SizePlan = {
  ok: boolean
  /** Records to make per kind (empty when refused). */
  counts: Record<string, number>
  /** Which step decided the counts. */
  fit: 'ceilings' | 'bulk-shrunk' | 'headline-shrunk' | 'refused'
  usedBytes: number
  limitBytes: number
  targetShare: number
  projectedBytes: number
  projectedShare: number
  /** Why it refused, in words a person can act on. */
  refused?: string
}

const MIB = 1024 * 1024
const mib = (b: number) => `${(b / MIB).toFixed(0)} MB`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/**
 * How many records fit. The configured counts are ceilings: when they don't fit under
 * `targetShare` of the limit, bulk kinds shrink first, in proportion between their minimum and
 * ceiling; headline kinds shrink only after every bulk kind is at its minimum. If even the
 * minimums don't fit, it refuses (and loads nothing). Fails closed on bad input.
 */
export function planCounts(input: SizeInput): SizePlan {
  const target = input.targetShare ?? 0.8
  const hardCap = input.hardCap ?? 0.95
  const factor = input.indirectFactor ?? 1
  const base = { usedBytes: input.usedBytes, limitBytes: input.limitBytes, targetShare: target }
  const refuse = (refused: string): SizePlan => ({ ok: false, counts: {}, fit: 'refused', ...base, projectedBytes: input.usedBytes, projectedShare: input.usedBytes / input.limitBytes, refused })

  if (!(input.limitBytes > 0) || !(input.usedBytes >= 0)) return refuse('The cluster’s size or limit couldn’t be measured.')
  if (!(target > 0 && target <= hardCap && hardCap < 1)) return refuse(`The target share (${pct(target)}) must be above 0 and at most the hard cap (${pct(hardCap)}).`)
  if (!(factor >= 1)) return refuse('The indirect factor must be at least 1: records never take less room than themselves.')
  for (const [kind, r] of Object.entries(input.rules)) {
    if (!(r.minimum >= 0 && r.ceiling >= r.minimum)) return refuse(`“${kind}”: the minimum (${r.minimum}) must be between 0 and the ceiling (${r.ceiling}).`)
    if (!(input.bytesPerRecord[kind]! > 0)) return refuse(`“${kind}” has no measured size per record.`)
  }

  const room = target * input.limitBytes - input.usedBytes
  const kinds = Object.entries(input.rules)
  const cost = (counts: Record<string, number>) => kinds.reduce((sum, [k]) => sum + (counts[k] ?? 0) * input.bytesPerRecord[k]! * factor, 0)
  const at = (pick: (r: CountRule, bulk: boolean) => number) => Object.fromEntries(kinds.map(([k, r]) => [k, Math.floor(pick(r, Boolean(r.bulk)))]))
  const done = (counts: Record<string, number>, fit: SizePlan['fit']): SizePlan => {
    const projectedBytes = input.usedBytes + cost(counts)
    const projectedShare = projectedBytes / input.limitBytes
    if (projectedShare > hardCap) return refuse(`The load would take the cluster to ${pct(projectedShare)}, above the hard cap of ${pct(hardCap)}.`)
    return { ok: true, counts, fit, ...base, projectedBytes, projectedShare }
  }

  const ceilings = at((r) => r.ceiling)
  if (cost(ceilings) <= room) return done(ceilings, 'ceilings')

  // Shrink one tier between its minimums and ceilings, by a share s in [0, 1] that just fits.
  const shrink = (tier: (bulk: boolean) => boolean, others: (r: CountRule) => number) => {
    const fixed = cost(at((r, bulk) => (tier(bulk) ? r.minimum : others(r))))
    const span = cost(at((r, bulk) => (tier(bulk) ? r.ceiling - r.minimum : 0)))
    const s = span > 0 ? Math.min(1, (room - fixed) / span) : room >= fixed ? 1 : -1
    return s >= 0 ? at((r, bulk) => (tier(bulk) ? r.minimum + s * (r.ceiling - r.minimum) : others(r))) : null
  }
  const bulkShrunk = shrink((bulk) => bulk, (r) => r.ceiling)
  if (bulkShrunk) return done(bulkShrunk, 'bulk-shrunk')
  const headlineShrunk = shrink((bulk) => !bulk, (r) => r.minimum)
  if (headlineShrunk) return done(headlineShrunk, 'headline-shrunk')
  const minimums = at((r) => r.minimum)
  return refuse(`Even the minimums need ${mib(cost(minimums))}, and there’s ${mib(Math.max(0, room))} left under ${pct(target)} of the ${mib(input.limitBytes)} limit (${mib(input.usedBytes)} used).`)
}

/**
 * The indirect factor from a measured load: what the cluster actually grew by, over what the
 * per-record figures predicted for the records made. Never below 1.
 */
export function calibrate({ bytesPerRecord, counts, growthBytes }: { bytesPerRecord: Record<string, number>; counts: Record<string, number>; growthBytes: number }): number {
  const predicted = Object.entries(counts).reduce((sum, [k, n]) => sum + n * (bytesPerRecord[k] ?? 0), 0)
  if (!(predicted > 0) || !(growthBytes > 0)) return 1
  return Math.max(1, growthBytes / predicted)
}

export type SizeStatus = { usedBytes: number; limitBytes: number; share: number; level: 'ok' | 'warn' | 'alert'; message: string }

/** For a daily check: ok below `warnAt` (default 0.9), warn below `alertAt` (default 0.96), alert at or above. */
export function sizeStatus(usedBytes: number, limitBytes: number, { warnAt = 0.9, alertAt = 0.96 } = {}): SizeStatus {
  const share = usedBytes / limitBytes
  const level = !(limitBytes > 0) || share >= alertAt ? 'alert' : share >= warnAt ? 'warn' : 'ok'
  return { usedBytes, limitBytes, share, level, message: limitBytes > 0 ? `${mib(usedBytes)} of ${mib(limitBytes)} (${pct(share)})` : 'The limit is unknown.' }
}

type Db = { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> }
type MongoLike = { connection?: { getClient?: () => { db: (name: string) => Db }; db?: Db; name?: string } }

/**
 * What the cluster holds, measured the way MongoDB Atlas enforces its free-tier limit: uncompressed
 * document data plus index bytes, summed over the named databases (default: the current one).
 * Name every database on the cluster. Throws if any can't be measured: an unknown size is never 0.
 */
export async function measureCluster(payload: Payload, { databases }: { databases?: string[] } = {}): Promise<{ usedBytes: number; byDatabase: Record<string, { dataBytes: number; indexBytes: number }> }> {
  const conn = (payload.db as unknown as MongoLike).connection
  if (!conn?.getClient || !conn.name) throw new Error('Measuring needs the MongoDB adapter.')
  const client = conn.getClient()
  const names = databases?.length ? databases : [conn.name]
  const byDatabase: Record<string, { dataBytes: number; indexBytes: number }> = {}
  let usedBytes = 0
  for (const name of names) {
    const stats = await client.db(name).command({ dbStats: 1, scale: 1 })
    const dataBytes = Number(stats.dataSize)
    const indexBytes = Number(stats.indexSize)
    if (!Number.isFinite(dataBytes) || !Number.isFinite(indexBytes)) throw new Error(`Database “${name}” couldn’t be measured.`)
    byDatabase[name] = { dataBytes, indexBytes }
    usedBytes += dataBytes + indexBytes
  }
  return { usedBytes, byDatabase }
}
