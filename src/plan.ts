import type { Dimension } from './coverage.js'
import type { Random } from './random.js'
import type { CollectionModel, FieldModel } from './schema.js'
import { scalarValue, type ValueContext, type Variant } from './values.js'

const TEXTLIKE = new Set(['text', 'textarea', 'richText'])

/** The ways one field can differ between documents (one dimension per field that has a choice). */
function fieldDimension(f: FieldModel): Dimension | null {
  const opt = (values: string[]) => (f.required ? values.filter((v) => v !== 'empty' && v !== 'none') : values)
  let values: string[]
  switch (f.type) {
    case 'select':
    case 'radio':
      values = f.hasMany ? opt(['none', 'one', 'all']) : opt([...(f.options ?? []), 'empty'])
      break
    case 'checkbox':
      values = ['true', 'false']
      break
    case 'relationship':
    case 'upload':
      values = f.hasMany ? opt(['none', 'one', 'many']) : opt(['empty', 'filled'])
      break
    case 'array':
    case 'blocks':
      values = (f.minRows ?? 0) > 0 || f.required ? ['one', 'many'] : ['empty', 'one', 'many']
      break
    case 'group':
      return null
    default:
      values = TEXTLIKE.has(f.type) || f.type === 'number' || f.type === 'date' ? opt(['empty', 'filled', 'edge']) : opt(['empty', 'filled'])
  }
  // Unique fields and emails get no edge case (it would only repeat the same value).
  if (f.unique || f.type === 'email') values = values.filter((v) => v !== 'edge')
  return values.length > 1 ? { key: f.path, values } : null
}

/** Dimensions of a collection: its top-level and group fields, plus draft/published. */
export function dimensionsFor(model: CollectionModel): Dimension[] {
  const out: Dimension[] = []
  const walk = (fields: FieldModel[]) => {
    for (const f of fields) {
      if (f.type === 'group') walk(f.fields ?? [])
      else {
        const d = fieldDimension(f)
        if (d) out.push(d)
      }
    }
  }
  walk(model.fields)
  if (model.drafts) out.push({ key: '_status', values: ['draft', 'published'] })
  return out
}

export type BuildContext = ValueContext & {
  /** A random existing document id of a collection (null when there is none yet). */
  pick: (collection: string) => string | null
  /** Up to `n` distinct ids. */
  pickMany: (collection: string, n: number) => string[]
  /** Self-relationships and deferred ones are filled in a second pass: skip them here. */
  defer: (path: string) => boolean
}

/** One document for one case. Fields without a dimension: required → filled, optional → sometimes. */
export function buildDoc(model: CollectionModel, c: Record<string, string>, ctx: BuildContext): Record<string, unknown> {
  const doc = buildFields(model.fields, c, ctx)
  if (model.drafts) doc._status = c._status ?? 'published'
  return doc
}

function variantOf(f: FieldModel, c: Record<string, string>, rnd: Random): Variant {
  const v = c[f.path]
  if (v) return v
  if (f.required) return f.hasMany ? 'one' : 'filled'
  if (f.type === 'checkbox') return rnd.chance(0.5) ? 'true' : 'false'
  return rnd.chance(0.6) ? (f.hasMany ? 'one' : 'filled') : 'empty'
}

function buildFields(fields: FieldModel[], c: Record<string, string>, ctx: BuildContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.type === 'group') {
      out[f.name] = buildFields(f.fields ?? [], c, ctx)
      continue
    }
    const variant = variantOf(f, c, ctx.rnd)
    if (f.type === 'relationship' || f.type === 'upload') {
      if (ctx.defer(f.path) || variant === 'empty' || variant === 'none') continue
      const targets = [f.relationTo ?? []].flat()
      const target = ctx.rnd.pick(targets)
      const wrap = (id: string) => (targets.length > 1 ? { relationTo: target, value: id } : id)
      if (f.hasMany) {
        const ids = ctx.pickMany(target, variant === 'many' ? 3 : 1)
        if (ids.length) out[f.name] = ids.map(wrap)
      } else {
        const id = ctx.pick(target)
        if (id) out[f.name] = wrap(id)
      }
      continue
    }
    if (f.type === 'array' || f.type === 'blocks') {
      const want = variant === 'empty' ? 0 : variant === 'one' ? 1 : 3
      const rows = Math.max(f.minRows ?? 0, Math.min(want, f.maxRows ?? want))
      if (!rows) continue
      out[f.name] = Array.from({ length: rows }, () => {
        if (f.type === 'array') return buildFields(f.fields ?? [], {}, ctx)
        const block = ctx.rnd.pick(f.blocks ?? [])
        return block ? { blockType: block.slug, ...buildFields(block.fields, {}, ctx) } : {}
      })
      continue
    }
    const value = scalarValue(f, variant, ctx)
    if (value !== null && value !== undefined) out[f.name] = value
  }
  return out
}
