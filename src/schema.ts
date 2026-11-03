import type { CollectionConfig, Field } from 'payload'

/** What the sandbox needs to know about one field, from the collection config. */
export type FieldModel = {
  /** Dot path from the document root (`group.field`); array rows use `array[]`. */
  path: string
  name: string
  type: Field['type']
  required: boolean
  hasMany: boolean
  localized: boolean
  unique: boolean
  options?: string[]
  relationTo?: string | string[]
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  minRows?: number
  maxRows?: number
  /** Nested fields of groups, arrays and blocks. */
  fields?: FieldModel[]
  blocks?: { slug: string; fields: FieldModel[] }[]
}

export type CollectionModel = {
  slug: string
  fields: FieldModel[]
  auth: boolean
  upload: boolean
  drafts: boolean
}

const SKIP_NAMES = new Set(['id', 'createdAt', 'updatedAt', '_status', 'salt', 'hash', 'resetPasswordToken', 'resetPasswordExpiration', 'loginAttempts', 'lockUntil', 'sessions', 'apiKey', 'apiKeyIndex', 'enableAPIKey'])

const optionValues = (options: unknown): string[] =>
  (Array.isArray(options) ? options : []).map((o) => (typeof o === 'string' ? o : String((o as { value: unknown }).value)))

/** Fields the sandbox fills: named data fields, excluding virtual, UI, computed and auth internals. */
export function readFields(fields: readonly Field[], prefix = ''): FieldModel[] {
  const out: FieldModel[] = []
  for (const f of fields) {
    // Presentational containers share their parent's level.
    if (f.type === 'row' || f.type === 'collapsible') {
      out.push(...readFields(f.fields, prefix))
      continue
    }
    if (f.type === 'tabs') {
      for (const tab of f.tabs) out.push(...('name' in tab && tab.name ? [group(tab.name, tab.fields, prefix)] : readFields(tab.fields, prefix)))
      continue
    }
    if (!('name' in f) || !f.name || f.type === 'ui' || f.type === 'join') continue
    const any = f as Field & Record<string, unknown>
    if (SKIP_NAMES.has(f.name) || any.virtual || (any.admin as { readOnly?: boolean } | undefined)?.readOnly) continue
    if (f.type === 'group') {
      out.push(group(f.name, f.fields, prefix))
      continue
    }
    const base: FieldModel = {
      path: `${prefix}${f.name}`,
      name: f.name,
      type: f.type,
      required: Boolean(any.required),
      hasMany: Boolean(any.hasMany),
      localized: Boolean(any.localized),
      unique: Boolean(any.unique),
    }
    if (f.type === 'select' || f.type === 'radio') base.options = optionValues(any.options)
    if (f.type === 'relationship' || f.type === 'upload') base.relationTo = any.relationTo as string | string[]
    for (const k of ['min', 'max', 'minLength', 'maxLength', 'minRows', 'maxRows'] as const) if (typeof any[k] === 'number') base[k] = any[k] as number
    if (f.type === 'array') base.fields = readFields(f.fields, `${prefix}${f.name}[].`)
    if (f.type === 'blocks') base.blocks = (f.blocks ?? []).map((b) => ({ slug: b.slug, fields: readFields(b.fields, `${prefix}${f.name}[].`) }))
    out.push(base)
  }
  return out
}

function group(name: string, fields: readonly Field[], prefix: string): FieldModel {
  return { path: `${prefix}${name}`, name, type: 'group', required: false, hasMany: false, localized: false, unique: false, fields: readFields(fields, `${prefix}${name}.`) }
}

export function readCollection(c: CollectionConfig): CollectionModel {
  return {
    slug: c.slug,
    fields: readFields(c.fields),
    auth: Boolean(c.auth),
    upload: Boolean(c.upload),
    drafts: Boolean(typeof c.versions === 'object' && c.versions?.drafts),
  }
}

/** Every relationship target of a collection (nested fields included), with whether it is required. */
export function relationTargets(model: CollectionModel): { to: string; required: boolean; path: string }[] {
  const out: { to: string; required: boolean; path: string }[] = []
  const walk = (fields: FieldModel[], requiredParent: boolean) => {
    for (const f of fields) {
      if ((f.type === 'relationship' || f.type === 'upload') && f.relationTo)
        for (const to of [f.relationTo].flat()) out.push({ to, required: f.required && requiredParent, path: f.path })
      if (f.fields) walk(f.fields, requiredParent && f.required)
      for (const b of f.blocks ?? []) walk(b.fields, false)
    }
  }
  walk(model.fields, true)
  return out
}
