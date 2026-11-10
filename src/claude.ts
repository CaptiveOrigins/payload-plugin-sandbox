import { createHash } from 'node:crypto'

import type { TextEstimate, TextJob, TextSettings, TextSource } from './types.js'

/**
 * Dollars per million tokens, checked against Anthropic's pricing page
 * (platform.claude.com/docs/en/about-claude/pricing) on the date below. The cost estimate names
 * the date, and a release updates the table. Batches are half price; 5-minute cache writes are
 * 1.25× input. Haiku 5.5's prices hold for prompts up to 100,000 tokens; requests here stay far
 * below that (see MAX_PROMPT_TOKENS).
 */
export const PRICES = {
  asOf: '2026-11-10',
  batchDiscount: 0.5,
  models: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  } as Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>,
}

/** Raised for a model the price table doesn't know: an unknown price is never treated as free. */
export class UnknownPrice extends Error {}

/** The few calls the text source makes. The default wraps the official SDK; tests pass a mock. */
export type ClaudeClient = {
  createBatch: (requests: { custom_id: string; params: Record<string, unknown> }[]) => Promise<{ id: string }>
  batchStatus: (id: string) => Promise<'in_progress' | 'canceling' | 'ended'>
  batchResults: (id: string) => AsyncIterable<{ custom_id: string; result: { type: 'succeeded'; message: ClaudeMessage } | { type: 'errored' | 'canceled' | 'expired' } }>
  createMessage: (params: Record<string, unknown>) => Promise<ClaudeMessage>
}
export type ClaudeMessage = { stop_reason: string | null; content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } }

/** Stores written text between runs, keyed by what was asked: same seed and prompt, no second payment. */
export type TextCache = {
  get: (keys: string[]) => Promise<Map<string, Record<string, string>>>
  set: (entries: Map<string, Record<string, string>>) => Promise<void>
}

export function memoryTextCache(): TextCache {
  const store = new Map<string, Record<string, string>>()
  return {
    get: async (keys) => new Map(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)!])),
    set: async (entries) => {
      for (const [k, v] of entries) store.set(k, v)
    },
  }
}

/** A cache in one JSON-lines file on disk (outside the database). Lines that don't parse are skipped. */
export function fileTextCache(path: string): TextCache {
  let loaded: Map<string, Record<string, string>> | null = null
  const load = async () => {
    if (loaded) return loaded
    const fs = await import('node:fs/promises')
    loaded = new Map()
    const raw = await fs.readFile(path, 'utf8').catch(() => '')
    for (const line of raw.split('\n')) {
      try {
        const { k, v } = JSON.parse(line) as { k: string; v: Record<string, string> }
        if (typeof k === 'string' && v && typeof v === 'object') loaded.set(k, v)
      } catch {
        /* a torn or empty line */
      }
    }
    return loaded
  }
  return {
    get: async (keys) => {
      const all = await load()
      return new Map(keys.filter((k) => all.has(k)).map((k) => [k, all.get(k)!]))
    },
    set: async (entries) => {
      if (!entries.size) return
      const fs = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const all = await load()
      for (const [k, v] of entries) all.set(k, v)
      // The folder may not exist yet (a fresh checkout or CI runner).
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.appendFile(path, [...entries].map(([k, v]) => JSON.stringify({ k, v })).join('\n') + '\n')
    },
  }
}

/** The official SDK, loaded only when a key is present. The key is read here and never stored, logged or returned. */
export async function anthropicClient(apiKey: string): Promise<ClaudeClient> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  return {
    createBatch: async (requests) => ({ id: (await client.messages.batches.create({ requests: requests as never })).id }),
    batchStatus: async (id) => (await client.messages.batches.retrieve(id)).processing_status,
    batchResults: (id) => ({
      [Symbol.asyncIterator]: async function* () {
        for await (const r of await client.messages.batches.results(id)) yield r as never
      },
    }),
    createMessage: async (params) => (await client.messages.create(params as never)) as unknown as ClaudeMessage,
  }
}

const PROMPT_VERSION = 'fill-1'
const BLOCKED = /\blorem\b|\bipsum\b|\b(seed|sandbox)\s*:/i
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
const URL_RE = /\bhttps?:\/\/([^/\s?#]+)/gi
const SAFE_HOST = /(^|\.)(example\.(com|org|net)|[a-z0-9-]+\.invalid)$/i

/**
 * Checks one value Claude wrote, and returns it cleaned or null. No placeholders or seed markers,
 * no email or link outside example domains, no blocked words, within the field's length.
 */
export function cleanText(value: unknown, field: TextJob['fields'][number], blockList: RegExp | null = null): string | null {
  if (typeof value !== 'string') return null
  let v = value.replace(/\s+\n/g, '\n').trim()
  if (!v) return null
  if (BLOCKED.test(v) || (blockList && blockList.test(v))) return null
  for (const m of v.matchAll(EMAIL)) if (!SAFE_HOST.test(m[1]!)) return null
  for (const m of v.matchAll(URL_RE)) if (!SAFE_HOST.test(m[1]!)) return null
  if (field.type === 'text') v = v.replace(/\s*\n\s*/g, ' ')
  if (field.maxLength && v.length > field.maxLength) {
    const cut = v.slice(0, field.maxLength)
    const space = cut.lastIndexOf(' ')
    v = (space > field.maxLength * 0.6 ? cut.slice(0, space) : cut).trim()
  }
  return v || null
}

const TOKENS = { text: 30, textarea: 180, richText: 320 } as const
/** Keeps every request under Haiku 5.5's 100,000-token price tier, with room to spare. */
const MAX_PROMPT_TOKENS = 60_000
/** Input token counts are estimated from characters; the worst case allows for being this far under. */
const INPUT_MARGIN = 1.5
const outTokens = (job: TextJob) => job.fields.reduce((n, f) => n + Math.min(TOKENS[f.type], f.maxLength ? Math.ceil(f.maxLength / 3) + 10 : TOKENS[f.type]), 0) + 20
const inTokens = (job: TextJob) => Math.ceil((job.describe.length + JSON.stringify(job.fields).length) / 3) + 15

const SYSTEM = `You write the text people read on a test website: names, titles, notes, bios, descriptions, messages. Nothing you write is real.
Each record comes with what it is, from values already chosen (for example a status, a date, a species). Write text that fits those values and the language asked for. Vary length, tone and wording between records, as real people would; ordinary small slips are fine now and then.
Never use real people's names, real email addresses, real phone numbers, real street addresses or real websites. Links and emails, if any, use example.com. Never write placeholder text such as lorem ipsum, and never write "Seed:" or "Sandbox:".
Return every record you are given, by its id, with a value for every field listed, within its maximum length.`

const schema = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          values: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false } },
        },
        required: ['id', 'values'],
        additionalProperties: false,
      },
    },
  },
  required: ['records'],
  additionalProperties: false,
}

export type ClaudeTextOptions = {
  /** A client, or how to make one. Default: the official SDK with the key from `apiKeyEnv`. */
  client?: ClaudeClient | (() => Promise<ClaudeClient>)
  /** Environment variable holding the key (default ANTHROPIC_API_KEY). Read only when a run needs it. */
  apiKeyEnv?: string
  /** Text kept between runs (default: in memory, this process only). */
  cache?: TextCache
  /** One or two sentences about the site, so the text sounds like it belongs. */
  about?: string
  /** Records per request (default 25). */
  perRequest?: number
  /** How long to wait between batch status checks (default 30 s). */
  pollMs?: number
  /** Most time to wait for a batch (default 24 h, the API's own limit). */
  maxWaitMs?: number
  /** Extra words that must never appear (site-specific). */
  blockList?: RegExp
  prices?: typeof PRICES
  /** For tests: how to wait. */
  sleep?: (ms: number) => Promise<void>
}

type Group = { id: string; jobs: TextJob[]; maxTokens: number; inTokens: number }

/**
 * Claude as a text source for big seeds. One Message Batch (half price) for every record still
 * needing text, structured JSON output, the system prompt cached, and a hard spend cap: requests
 * are sent only while their worst case (every one at its output limit) stays under the cap, so the
 * cap holds whatever comes back. Refused, errored or expired requests are retried once outside
 * the batch, then fall back to word lists. Every value is checked before use; nothing from the
 * site's database is ever sent, only descriptions built from values code chose.
 */
export function claudeTexts(options: ClaudeTextOptions = {}): TextSource {
  const prices = options.prices ?? PRICES
  const cache = options.cache ?? memoryTextCache()
  const perRequest = Math.max(1, Math.min(50, options.perRequest ?? 25))
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const keyOf = (job: TextJob, model: string) => createHash('sha256').update(JSON.stringify([PROMPT_VERSION, model, options.about ?? '', job.language, job.describe, job.fields])).digest('hex')
  const priceOf = (model: string) => {
    const p = prices.models[model]
    if (!p) throw new UnknownPrice(`No price on record for “${model}” (prices as of ${prices.asOf}), so its cost can’t be capped.`)
    return p
  }
  const systemTokens = Math.ceil((SYSTEM.length + (options.about?.length ?? 0)) / 3)

  const group = (jobs: TextJob[]): Group[] => {
    const byKind = new Map<string, TextJob[]>()
    for (const j of jobs) byKind.set(`${j.collection}|${j.language}`, [...(byKind.get(`${j.collection}|${j.language}`) ?? []), j])
    const out: Group[] = []
    for (const list of byKind.values()) {
      let chunk: TextJob[] = []
      let size = systemTokens + 60
      const flush = () => {
        if (!chunk.length) return
        out.push({ id: `g${out.length}`, jobs: chunk, maxTokens: Math.min(32_000, Math.ceil(chunk.reduce((n, j) => n + outTokens(j), 0) * 1.5) + 200), inTokens: size })
        chunk = []
        size = systemTokens + 60
      }
      for (const j of list) {
        if (chunk.length >= perRequest || size + inTokens(j) > MAX_PROMPT_TOKENS) flush()
        chunk.push(j)
        size += inTokens(j)
      }
      flush()
    }
    return out
  }
  /**
   * Worst case for one request: the system prompt written to the cache (the dearer of writing and
   * reading it), the rest of the input uncached, both with a margin for how far a token count can
   * differ from the estimate, and every output token used.
   */
  const worst = (g: Group, model: string, discount: number) => {
    const p = priceOf(model)
    const system = systemTokens * INPUT_MARGIN
    const rest = (g.inTokens - systemTokens) * INPUT_MARGIN
    return ((system * Math.max(p.cacheWrite, p.input) + rest * p.input + g.maxTokens * p.output) / 1e6) * discount
  }
  const params = (g: Group, model: string) => ({
    model,
    max_tokens: g.maxTokens,
    // Haiku: no thinking needed to write short text; other models keep their default.
    ...(model.startsWith('claude-haiku') ? { thinking: { type: 'disabled' } } : {}),
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: options.about ? `${SYSTEM}\nThe site: ${options.about}` : SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          language: g.jobs[0]!.language,
          records: g.jobs.map((j, i) => ({ id: `r${i}`, is: j.describe, fields: j.fields.map((f) => ({ path: f.path, kind: f.type === 'richText' ? 'a few paragraphs' : f.type === 'textarea' ? 'a few sentences' : 'a short line', ...(f.maxLength ? { maxLength: f.maxLength } : {}) })) })),
        }),
      },
    ],
  })
  const cost = (m: ClaudeMessage, model: string, discount: number) => {
    const p = priceOf(model)
    const u = m.usage
    return ((u.input_tokens * p.input + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + (u.cache_read_input_tokens ?? 0) * p.cacheRead + u.output_tokens * p.output) / 1e6) * discount
  }
  const read = (m: ClaudeMessage, g: Group, out: Map<string, Record<string, string>>): { ok: boolean; rejected: number } => {
    if (m.stop_reason === 'refusal' || m.stop_reason === 'max_tokens') return { ok: false, rejected: 0 }
    const text = m.content.find((c) => c.type === 'text')?.text
    let parsed: { records?: { id?: unknown; values?: { path?: unknown; text?: unknown }[] }[] }
    try {
      parsed = JSON.parse(text ?? '')
    } catch {
      return { ok: false, rejected: 0 }
    }
    let rejected = 0
    for (const r of parsed.records ?? []) {
      const job = g.jobs[Number(String(r.id).replace(/^r/, ''))]
      if (!job || !/^r\d+$/.test(String(r.id))) continue
      const values: Record<string, string> = {}
      for (const v of r.values ?? []) {
        const field = job.fields.find((f) => f.path === v.path)
        if (!field) continue // unknown keys are dropped
        const clean = cleanText(v.text, field, options.blockList ?? null)
        if (clean === null) rejected++
        else values[field.path] = clean
      }
      if (Object.keys(values).length) out.set(job.key, values)
    }
    return { ok: true, rejected }
  }

  const estimate = async (jobs: TextJob[], settings: TextSettings): Promise<TextEstimate> => {
    const model = settings.models.fill
    const cached = await cache.get(jobs.map((j) => keyOf(j, model)))
    const groups = group(jobs.filter((j) => !cached.has(keyOf(j, model))))
    const p = priceOf(model)
    const worstUSD = groups.reduce((n, g) => n + worst(g, model, prices.batchDiscount), 0)
    // Likely: about half the output limit used, and the system prompt read from cache after the first request.
    const expectedUSD = groups.reduce((n, g) => n + (((g.inTokens - systemTokens) * p.input + systemTokens * p.cacheRead + g.maxTokens * 0.5 * p.output) / 1e6) * prices.batchDiscount, 0)
    return { requests: groups.length, worstUSD, expectedUSD, cached: cached.size, pricesAsOf: prices.asOf }
  }

  const source: TextSource = async (jobs, { settings }) => {
    const model = settings.models.fill
    priceOf(model)
    const keyed = jobs.map((j) => ({ job: j, cacheKey: keyOf(j, model) }))
    const fromCache = await cache.get(keyed.map((k) => k.cacheKey))
    const texts = new Map<string, Record<string, string>>()
    for (const { job, cacheKey } of keyed) if (fromCache.has(cacheKey)) texts.set(job.key, fromCache.get(cacheKey)!)
    const todo = keyed.filter((k) => !fromCache.has(k.cacheKey)).map((k) => k.job)
    const report = { model, pricesAsOf: prices.asOf, cached: texts.size, requests: 0, retried: 0, failedRequests: 0, rejectedValues: 0, costUSD: 0, capUSD: settings.spend.capUSD, capped: false, noKey: false }
    if (!todo.length) return { texts, report }

    let client: ClaudeClient
    if (options.client) client = typeof options.client === 'function' ? await options.client() : options.client
    else {
      const key = process.env[options.apiKeyEnv ?? 'ANTHROPIC_API_KEY']
      if (!key) return { texts, report: { ...report, noKey: true } }
      client = await anthropicClient(key)
    }

    // Within the cap by construction: only requests whose worst case still fits are sent.
    const groups = group(todo)
    let committed = 0
    const send: Group[] = []
    for (const g of groups) {
      const w = worst(g, model, prices.batchDiscount)
      if (committed + w > settings.spend.capUSD) {
        report.capped = true
        continue
      }
      committed += w
      send.push(g)
    }
    const written = new Map<string, Record<string, string>>()
    const retry: Group[] = []
    if (send.length) {
      report.requests = send.length
      const { id } = await client.createBatch(send.map((g) => ({ custom_id: g.id, params: params(g, model) })))
      const started = Date.now()
      while ((await client.batchStatus(id)) !== 'ended') {
        if (Date.now() - started > (options.maxWaitMs ?? 24 * 3600_000)) throw new Error(`The text batch didn’t finish in time; its results stay available for 29 days (batch ${id}).`)
        await sleep(options.pollMs ?? 30_000)
      }
      const byId = new Map(send.map((g) => [g.id, g]))
      for await (const r of client.batchResults(id)) {
        const g = byId.get(r.custom_id)
        if (!g) continue
        byId.delete(r.custom_id)
        if (r.result.type !== 'succeeded') {
          retry.push(g)
          continue
        }
        report.costUSD += cost(r.result.message, model, prices.batchDiscount)
        const { ok, rejected } = read(r.result.message, g, written)
        report.rejectedValues += rejected
        if (!ok) retry.push(g)
      }
      retry.push(...byId.values()) // missing from the results
    }
    // One retry each, outside the batch at full price, only while the cap still holds.
    let spentCeiling = committed
    for (const g of retry) {
      const w = worst(g, model, 1)
      if (spentCeiling + w > settings.spend.capUSD) {
        report.capped = true
        report.failedRequests++
        continue
      }
      spentCeiling += w
      report.retried++
      try {
        const m = await client.createMessage(params(g, model))
        report.costUSD += cost(m, model, 1)
        const { ok, rejected } = read(m, g, written)
        report.rejectedValues += rejected
        if (!ok) report.failedRequests++
      } catch {
        report.failedRequests++
      }
    }
    const toCache = new Map<string, Record<string, string>>()
    for (const { job, cacheKey } of keyed) {
      const v = written.get(job.key)
      if (!v) continue
      texts.set(job.key, v)
      toCache.set(cacheKey, v)
    }
    await cache.set(toCache)
    report.costUSD = Math.round(report.costUSD * 10_000) / 10_000
    return { texts, report }
  }
  source.estimate = estimate
  return source
}
