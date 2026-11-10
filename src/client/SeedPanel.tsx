'use client'

import { Button } from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

import type { BatchReport, SeedPlan } from '../types.js'

type Batch = { id: string; name: string; status: string; seed?: string; plan?: SeedPlan; report?: (BatchReport & { error?: string }) | null; createdAt: string }

const POLL_MS = 3000
const box: React.CSSProperties = { border: '1px solid var(--theme-elevation-150)', borderRadius: 6, padding: 'var(--base)', marginBottom: 'var(--base)' }
const muted: React.CSSProperties = { color: 'var(--theme-elevation-500)' }
const cell: React.CSSProperties = { padding: '4px 12px 4px 0', textAlign: 'start' }

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) throw new Error(String(json?.error ?? res.statusText))
  return json ?? {}
}

export function SeedPanel({ apiPath, batchesPath, siteHome, collections }: { apiPath: string; batchesPath: string; siteHome: string; collections: string[] }) {
  const [batches, setBatches] = useState<Batch[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`${batchesPath}?sort=-createdAt&limit=20&depth=0`, { credentials: 'include' })
    if (res.ok) setBatches(((await res.json()) as { docs: Batch[] }).docs)
  }, [batchesPath])
  useEffect(() => {
    void load()
  }, [load])
  const running = batches.some((b) => b.status === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [running, load])

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
    await load()
  }
  const plan = (useAi: boolean) =>
    act(async () => {
      const out = (await post(`${apiPath}/plan`, { collections: chosen, useAi })) as { aiError?: string }
      if (out.aiError) setError(`The AI plan failed, so this is a plain one: ${out.aiError}`)
    })

  return (
    <div style={{ maxWidth: 960 }}>
      <p style={{ ...muted, marginBottom: 'var(--base)' }}>Test data that covers every option and shape, reviewed before it’s created. Everything here is marked, can be removed in one step, and doesn’t exist in production.</p>
      {error && <p role="alert" style={{ color: 'var(--theme-error-500)' }}>{error}</p>}
      <section style={box}>
        <h2>New plan</h2>
        <label style={{ display: 'block', margin: '8px 0' }}>
          Collections (none chosen: all; what they depend on is added)
          <select multiple size={8} value={chosen} onChange={(e) => setChosen([...e.target.selectedOptions].map((o) => o.value))} style={{ display: 'block', width: '100%', maxWidth: 420, marginTop: 4 }}>
            {collections.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button margin={false} disabled={busy} onClick={() => void plan(true)}>
            Write a plan
          </Button>
          <Button margin={false} buttonStyle="secondary" disabled={busy} onClick={() => void plan(false)}>
            Plain plan (no AI)
          </Button>
        </div>
      </section>
      {batches.map((b) => (
        <BatchCard key={b.id} batch={b} busy={busy} siteHome={siteHome} onRun={() => act(() => post(`${apiPath}/run`, { batch: b.id, seed: b.seed }))} onRemove={() => act(() => post(`${apiPath}/remove`, { batch: b.id }))} onSignIn={(collection, id) => act(async () => {
          await post(`${apiPath}/sign-in-as`, { collection, id })
          window.location.assign(siteHome)
        })} />
      ))}
    </div>
  )
}

function BatchCard({ batch, busy, onRun, onRemove, onSignIn }: { batch: Batch; busy: boolean; siteHome: string; onRun: () => void; onRemove: () => void; onSignIn: (collection: string, id: string) => void }) {
  const report = batch.report
  const plan = batch.plan
  const refused = report?.failures ?? []
  const stories = report?.personas?.length ? report.personas : (plan?.personas ?? [])
  return (
    <section style={box} aria-label={batch.name}>
      <h2 style={{ marginBottom: 4 }}>{batch.name}</h2>
      <p style={muted}>
        {batch.status}
        {plan ? ` · ${plan.source === 'ai' ? 'AI plan' : 'plain plan'}` : ''}
      </p>
      {plan?.summary && <p>{plan.summary}</p>}
      {report?.error && <p style={{ color: 'var(--theme-error-500)' }}>{report.error}</p>}
      {stories.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>People</h3>
          <ul style={{ paddingInlineStart: 18 }}>
            {stories.map((p, i) => {
              const id = 'id' in p ? (p as { id: string }).id : null
              return (
                <li key={i} style={{ marginBottom: 8 }}>
                  <strong>{p.name}</strong> {p.traits?.length ? <span style={muted}>({p.traits.join(', ')})</span> : null}
                  <br />
                  {p.story}{' '}
                  {id && (
                    <button type="button" disabled={busy} onClick={() => onSignIn(p.collection, id)} style={{ textDecoration: 'underline', background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                      Sign in as
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {batch.status === 'planned' && plan && (
        <>
          <h3 style={{ marginTop: 12 }}>Collections</h3>
          <ul style={{ paddingInlineStart: 18 }}>
            {plan.collections.map((c) => (
              <li key={c.slug}>
                {c.slug}
                {c.note ? `: ${c.note}` : ''} {c.samples && Object.keys(c.samples).length ? <span style={muted}>{`(sample wording for ${Object.keys(c.samples).join(', ')})`}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {report?.collections && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ marginTop: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={cell}>Collection</th>
                <th style={cell}>Created</th>
                <th style={cell}>Pairs covered</th>
                <th style={cell}>Refused</th>
              </tr>
            </thead>
            <tbody>
              {report.collections.map((c) => (
                <tr key={c.collection}>
                  <td style={cell}>{c.collection}</td>
                  <td style={cell}>{`${c.created} of ${c.cases}`}</td>
                  <td style={cell}>{`${c.pairs.covered} of ${c.pairs.total}`}</td>
                  <td style={cell}>{c.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {refused.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary>{`${refused.length} documents the site refused, and why`}</summary>
          <ul style={{ paddingInlineStart: 18 }}>
            {refused.slice(0, 200).map((f, i) => (
              <li key={i}>
                <strong>{f.collection}</strong>
                {`: ${f.message}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {batch.status === 'planned' && (
          <Button margin={false} disabled={busy} onClick={onRun}>
            Run this plan
          </Button>
        )}
        {batch.status !== 'running' && (
          <Button margin={false} buttonStyle="secondary" disabled={busy} onClick={onRemove}>
            {batch.status === 'planned' ? 'Discard' : 'Remove everything it made'}
          </Button>
        )}
      </div>
    </section>
  )
}
