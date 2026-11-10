import type { GlobalConfig, Payload, PayloadRequest } from 'payload'

import type { CountRule } from './sizing.js'

/**
 * What a big seed does, as plain data an admin can read and change. The site's code gives the
 * defaults (`seedPlugin({ defaults })`); the `seed-settings` global stores only what an admin
 * changed, so a code update to a default reaches every site that didn't override it.
 */
export type SeedSettings = {
  /** Same seed, same world. */
  seed: string
  /** Per collection: auto-sized between `minimum` and `ceiling`; `bulk` kinds shrink first. */
  counts: Record<string, CountRule>
  /** Fill the cluster up to this share of its limit. */
  targetShare: number
  /** Never project above this share. */
  hardCap: number
  /** The host's enforced limit, in MiB (MongoDB Atlas M0: 512). */
  limitMB: number
  /** Every database on the cluster, to measure (default: the current one only). */
  databases: string[]
  /** Measured bytes per record, documents plus indexes, per collection. */
  bytesPerRecord: Record<string, number>
  /** From a measured load: what hooks add besides the seeded records. */
  indirectFactor: number
  /** Model ids: plan (few calls, judgment) and fill (bulk text). */
  models: { plan: string; fill: string }
  /** Hard cap on Claude spend per run, and the estimate above which a second confirmation names the amount. */
  spend: { capUSD: number; askAboveUSD: number }
  /** Languages generated text is written in, with their shares (should add up to 1). */
  languages: { code: string; share: number }[]
}

export const DEFAULT_SETTINGS: SeedSettings = {
  seed: 'seed',
  counts: {},
  targetShare: 0.8,
  hardCap: 0.95,
  limitMB: 512,
  databases: [],
  bytesPerRecord: {},
  indirectFactor: 1,
  models: { plan: 'claude-opus-5-5', fill: 'claude-haiku-5-5' },
  spend: { capUSD: 10, askAboveUSD: 5 },
  languages: [{ code: 'en', share: 1 }],
}

export const settingsSlug = (o: { slugs?: { settings?: string } }) => o.slugs?.settings ?? 'seed-settings'

const isSet = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length)

/** Defaults from code, overlaid with what an admin changed. Nested groups merge field by field. */
export function effectiveSettings(defaults: Partial<SeedSettings> | undefined, stored: Partial<SeedSettings> | null | undefined): SeedSettings {
  const base = { ...DEFAULT_SETTINGS, ...defaults, models: { ...DEFAULT_SETTINGS.models, ...defaults?.models }, spend: { ...DEFAULT_SETTINGS.spend, ...defaults?.spend } }
  if (!stored) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in DEFAULT_SETTINGS) || !isSet(v)) continue
    if (k === 'models' || k === 'spend') out[k] = { ...(base[k] as object), ...Object.fromEntries(Object.entries(v as object).filter(([, x]) => isSet(x))) }
    else out[k] = v
  }
  return out as SeedSettings
}

/** Checks settings before a run; returns problems in words (empty when fine). */
export function settingsProblems(s: SeedSettings): string[] {
  const out: string[] = []
  if (!(s.targetShare > 0 && s.targetShare <= s.hardCap)) out.push(`Target share ${s.targetShare} must be above 0 and at most the hard cap ${s.hardCap}.`)
  if (!(s.hardCap > 0 && s.hardCap < 1)) out.push(`Hard cap ${s.hardCap} must be between 0 and 1.`)
  if (!(s.spend.capUSD >= 0)) out.push('The spend cap must be 0 or more.')
  for (const [slug, r] of Object.entries(s.counts)) if (!(r.minimum >= 0 && r.ceiling >= r.minimum)) out.push(`“${slug}”: minimum ${r.minimum} must be between 0 and ceiling ${r.ceiling}.`)
  const shares = s.languages.reduce((sum, l) => sum + l.share, 0)
  if (s.languages.length && Math.abs(shares - 1) > 0.01) out.push(`Language shares add up to ${shares.toFixed(2)}, not 1.`)
  return out
}

export async function readSettings(payload: Payload, options: { defaults?: Partial<SeedSettings>; slugs?: { settings?: string } }): Promise<SeedSettings> {
  let stored: Partial<SeedSettings> | null = null
  try {
    stored = (await payload.findGlobal({ slug: settingsSlug(options) as never, depth: 0, overrideAccess: true })) as unknown as Partial<SeedSettings>
  } catch {
    stored = null
  }
  return effectiveSettings(options.defaults, stored)
}

/** The admin's settings global. Empty fields mean "the site's default". */
export function settingsGlobal(slug: string, access: (args: { req: PayloadRequest }) => Promise<boolean>, hidden: boolean): GlobalConfig {
  const blank = 'Leave empty to use the site’s default.'
  return {
    slug,
    label: 'Seed settings',
    admin: { group: 'Seed', hidden, description: 'What a big seed makes and what it may spend. Every empty field uses the site’s default from code.' },
    access: { read: access, update: access },
    fields: [
      { name: 'seed', type: 'text', admin: { description: `Same seed, same world. ${blank}` } },
      { name: 'counts', type: 'json', admin: { description: `Per collection: { "ceiling": n, "minimum": n, "bulk": true }. Counts shrink to fit the cluster; bulk kinds first. ${blank}` } },
      { name: 'targetShare', type: 'number', min: 0.05, max: 0.95, admin: { step: 0.01, description: `Fill the cluster up to this share of its limit (0.8 = 80%). ${blank}` } },
      { name: 'hardCap', type: 'number', min: 0.05, max: 0.99, admin: { step: 0.01, description: `Never project above this share. ${blank}` } },
      { name: 'limitMB', type: 'number', min: 1, admin: { description: `The cluster’s enforced limit in MiB. ${blank}` } },
      { name: 'databases', type: 'text', hasMany: true, admin: { description: `Every database on the cluster, to measure. ${blank}` } },
      { name: 'bytesPerRecord', type: 'json', admin: { description: `Measured size per record, per collection. ${blank}` } },
      { name: 'indirectFactor', type: 'number', min: 1, admin: { step: 0.01, description: `From a measured load. ${blank}` } },
      {
        name: 'models',
        type: 'group',
        fields: [
          { name: 'plan', type: 'text', admin: { description: `Writes the plan (default Claude Opus 5.5). ${blank}` } },
          { name: 'fill', type: 'text', admin: { description: `Writes the text on each record (default Claude Haiku 5.5). ${blank}` } },
        ],
      },
      {
        name: 'spend',
        type: 'group',
        fields: [
          { name: 'capUSD', type: 'number', min: 0, admin: { description: `Hard cap per run, in US dollars. ${blank}` } },
          { name: 'askAboveUSD', type: 'number', min: 0, admin: { description: `Above this estimate, a second confirmation names the amount. ${blank}` } },
        ],
      },
      { name: 'languages', type: 'json', admin: { description: `[{ "code": "en", "share": 0.8 }, ...]. ${blank}` } },
    ],
  }
}
