/**
 * Pairwise coverage: a small set of cases where every pair of values of every two
 * dimensions appears together at least once (bugs mostly come from one setting or
 * two interacting). Greedy, deterministic for a given random source.
 */
import type { Random } from './random.js'

export type Dimension = { key: string; values: readonly string[] }
export type Case = Record<string, string>

export function pairwise(dimensions: Dimension[], rnd: Random, { maxCases = 200 }: { maxCases?: number } = {}): Case[] {
  const dims = dimensions.filter((d) => d.values.length > 0)
  if (!dims.length) return [{}]
  if (dims.length === 1) return dims[0]!.values.map((v) => ({ [dims[0]!.key]: v }))
  const uncovered = new Set<string>()
  const pairKey = (i: number, a: string, j: number, b: string) => `${i}=${a}|${j}=${b}`
  for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++) for (const a of dims[i]!.values) for (const b of dims[j]!.values) uncovered.add(pairKey(i, a, j, b))
  const cases: Case[] = []
  while (uncovered.size && cases.length < maxCases) {
    // Seed the case with one uncovered pair, then fill the rest greedily.
    const first = [...uncovered][Math.floor(rnd.next() * Math.min(uncovered.size, 8))]!
    const [[i, a], [j, b]] = first.split('|').map((p) => p.split('=') as [string, string]).map(([d, v]) => [Number(d), v] as const) as [[number, string], [number, string]]
    const values: (string | undefined)[] = dims.map(() => undefined)
    values[i] = a
    values[j] = b
    const order = dims.map((_, k) => k).filter((k) => values[k] === undefined).sort(() => rnd.next() - 0.5)
    for (const k of order) {
      let best = dims[k]!.values[0]!
      let bestScore = -1
      for (const v of dims[k]!.values) {
        let score = 0
        for (let m = 0; m < dims.length; m++) {
          if (m === k || values[m] === undefined) continue
          const key = m < k ? pairKey(m, values[m]!, k, v) : pairKey(k, v, m, values[m]!)
          if (uncovered.has(key)) score++
        }
        if (score > bestScore || (score === bestScore && rnd.chance(0.5))) {
          best = v
          bestScore = score
        }
      }
      values[k] = best
    }
    for (let p = 0; p < dims.length; p++) for (let q = p + 1; q < dims.length; q++) uncovered.delete(pairKey(p, values[p]!, q, values[q]!))
    cases.push(Object.fromEntries(dims.map((d, k) => [d.key, values[k]!])))
  }
  return cases
}

/** How many of all value pairs a set of cases covers (for the coverage report). */
export function pairCoverage(dimensions: Dimension[], cases: Case[]): { covered: number; total: number } {
  const dims = dimensions.filter((d) => d.values.length > 0)
  let total = 0
  let covered = 0
  for (let i = 0; i < dims.length; i++)
    for (let j = i + 1; j < dims.length; j++)
      for (const a of dims[i]!.values)
        for (const b of dims[j]!.values) {
          total++
          if (cases.some((c) => c[dims[i]!.key] === a && c[dims[j]!.key] === b)) covered++
        }
  return { covered, total }
}
