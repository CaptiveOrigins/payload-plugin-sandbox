import { describe, expect, it } from 'vitest'

import { claudeTexts, cleanText, memoryTextCache, UnknownPrice, type ClaudeClient, type ClaudeMessage, type TextJob, type TextSettings } from '../src/index.js'

const settings: TextSettings = { models: { plan: 'claude-opus-5-5', fill: 'claude-haiku-5-5' }, spend: { capUSD: 10, askAboveUSD: 5 } }
const job = (i: number, extra: Partial<TextJob> = {}): TextJob => ({ key: `animals:${i}`, collection: 'animals', language: 'en', describe: `animals; sex: female; born: 2019-0${(i % 9) + 1}-01`, fields: [{ path: 'name', type: 'text', maxLength: 40 }, { path: 'notes', type: 'textarea' }], ...extra })
const jobs = (n: number) => Array.from({ length: n }, (_, i) => job(i))

type Params = { model: string; max_tokens: number; thinking?: unknown; output_config: { effort: string; format: { type: string } }; system: { cache_control?: unknown; text: string }[]; messages: { content: string }[] }

/** A fake Claude: answers each request from `answer`, and records what it was sent. Nothing leaves the machine. */
function mockClaude(answer: (p: Params, attempt: 'batch' | 'retry') => { type: 'succeeded'; message: ClaudeMessage } | { type: 'errored' | 'expired' | 'canceled' }) {
  const sent: { params: Params; via: 'batch' | 'retry' }[] = []
  const batches = new Map<string, { custom_id: string; params: Params }[]>()
  let polls = 0
  const client: ClaudeClient = {
    createBatch: async (requests) => {
      const id = `batch_${batches.size}`
      batches.set(id, requests as never)
      for (const r of requests) sent.push({ params: r.params as never, via: 'batch' })
      return { id }
    },
    batchStatus: async () => (++polls % 2 ? 'in_progress' : 'ended'),
    batchResults: (id) => ({
      [Symbol.asyncIterator]: async function* () {
        for (const r of batches.get(id)!) yield { custom_id: r.custom_id, result: answer(r.params, 'batch') } as never
      },
    }),
    createMessage: async (params) => {
      sent.push({ params: params as never, via: 'retry' })
      const a = answer(params as never, 'retry')
      if (a.type !== 'succeeded') throw new Error('overloaded')
      return a.message
    },
  }
  return { client, sent }
}

/** A good answer: every record, every field, in the requested shape. */
const good = (p: Params, write: (path: string, id: string) => string = (path, id) => `${path === 'name' ? 'Clementine' : 'Basks in the morning, eats greens.'} ${id}`): ClaudeMessage => {
  const { records } = JSON.parse(p.messages[0]!.content) as { records: { id: string; fields: { path: string }[] }[] }
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ records: records.map((r) => ({ id: r.id, values: r.fields.map((f) => ({ path: f.path, text: write(f.path, r.id) })) })) }) }], usage: { input_tokens: 2000, output_tokens: 1500, cache_read_input_tokens: 300 } }
}
const noSleep = async () => {}

describe('Claude text source (mocked API: no requests leave the machine)', () => {
  it('writes text in one batch, with structured output, a cached system prompt and no thinking on Haiku', async () => {
    const { client, sent } = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    const source = claudeTexts({ client, sleep: noSleep, perRequest: 10 })
    const out = await source(jobs(25), { seed: 's', settings })
    const { texts, report } = out as unknown as { texts: Map<string, Record<string, string>>; report: Record<string, unknown> }
    expect(texts.size).toBe(25)
    expect(texts.get('animals:3')).toEqual({ name: 'Clementine r3', notes: 'Basks in the morning, eats greens. r3' })
    expect(sent.length).toBe(3)
    expect(sent.every((s) => s.via === 'batch')).toBe(true)
    const p = sent[0]!.params
    expect(p.model).toBe('claude-haiku-5-5')
    expect(p.thinking).toEqual({ type: 'disabled' })
    expect(p.output_config.format.type).toBe('json_schema')
    expect(p.system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(report).toMatchObject({ requests: 3, retried: 0, failedRequests: 0, capped: false })
    expect(report.costUSD).toBeGreaterThan(0)
  })

  it('sends only descriptions of records: never ids or keys', async () => {
    const { client, sent } = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    await claudeTexts({ client, sleep: noSleep })(jobs(5), { seed: 's', settings })
    const content = sent[0]!.params.messages[0]!.content
    expect(content).not.toMatch(/animals:\d/)
    expect(content).toMatch(/sex: female/)
  })

  it('pays nothing for text it already has', async () => {
    const cache = memoryTextCache()
    const first = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    await claudeTexts({ client: first.client, cache, sleep: noSleep })(jobs(8), { seed: 's', settings })
    const second = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    const source = claudeTexts({ client: second.client, cache, sleep: noSleep })
    expect((await source.estimate!(jobs(8), settings)).requests).toBe(0)
    const { texts, report } = (await source(jobs(8), { seed: 's', settings })) as unknown as { texts: Map<string, unknown>; report: { cached: number } }
    expect(texts.size).toBe(8)
    expect(report.cached).toBe(8)
    expect(second.sent.length).toBe(0)
  })

  it('retries a refused, errored or expired request once outside the batch, then falls back to word lists', async () => {
    let n = 0
    const { client, sent } = mockClaude((p, via) => {
      n++
      if (via === 'batch' && n === 1) return { type: 'succeeded', message: { ...good(p), stop_reason: 'refusal' } }
      if (via === 'batch' && n === 2) return { type: 'errored' }
      if (via === 'batch' && n === 3) return { type: 'expired' }
      if (via === 'retry' && n === 6) return { type: 'errored' } // the expired one fails again
      return { type: 'succeeded', message: good(p) }
    })
    const { texts, report } = (await claudeTexts({ client, sleep: noSleep, perRequest: 5 })(jobs(20), { seed: 's', settings })) as unknown as { texts: Map<string, unknown>; report: Record<string, number> }
    expect(sent.filter((s) => s.via === 'retry').length).toBe(3)
    expect(report.retried).toBe(3)
    expect(report.failedRequests).toBe(1)
    expect(texts.size).toBe(15)
  })

  it('never lets the worst case pass the spend cap, and says when it held back', async () => {
    const { client, sent } = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    const source = claudeTexts({ client, sleep: noSleep, perRequest: 10 })
    const { worstUSD } = await source.estimate!(jobs(100), settings)
    const cap = worstUSD / 3
    const { report } = (await source(jobs(100), { seed: 's', settings: { ...settings, spend: { capUSD: cap, askAboveUSD: 0 } } })) as unknown as { report: { capped: boolean; costUSD: number; requests: number } }
    expect(report.capped).toBe(true)
    expect(report.requests).toBeGreaterThan(0)
    expect(report.requests).toBeLessThan(10)
    expect(report.costUSD).toBeLessThanOrEqual(cap)
    const none = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    const zero = (await claudeTexts({ client: none.client, sleep: noSleep })(jobs(10), { seed: 's', settings: { ...settings, spend: { capUSD: 0, askAboveUSD: 0 } } })) as unknown as { report: { capped: boolean } }
    expect(zero.report.capped).toBe(true)
    expect(none.sent.length).toBe(0)
    expect(sent.length).toBe(report.requests)
  })

  it('drops values that break the content rules, and keeps the rest', async () => {
    const bad: Record<string, string> = { r0: 'Lorem ipsum dolor', r1: 'Write to jane@mail.test', r2: 'See https://realsite.org/page', r3: 'Seed: a tortoise', r4: 'Mail me at pat@example.com or https://example.com/x' }
    const { client } = mockClaude((p) => ({ type: 'succeeded', message: good(p, (path, id) => (path === 'notes' ? (bad[id] ?? 'Fine notes') : 'Name')) }))
    const { texts, report } = (await claudeTexts({ client, sleep: noSleep })(jobs(5), { seed: 's', settings })) as unknown as { texts: Map<string, Record<string, string>>; report: { rejectedValues: number } }
    expect(report.rejectedValues).toBe(4)
    expect(texts.get('animals:0')).toEqual({ name: 'Name' })
    expect(texts.get('animals:4')!.notes).toBe('Mail me at pat@example.com or https://example.com/x')
  })

  it('without a key it sends nothing and says so', async () => {
    const before = process.env.SEED_TEST_NO_KEY
    delete process.env.SEED_TEST_NO_KEY
    const { texts, report } = (await claudeTexts({ apiKeyEnv: 'SEED_TEST_NO_KEY' })(jobs(3), { seed: 's', settings })) as unknown as { texts: Map<string, unknown>; report: { noKey: boolean } }
    expect(report.noKey).toBe(true)
    expect(texts.size).toBe(0)
    if (before !== undefined) process.env.SEED_TEST_NO_KEY = before
  })

  it('refuses a model it has no price for, rather than treating it as free', async () => {
    const { client } = mockClaude((p) => ({ type: 'succeeded', message: good(p) }))
    await expect(claudeTexts({ client })(jobs(1), { seed: 's', settings: { ...settings, models: { ...settings.models, fill: 'claude-new-model' } } })).rejects.toThrow(UnknownPrice)
  })

  it('estimates the worst case above the likely one', async () => {
    const e = await claudeTexts({ client: mockClaude(() => ({ type: 'errored' })).client }).estimate!(jobs(500), settings)
    expect(e.requests).toBe(20)
    expect(e.worstUSD).toBeGreaterThan(e.expectedUSD)
    expect(e.pricesAsOf).toBe('2026-11-10')
  })
})

describe('cleaning one value', () => {
  const text = { path: 'name', type: 'text' as const, maxLength: 20 }
  it('trims to the field, joins lines in short text, and refuses empty and unsafe text', () => {
    expect(cleanText('  Clementine the second of her name  ', text)).toBe('Clementine the')
    expect(cleanText('Two\nlines', { path: 'n', type: 'text' })).toBe('Two lines')
    expect(cleanText('Two\nlines', { path: 'n', type: 'textarea' })).toBe('Two\nlines')
    expect(cleanText('   ', text)).toBeNull()
    expect(cleanText(42, text)).toBeNull()
    expect(cleanText('Sandbox: hi', text)).toBeNull()
    expect(cleanText('a@b.invalid', text)).toBe('a@b.invalid')
    expect(cleanText('bad word here', text, /\bbad\b/i)).toBeNull()
  })
})
