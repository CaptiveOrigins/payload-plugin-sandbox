import type { Random } from './random.js'
import type { FieldModel } from './schema.js'

/** How a field is filled in one case. */
export type Variant = 'empty' | 'filled' | 'edge' | 'none' | 'one' | 'many' | 'all' | 'true' | 'false' | string

const FIRST = ['Ada', 'Bo', 'Chen', 'Dara', 'Eli', 'Femi', 'Greta', 'Hana', 'Iker', 'Juno', 'Kai', 'Lena', 'Mateo', 'Nia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tala', 'Uma', 'Vik', 'Wren', 'Yuki', 'Zoë']
const LAST = ['Abara', 'Becker', 'Castillo', 'Dubois', 'Eriksen', 'Fontaine', 'García', 'Haddad', 'Ivanova', 'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quiroga', 'Rossi', 'Singh', 'Tanaka']
const WORDS = ['amber', 'basalt', 'canyon', 'delta', 'ember', 'fern', 'granite', 'harbor', 'iris', 'juniper', 'kelp', 'lagoon', 'meadow', 'nectar', 'opal', 'pine', 'quartz', 'reef', 'sage', 'tundra', 'umber', 'violet', 'willow', 'yarrow', 'zephyr']
/** Edge-case text: accents, CJK, right-to-left, emoji (catches encoding and layout bugs). */
const EDGE = ['Zoë Ñúñez–Ødegård', '测试 試験 테스트', 'مرحبا שלום', 'Gecko 🦎 & Tortoise 🐢', "O'Brien \"quoted\" <b>not bold</b>"]

const sentence = (rnd: Random, words = 8) => {
  const w = Array.from({ length: words }, () => rnd.pick(WORDS))
  return `${w[0]![0]!.toUpperCase()}${w.join(' ').slice(1)}.`
}
const person = (rnd: Random) => `${rnd.pick(FIRST)} ${rnd.pick(LAST)}`

/** Minimal valid Lexical rich text. */
export const lexical = (text: string) => ({
  root: {
    type: 'root',
    format: '',
    indent: 0,
    version: 1,
    direction: 'ltr',
    children: [{ type: 'paragraph', format: '', indent: 0, version: 1, direction: 'ltr', textFormat: 0, children: [{ type: 'text', text, format: 0, style: '', mode: 'normal', detail: 0, version: 1 }] }],
  },
})

export type ValueContext = {
  rnd: Random
  /** Unique token for unique fields and emails (unique across batches too). */
  serial: () => number | string
  /** Domain for generated emails (never deliverable). Default example.invalid. */
  emailDomain: string
}

/** A value for a scalar field (text, number, date, ...); null = leave empty. */
export function scalarValue(f: FieldModel, variant: Variant, ctx: ValueContext): unknown {
  if (variant === 'empty' || variant === 'none') return null
  const { rnd } = ctx
  const edge = variant === 'edge'
  const n = f.name.toLowerCase()
  const clamp = (s: string) => {
    let out = s
    if (f.minLength && out.length < f.minLength) out = out.padEnd(f.minLength, ' x')
    if (f.maxLength && out.length > f.maxLength) out = out.slice(0, f.maxLength)
    return out
  }
  switch (f.type) {
    case 'email':
      return `seed+${ctx.serial()}@${ctx.emailDomain}`
    case 'text': {
      let s: string
      if (edge) s = rnd.pick(EDGE)
      else if (/(^|_)(name|fullname|displayname)$|^name$|firstname|lastname|author|keeper/.test(n)) s = /first/.test(n) ? rnd.pick(FIRST) : /last/.test(n) ? rnd.pick(LAST) : person(rnd)
      else if (/slug|key|handle|code$/.test(n)) s = `${rnd.pick(WORDS)}-${rnd.pick(WORDS)}-${ctx.serial()}`
      else if (/url|link|website|href/.test(n)) s = `https://example.com/${rnd.pick(WORDS)}`
      else if (/phone/.test(n)) s = `+1 555 01${String(rnd.int(0, 99)).padStart(2, '0')}`
      else if (/postal|zip/.test(n)) s = String(rnd.int(10000, 99999))
      else if (/color|colour/.test(n)) s = `#${rnd.int(0, 0xffffff).toString(16).padStart(6, '0')}`
      else if (/title|label|heading/.test(n)) s = sentence(rnd, rnd.int(2, 5)).replace(/\.$/, '')
      else s = sentence(rnd, rnd.int(2, 6)).replace(/\.$/, '')
      if (f.unique && !/slug|key|handle|code$/.test(n)) s = `${s} ${ctx.serial()}`
      if (f.hasMany) return [clamp(s), clamp(`${rnd.pick(WORDS)} ${ctx.serial()}`)]
      return clamp(s)
    }
    case 'textarea':
      return clamp(edge ? `${rnd.pick(EDGE)} ${'Long text. '.repeat(40)}` : Array.from({ length: rnd.int(1, 3) }, () => sentence(rnd, rnd.int(6, 14))).join(' '))
    case 'code':
      return '// sandbox\nconst value = 1\n'
    case 'json':
      return { sandbox: true, note: sentence(rnd, 4) }
    case 'richText':
      return lexical(edge ? `${rnd.pick(EDGE)} ${'Long paragraph. '.repeat(30)}` : Array.from({ length: rnd.int(2, 4) }, () => sentence(rnd, rnd.int(8, 16))).join(' '))
    case 'number': {
      const min = f.min ?? 0
      const max = f.max ?? (min + 100)
      const v = edge ? (rnd.chance(0.5) ? min : max) : rnd.int(Math.ceil(min), Math.floor(max))
      return f.hasMany ? [v, Math.min(max, v + 1)] : v
    }
    case 'date': {
      const day = 86_400_000
      const offset = edge ? (rnd.chance(0.5) ? -rnd.int(3650, 18250) : rnd.int(30, 3650)) : -rnd.int(1, 3650)
      return new Date(Date.UTC(2026, 10, 1) + offset * day).toISOString()
    }
    case 'point':
      return [Number((rnd.next() * 360 - 180).toFixed(4)), Number((rnd.next() * 170 - 85).toFixed(4))]
    case 'checkbox':
      return variant === 'true'
    case 'select':
    case 'radio': {
      const options = f.options ?? []
      if (!options.length) return null
      if (f.hasMany) return variant === 'all' ? options : variant === 'one' || variant === 'filled' ? [rnd.pick(options)] : []
      return options.includes(variant) ? variant : rnd.pick(options)
    }
    default:
      return null
  }
}
