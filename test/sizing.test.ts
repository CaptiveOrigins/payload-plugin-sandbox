import { describe, expect, it } from 'vitest'

import { calibrate, planCounts, sizeStatus, type CountRule } from '../src/index.js'

const MIB = 1024 * 1024
const LIMIT = 512 * MIB
// Figures measured for the reference site (bytes per record, documents plus indexes).
const bytesPerRecord = { accounts: 1331, animals: 1945, measurements: 614, notifications: 481 }
const rules: Record<string, CountRule> = {
  accounts: { ceiling: 2000, minimum: 60 },
  animals: { ceiling: 20000, minimum: 200 },
  measurements: { ceiling: 22000, minimum: 100, bulk: true },
  notifications: { ceiling: 8000, minimum: 50, bulk: true },
}
const at = (share: number, extra: Partial<Parameters<typeof planCounts>[0]> = {}) => planCounts({ rules, bytesPerRecord, usedBytes: share * LIMIT, limitBytes: LIMIT, ...extra })

const within = (plan: ReturnType<typeof planCounts>) => {
  for (const [k, r] of Object.entries(rules)) {
    expect(plan.counts[k]).toBeGreaterThanOrEqual(r.minimum)
    expect(plan.counts[k]).toBeLessThanOrEqual(r.ceiling)
  }
  expect(plan.projectedShare).toBeLessThanOrEqual(0.8 + 1e-9)
}

describe('auto-sizing to a share of the cluster', () => {
  it('at 60% everything fits at its ceiling', () => {
    const plan = at(0.6)
    expect(plan.fit).toBe('ceilings')
    expect(plan.counts).toEqual({ accounts: 2000, animals: 20000, measurements: 22000, notifications: 8000 })
    within(plan)
  })

  it('at 70% bulk kinds shrink first, headline kinds keep their ceilings', () => {
    const plan = at(0.7)
    expect(plan.fit).toBe('bulk-shrunk')
    expect(plan.counts.animals).toBe(20000)
    expect(plan.counts.accounts).toBe(2000)
    expect(plan.counts.measurements).toBeLessThan(22000)
    // In proportion: both bulk kinds shrink by the same share of their span.
    const share = (k: 'measurements' | 'notifications') => (plan.counts[k]! - rules[k]!.minimum) / (rules[k]!.ceiling - rules[k]!.minimum)
    expect(Math.abs(share('measurements') - share('notifications'))).toBeLessThan(0.001)
    within(plan)
    expect(plan.projectedShare).toBeGreaterThan(0.79)
  })

  it('at 75% bulk kinds sit at their minimums and headline kinds shrink', () => {
    const plan = at(0.75)
    expect(plan.fit).toBe('headline-shrunk')
    expect(plan.counts.measurements).toBe(100)
    expect(plan.counts.notifications).toBe(50)
    expect(plan.counts.animals).toBeLessThan(20000)
    within(plan)
  })

  it('at 79% the minimums still hold', () => {
    const plan = at(0.79)
    expect(plan.ok).toBe(true)
    within(plan)
  })

  it('refuses, loading nothing, when even the minimums don’t fit', () => {
    const plan = at(0.7999)
    expect(plan.ok).toBe(false)
    expect(plan.counts).toEqual({})
    expect(plan.refused).toMatch(/Even the minimums need/)
  })

  it('counts what records cause besides themselves', () => {
    const plain = at(0.7)
    const doubled = at(0.7, { indirectFactor: 2 })
    expect(doubled.counts.measurements!).toBeLessThan(plain.counts.measurements!)
    expect(doubled.projectedShare).toBeLessThanOrEqual(0.8 + 1e-9)
  })

  it('fails closed on bad input', () => {
    expect(at(0.5, { targetShare: 0.97 }).refused).toMatch(/hard cap/)
    expect(at(0.5, { targetShare: 0 }).ok).toBe(false)
    expect(at(0.5, { indirectFactor: 0.5 }).ok).toBe(false)
    expect(planCounts({ rules, bytesPerRecord: { ...bytesPerRecord, animals: 0 }, usedBytes: 0, limitBytes: LIMIT }).refused).toMatch(/animals/)
    expect(planCounts({ rules: { a: { ceiling: 1, minimum: 2 } }, bytesPerRecord: { a: 1 }, usedBytes: 0, limitBytes: LIMIT }).ok).toBe(false)
    expect(planCounts({ rules, bytesPerRecord, usedBytes: Number.NaN, limitBytes: LIMIT }).ok).toBe(false)
    expect(planCounts({ rules, bytesPerRecord, usedBytes: 0, limitBytes: 0 }).ok).toBe(false)
  })

  it('never projects past the hard cap', () => {
    const plan = at(0.5, { targetShare: 0.95, hardCap: 0.95 })
    expect(plan.ok).toBe(true)
    expect(plan.projectedShare).toBeLessThanOrEqual(0.95)
  })
})

describe('calibrating and checking', () => {
  it('turns a measured load into an indirect factor, never below 1', () => {
    expect(calibrate({ bytesPerRecord, counts: { animals: 1000 }, growthBytes: 1945 * 1000 * 1.3 })).toBeCloseTo(1.3)
    expect(calibrate({ bytesPerRecord, counts: { animals: 1000 }, growthBytes: 100 })).toBe(1)
    expect(calibrate({ bytesPerRecord, counts: {}, growthBytes: 100 })).toBe(1)
  })

  it('reports ok, warn and alert for a daily check', () => {
    expect(sizeStatus(0.85 * LIMIT, LIMIT).level).toBe('ok')
    expect(sizeStatus(0.92 * LIMIT, LIMIT).level).toBe('warn')
    expect(sizeStatus(0.96 * LIMIT, LIMIT).level).toBe('alert')
    expect(sizeStatus(1, 0).level).toBe('alert')
    expect(sizeStatus(Number.NaN, LIMIT).level).toBe('alert')
    expect(sizeStatus(-1, LIMIT).level).toBe('alert')
    expect(sizeStatus(1, Number.POSITIVE_INFINITY).level).toBe('alert')
    expect(sizeStatus(0.5 * LIMIT, LIMIT).message).toBe('256 MB of 512 MB (50.0%)')
  })
})
