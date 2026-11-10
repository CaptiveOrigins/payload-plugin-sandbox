import type { Payload } from 'payload'

import { selectMinimums, type CoveragePlan, type Minimum } from './coveragePlan.js'
import { MARKER_BATCH } from './run.js'
import { readCollection, type FieldModel } from './schema.js'

/**
 * The realism audit (design note section 10): after a run, reads what the batch made and checks it
 * looks like real use. It never deletes or changes anything: a failed check marks the run "done with
 * problems" and says what failed, with numbers.
 */
export type RealismCheck = { name: string; ok: boolean; detail: string; examples?: string[] }
export type RealismReport = { ok: boolean; checks: RealismCheck[]; records: number }

const PAGE = 1000
const LONG = 40
const PLACEHOLDER = /\blorem\b|\bipsum\b/i
const MARKER_TEXT = /\b(seed|sandbox)\s*:/i
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
const URL_RE = /\bhttps?:\/\/([^/\s?#"']+)/gi
const SAFE_HOST = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.invalid)$/i
const PERSON = /(^|\.)(name|fullname|displayname|firstname|lastname)$/i

/** Every string a field holds, rich text included (its text nodes), with the field's path. */
function strings(value: unknown, path: string, out: { path: string; text: string }[], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return
  if (typeof value === 'string') out.push({ path, text: value })
  else if (Array.isArray(value)) for (const v of value) strings(v, path, out, depth + 1)
  else if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.text === 'string' && o.type === 'text') out.push({ path, text: o.text })
    for (const [k, v] of Object.entries(o)) if (k !== 'text' && k !== 'id' && k !== '_id') strings(v, k === 'root' || k === 'children' ? path : `${path}.${k}`, out, depth + 1)
  }
}

const textPaths = (fields: FieldModel[]): string[] =>
  fields.flatMap((f) => (f.type === 'group' ? textPaths(f.fields ?? []) : f.type === 'text' || f.type === 'textarea' || f.type === 'richText' ? [f.path] : f.fields ? textPaths(f.fields) : []))

const get = (doc: Record<string, unknown>, path: string): unknown => {
  let at: unknown = doc
  for (const p of path.replace(/\[\]/g, '').split('.')) at = Array.isArray(at) ? at.map((x) => (x as Record<string, unknown>)?.[p]) : at && typeof at === 'object' ? (at as Record<string, unknown>)[p] : undefined
  return at
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Audits one batch. `plan` (optional) adds the coverage check: each select value's minimum, measured
 * on what was really made. `size` picks which minimums apply.
 */
export async function auditBatch(payload: Payload, batch: string, collections: string[], { plan, size = 'big', emailDomain = 'example.invalid' }: { plan?: CoveragePlan; size?: keyof Minimum; emailDomain?: string } = {}): Promise<RealismReport> {
  const checks: RealismCheck[] = []
  const seen = new Map<string, { count: number; example: string }>()
  const people = { total: 0, distinct: new Set<string>() }
  const bad = { placeholder: [] as string[], marker: [] as string[], email: [] as string[], url: [] as string[] }
  const valueCounts = new Map<string, number>()
  const minimums = plan ? selectMinimums({ collections: payload.config.collections }, plan, size).filter((m) => collections.includes(m.collection)) : []
  let records = 0

  for (const slug of collections) {
    const cfg = payload.config.collections.find((c) => c.slug === slug)
    if (!cfg) continue
    const model = readCollection(cfg)
    const paths = textPaths(model.fields)
    const selectPaths = [...new Set(minimums.filter((m) => m.collection === slug).map((m) => m.path))]
    for (let page = 1; ; page++) {
      const res = await payload.find({ collection: slug as never, where: { [MARKER_BATCH]: { equals: batch } } as never, depth: 0, limit: PAGE, page, overrideAccess: true, draft: true })
      for (const doc of res.docs as unknown as Record<string, unknown>[]) {
        records++
        for (const p of selectPaths) for (const v of [get(doc, p)].flat(3)) if (typeof v === 'string') valueCounts.set(`${slug}|${p}|${v}`, (valueCounts.get(`${slug}|${p}|${v}`) ?? 0) + 1)
        const found: { path: string; text: string }[] = []
        for (const p of paths) strings(get(doc, p), p, found)
        for (const { path, text } of found) {
          const where = `${slug}.${path}`
          if (PLACEHOLDER.test(text)) bad.placeholder.push(`${where}: ${text.slice(0, 60)}`)
          if (MARKER_TEXT.test(text)) bad.marker.push(`${where}: ${text.slice(0, 60)}`)
          for (const m of text.matchAll(EMAIL)) if (!SAFE_HOST.test(m[1]!) && !m[0].endsWith(`@${emailDomain}`)) bad.email.push(`${where}: ${m[0]}`)
          for (const m of text.matchAll(URL_RE)) if (!SAFE_HOST.test(m[1]!)) bad.url.push(`${where}: ${m[0]}`)
          if (model.auth && PERSON.test(path)) {
            people.total++
            people.distinct.add(norm(text))
          }
          if (text.length >= LONG) {
            const key = `${slug}|${path}|${norm(text)}`
            const s = seen.get(key)
            seen.set(key, { count: (s?.count ?? 0) + 1, example: s?.example ?? `${where}: ${text.slice(0, 60)}` })
          }
        }
      }
      if (!res.hasNextPage) break
    }
  }

  const repeats = [...seen.values()].filter((s) => s.count > 2)
  checks.push({ name: 'Long text not repeated', ok: repeats.length === 0, detail: repeats.length ? `${repeats.length} texts of ${LONG}+ characters appear more than twice (same words, ignoring case and punctuation)` : `No text of ${LONG}+ characters appears more than twice`, examples: repeats.slice(0, 5).map((r) => `${r.example} (×${r.count})`) })
  // The 97% rule needs a real sample: with a handful of names, one repeat says nothing.
  if (people.total >= 50) {
    const share = people.distinct.size / people.total
    checks.push({ name: 'People’s names distinct', ok: share >= 0.97, detail: `${(share * 100).toFixed(1)}% of ${people.total} names are distinct (pass at 97%)` })
  }
  const list = (name: string, items: string[], what: string) => checks.push({ name, ok: items.length === 0, detail: items.length ? `${items.length} ${what}` : `None`, examples: items.slice(0, 5) })
  list('No placeholder text', bad.placeholder, 'values with placeholder text (lorem ipsum)')
  list('No seed markers in visible text', bad.marker, 'values saying "Seed:" or "Sandbox:"')
  list('Emails only on example domains', bad.email, 'emails outside example domains')
  list('Links only on example domains', bad.url, 'links outside example domains')
  if (minimums.length) {
    const short = minimums.filter((m) => (valueCounts.get(`${m.collection}|${m.path}|${m.value}`) ?? 0) < m.minimum)
    checks.push({ name: 'Every select value at its minimum', ok: short.length === 0, detail: short.length ? `${short.length} of ${minimums.length} values below their minimum in ${size}` : `All ${minimums.length} values reach their minimum in ${size}`, examples: short.slice(0, 8).map((m) => `${m.collection}.${m.path} = ${m.value}: ${valueCounts.get(`${m.collection}|${m.path}|${m.value}`) ?? 0} of ${m.minimum}`) })
  }
  return { ok: checks.every((c) => c.ok), checks, records }
}
