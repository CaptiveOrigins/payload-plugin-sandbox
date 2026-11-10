import type { Payload } from 'payload'

import { generatable } from './run.js'
import type { CollectionModel, FieldModel } from './schema.js'
import type { Persona, SeedOptions, SeedPlan } from './types.js'

const MAX_PERSONAS = 12
const MAX_SAMPLES = 12
const SAMPLE_TEXT = 200
const STORY_TEXT = 400

/** Fields where plausible wording helps: free text that isn't an email, slug-like or unique. */
function textFields(fields: FieldModel[], prefix = ''): string[] {
  return fields.flatMap((f) => {
    if (f.type === 'group') return textFields(f.fields ?? [], `${prefix}${f.name}.`)
    return (f.type === 'text' || f.type === 'textarea') && !f.unique && !/slug|email|url|password|token/i.test(f.name) ? [`${prefix}${f.name}`] : []
  })
}

/** What the plan writer sees: the shape of the site. Never any documents. */
export function schemaSummary(models: CollectionModel[], options: SeedOptions) {
  return {
    site: options.about ?? '',
    collections: models.map((m) => ({
      slug: m.slug,
      accounts: m.auth,
      textFields: textFields(m.fields),
      choices: m.fields.filter((f) => f.options?.length).map((f) => ({ field: f.path, options: f.options })),
    })),
  }
}

const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    collections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          note: { type: 'string' },
          samples: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['field', 'values'], additionalProperties: false } },
        },
        required: ['slug', 'note', 'samples'],
        additionalProperties: false,
      },
    },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { collection: { type: 'string' }, name: { type: 'string' }, story: { type: 'string' }, traits: { type: 'array', items: { type: 'string' } } },
        required: ['collection', 'name', 'story', 'traits'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'collections', 'personas'],
  additionalProperties: false,
} as const

const SYSTEM = `You plan test data for a website, given only the shape of its database. Nothing you write is real.
Write plausible, varied sample wording for the listed text fields, in the site's voice, for a tester to read. Include variety: short and long, different people and situations. Never use real people's names, real email addresses, real phone numbers or real street addresses.
Write personas for account collections: a few fictional people who would use this site, each with a one or two sentence story of what they do here and what they should try, so a tester can sign in as them and follow the story. Traits are short tags describing them, chosen from the site's own terms where it gives any.
Only use the collection slugs and fields you are given.`

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n)

/** A plan as plain, checked data: only collections and text fields that exist, bounded sizes. Whatever an AI said. */
export function cleanPlan(raw: unknown, models: CollectionModel[], source: SeedPlan['source'], selection?: string[]): SeedPlan {
  const r = (raw ?? {}) as { summary?: unknown; collections?: { slug?: unknown; note?: unknown; samples?: { field?: unknown; values?: unknown[] }[] }[]; personas?: { collection?: unknown; name?: unknown; story?: unknown; traits?: unknown[] }[] }
  const bySlug = new Map(models.map((m) => [m.slug, m]))
  const wanted = selection?.length ? new Set(selection) : null
  const written = new Map((r.collections ?? []).map((c) => [String(c.slug), c]))
  const collections = models
    .filter((m) => !wanted || wanted.has(m.slug))
    .map((m) => {
      const c = written.get(m.slug)
      const allowed = new Set(textFields(m.fields))
      const samples = Object.fromEntries(
        (c?.samples ?? [])
          .filter((s) => allowed.has(String(s.field)))
          .map((s) => [String(s.field), (s.values ?? []).map((v) => clip(v, SAMPLE_TEXT)).filter(Boolean).slice(0, MAX_SAMPLES)] as const)
          .filter(([, values]) => values.length),
      )
      return { slug: m.slug, note: clip(c?.note, 300), samples }
    })
  const personas: Persona[] = (r.personas ?? [])
    .filter((p) => bySlug.get(String(p.collection))?.auth)
    .slice(0, MAX_PERSONAS)
    .map((p) => ({ collection: String(p.collection), name: clip(p.name, 80), story: clip(p.story, STORY_TEXT), traits: (p.traits ?? []).map((t) => clip(t, 40)).filter(Boolean).slice(0, 8) }))
    .filter((p) => p.name)
  return { source, summary: clip(r.summary, 600), collections, personas }
}

/**
 * The plan for a run, to review before anything is created. Written by AI when the site
 * gives `ai` (it sees the schema, never documents); otherwise plain generation with the
 * site's own personas. If the AI fails, plain generation still works.
 */
export async function writePlan(payload: Payload, options: SeedOptions, { collections, useAi = true }: { collections?: string[]; useAi?: boolean } = {}): Promise<SeedPlan & { aiError?: string }> {
  const models = generatable(payload.config.collections, options)
  const own = options.personas ?? []
  const merge = (plan: SeedPlan): SeedPlan => ({ ...plan, personas: [...own, ...plan.personas] })
  if (options.ai && useAi) {
    try {
      const raw = await options.ai({ system: SYSTEM, prompt: JSON.stringify(schemaSummary(collections?.length ? models.filter((m) => collections.includes(m.slug)) : models, options)), schema: planSchema })
      return merge(cleanPlan(raw, models, 'ai', collections))
    } catch (e) {
      return { ...merge(cleanPlan({}, models, 'plain', collections)), aiError: (e as Error).message ?? String(e) }
    }
  }
  return merge(cleanPlan({}, models, 'plain', collections))
}

/** Puts plan wording onto a generated document; deliberately odd values (edge cases) stay. */
export function applySamples(data: Record<string, unknown>, samples: Record<string, string[]> | undefined, pick: (values: string[]) => string, variantOf: (path: string) => string | undefined): Record<string, unknown> {
  if (!samples) return data
  const out = { ...data }
  for (const [path, values] of Object.entries(samples)) {
    if (variantOf(path) === 'edge' || !values.length) continue
    const parts = path.split('.')
    let at: Record<string, unknown> = out
    let ok = true
    for (const part of parts.slice(0, -1)) {
      const next = at[part]
      if (!next || typeof next !== 'object') {
        ok = false
        break
      }
      at[part] = { ...(next as object) }
      at = at[part] as Record<string, unknown>
    }
    const last = parts[parts.length - 1]!
    if (ok && typeof at[last] === 'string' && at[last]) at[last] = pick(values)
  }
  return out
}
