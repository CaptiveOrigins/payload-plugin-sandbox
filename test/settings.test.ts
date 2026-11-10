import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, effectiveSettings, settingsProblems } from '../src/index.js'

describe('seed settings', () => {
  it('uses code defaults, overlaid only by what an admin set', () => {
    const s = effectiveSettings({ targetShare: 0.8, counts: { animals: { ceiling: 100, minimum: 5 } }, spend: { capUSD: 10, askAboveUSD: 5 } }, { targetShare: null, counts: {}, spend: { capUSD: 3 } as never, seed: 'mine', unknown: 1 } as never)
    expect(s.targetShare).toBe(0.8)
    expect(s.counts).toEqual({ animals: { ceiling: 100, minimum: 5 } })
    expect(s.spend).toEqual({ capUSD: 3, askAboveUSD: 5 })
    expect(s.seed).toBe('mine')
    expect(s).not.toHaveProperty('unknown')
    expect(s.models).toEqual(DEFAULT_SETTINGS.models)
  })

  it('defaults to Opus plans, Haiku fills, a $10 cap and 80% of the cluster', () => {
    expect(DEFAULT_SETTINGS.models).toEqual({ plan: 'claude-opus-5-5', fill: 'claude-haiku-5-5' })
    expect(DEFAULT_SETTINGS.spend.capUSD).toBe(10)
    expect(DEFAULT_SETTINGS.targetShare).toBe(0.8)
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([])
  })

  it('names what needs fixing', () => {
    const bad = { ...DEFAULT_SETTINGS, targetShare: 0.97, counts: { a: { ceiling: 1, minimum: 3 } }, languages: [{ code: 'en', share: 0.5 }], spend: { capUSD: -1, askAboveUSD: 0 } }
    const problems = settingsProblems(bad).join(' ')
    expect(problems).toMatch(/Target share/)
    expect(problems).toMatch(/“a”/)
    expect(problems).toMatch(/add up to 0.50/)
    expect(problems).toMatch(/spend cap/)
  })
})
