import type { CollectionConfig, Config, Endpoint, Field, Plugin } from 'payload'

import { assertAllowed, assertConfigAllowed, markerSlug, SeedRefused } from './guard.js'
import { writePlan } from './plans.js'
import { removeSeed } from './remove.js'
import { defaultSlugs, estimateRun, MARKER, MARKER_BATCH, planSize, runSeed, SpendNeedsConfirmation } from './run.js'
import { readSettings, settingsGlobal, settingsSlug } from './settings.js'
import { signInAs, SignInRefused } from './signIn.js'
import type { SeedOptions, SeedPlan } from './types.js'

const INTERNAL = new Set(['seed-marker', 'payload-preferences', 'payload-migrations', 'payload-locked-documents', 'payload-jobs', 'payload-kv', 'payload-folders'])

/** The marker every sandbox document carries; only the sandbox itself can set it. */
const markerField = (): Field => ({
  name: MARKER,
  type: 'checkbox',
  index: true,
  access: { create: ({ req }) => Boolean((req.context as { sandbox?: unknown })?.sandbox), update: () => false },
  admin: { position: 'sidebar', readOnly: true, condition: (data) => Boolean(data?.[MARKER]), description: 'Seed: generated test data, never real.' },
})

/** Which batch made the document; only the seed itself can set it. */
const batchField = (): Field => ({
  name: MARKER_BATCH,
  type: 'text',
  index: true,
  access: { create: ({ req }) => Boolean((req.context as { sandbox?: unknown })?.sandbox), update: ({ req }) => Boolean((req.context as { sandbox?: unknown })?.sandbox) },
  admin: { hidden: true, readOnly: true },
})

/**
 * Seed: coverage-first test data for any Payload site. Install it everywhere with the
 * same options: where `allow()` is false (production) it generates nothing, hides its
 * admin, and warns at start-up if sandbox data is ever found.
 */
export const seedPlugin =
  (options: SeedOptions = {}): Plugin =>
  (config: Config): Config => {
    const slugs = defaultSlugs(options)
    const allowedNow = Boolean(options.allow?.())
    const access = async ({ req }: { req: Parameters<NonNullable<SeedOptions['access']>>[0] }) => Boolean(allowedNow && req.user && (await options.access?.(req)))
    const endpoints: Endpoint[] = [
      {
        // Writes a plan to review; nothing is generated yet. The plan is stored as a batch waiting to run.
        path: '/plan',
        method: 'post',
        handler: async (req) => {
          if (!(await access({ req }))) return Response.json({ error: 'Not allowed' }, { status: 403 })
          const body = ((await req.json?.().catch(() => ({}))) ?? {}) as { collections?: string[]; useAi?: boolean; name?: string }
          const { aiError, ...plan } = await writePlan(req.payload, options, body)
          const batch = await req.payload.create({ collection: slugs.batches as never, data: { name: body.name?.slice(0, 120) || `Plan ${new Date().toISOString().slice(0, 16)}`, status: 'planned', plan } as never, overrideAccess: true })
          return Response.json({ batch: batch.id, plan, ...(aiError ? { aiError } : {}) })
        },
      },
      {
        path: '/run',
        method: 'post',
        handler: async (req) => {
          if (!(await access({ req }))) return Response.json({ error: 'Not allowed' }, { status: 403 })
          const raw = ((await req.json?.().catch(() => ({}))) ?? {}) as { seed?: string; collections?: string[]; name?: string; batch?: string; size?: string; resume?: string; confirmSpendUSD?: unknown }
          const body = { seed: raw.seed, collections: raw.collections, name: raw.name, batch: raw.batch, size: raw.size === 'big' ? ('big' as const) : ('small' as const), resume: typeof raw.resume === 'string' ? raw.resume : undefined, confirmSpendUSD: typeof raw.confirmSpendUSD === 'number' && raw.confirmSpendUSD >= 0 ? raw.confirmSpendUSD : undefined }
          try {
            let plan: SeedPlan | undefined
            if (body.batch) {
              const doc = (await req.payload.findByID({ collection: slugs.batches as never, id: body.batch, depth: 0, overrideAccess: true })) as unknown as { status?: string; plan?: SeedPlan }
              if (doc.status !== 'planned') return Response.json({ error: 'That plan has already run.' }, { status: 409 })
              plan = doc.plan
            }
            await assertAllowed(req.payload, options)
            if (options.texts && (body.size === 'big' || body.resume)) {
              const estimate = await estimateRun(req.payload, options, { ...body, plan })
              if (estimate && estimate.worstUSD > estimate.askAboveUSD && !((body.confirmSpendUSD ?? 0) >= estimate.worstUSD))
                return Response.json({ error: new SpendNeedsConfirmation(estimate.worstUSD, estimate.expectedUSD).message, needsConfirmation: true, estimate }, { status: 409 })
            }
            if (options.defer) {
              const batch = body.resume ?? body.batch ?? String((await req.payload.create({ collection: slugs.batches as never, data: { name: body.name?.slice(0, 120) || `Seed ${new Date().toISOString().slice(0, 16)}`, status: 'running' } as never, overrideAccess: true })).id)
              await req.payload.update({ collection: slugs.batches as never, id: batch, data: { status: 'running' } as never, overrideAccess: true })
              options.defer(async () => {
                try {
                  await runSeed(req.payload, options, { ...body, batch, plan })
                } catch (e) {
                  await req.payload.update({ collection: slugs.batches as never, id: batch, data: { status: 'failed', report: { error: (e as Error).message } } as never, overrideAccess: true })
                }
              })
              return Response.json({ batch, status: 'running' }, { status: 202 })
            }
            const report = await runSeed(req.payload, options, { ...body, plan })
            return Response.json(report)
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: e instanceof SeedRefused ? 403 : 500 })
          }
        },
      },
      {
        // What a big seed would make here and now: measured, sized, nothing written.
        path: '/size',
        method: 'get',
        handler: async (req) => {
          if (!(await access({ req }))) return Response.json({ error: 'Not allowed' }, { status: 403 })
          try {
            await assertAllowed(req.payload, options)
            const settings = await readSettings(req.payload, options)
            return Response.json({ plan: await planSize(req.payload, options), settings: { targetShare: settings.targetShare, hardCap: settings.hardCap, limitMB: settings.limitMB, databases: settings.databases } })
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: e instanceof SeedRefused ? 403 : 500 })
          }
        },
      },
      {
        path: '/remove',
        method: 'post',
        handler: async (req) => {
          if (!(await access({ req }))) return Response.json({ error: 'Not allowed' }, { status: 403 })
          const body = (await req.json?.().catch(() => ({}))) as { batch?: string; collection?: string }
          return Response.json(await removeSeed(req.payload, options, body ?? {}))
        },
      },
      {
        path: '/sign-in-as',
        method: 'post',
        handler: async (req) => {
          if (!(await access({ req }))) return Response.json({ error: 'Not allowed' }, { status: 403 })
          const body = ((await req.json?.().catch(() => ({}))) ?? {}) as { collection?: string; id?: string }
          try {
            const { cookie, user } = await signInAs(req, options, String(body.collection ?? ''), String(body.id ?? ''))
            return new Response(JSON.stringify({ ok: true, user }), { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie } })
          } catch (e) {
            if (e instanceof SignInRefused) return Response.json({ error: e.message }, { status: 403 })
            throw e
          }
        },
      },
    ]
    const batches: CollectionConfig = {
      slug: slugs.batches,
      labels: { singular: 'Seed batch', plural: 'Seed batches' },
      admin: { group: 'Seed', hidden: !allowedNow, useAsTitle: 'name', defaultColumns: ['name', 'status', 'seed', 'createdAt'], description: 'Generated test data. Remove a batch to delete everything it created.' },
      access: { read: access, create: () => false, update: () => false, delete: access },
      endpoints,
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'seed', type: 'text', admin: { description: 'Same seed, same data.' } },
        { name: 'status', type: 'select', options: ['planned', 'running', 'done', 'done-with-failures', 'failed'].map((v) => ({ label: v, value: v })) },
        { name: 'selection', type: 'json' },
        { name: 'plan', type: 'json', admin: { description: 'What a run will do: wording, personas and which collections.' } },
        { name: 'report', type: 'json', admin: { description: 'Coverage per collection, and every document the site refused (with why).' } },
      ],
    }
    const records: CollectionConfig = {
      slug: slugs.records,
      labels: { singular: 'Seed record', plural: 'Seed records' },
      admin: { group: 'Seed', hidden: true },
      access: { read: access, create: () => false, update: () => false, delete: () => false },
      fields: [
        { name: 'batch', type: 'relationship', relationTo: slugs.batches as never, index: true },
        { name: 'collection', type: 'text', index: true },
        { name: 'docId', type: 'text', index: true },
        { name: 'order', type: 'number' },
      ],
    }
    // One document that says "this database is for testing" (guard check 3). Written only through
    // markTestDatabase(), never through the API; readable by whoever may seed.
    const marker: CollectionConfig = {
      slug: markerSlug(options),
      labels: { singular: 'Test-database marker', plural: 'Test-database markers' },
      admin: { group: 'Seed', hidden: true },
      access: { read: access, create: () => false, update: () => false, delete: () => false },
      fields: [
        { name: 'database', type: 'text', required: true, index: true },
        { name: 'host', type: 'text', required: true },
        { name: 'markedAt', type: 'date' },
        { name: 'markedBy', type: 'text' },
      ],
    }
    const collections = (config.collections ?? []).map((c) => (INTERNAL.has(c.slug) ? c : { ...c, fields: [...c.fields, markerField(), batchField()] }))
    const components = config.admin?.components ?? {}
    return {
      ...config,
      admin: allowedNow
        ? {
            ...config.admin,
            components: {
              ...components,
              afterNavLinks: [...(components.afterNavLinks ?? []), '@captiveorigins/payload-plugin-seed/rsc#SeedNavLink'],
              views: { ...components.views, seed: { Component: { path: '@captiveorigins/payload-plugin-seed/rsc#SeedView', serverProps: { seedAccess: options.access, seedOnly: options.only, seedHidden: [...(options.exclude ?? []), ...Object.keys(options.existing ?? {})] } }, path: '/seed' } },
            },
          }
        : config.admin,
      collections: [...collections, batches, records, marker],
      globals: [...(config.globals ?? []), settingsGlobal(settingsSlug(options), access, !allowedNow)],
      onInit: async (payload) => {
        await config.onInit?.(payload)
        // Only the configuration checks decide this: an unmarked or unreadable test-database marker
        // means "don't seed yet", not "this is production". It only logs; nothing is removed here.
        try {
          assertConfigAllowed(payload, options)
          return
        } catch {
          /* production, or a database that looks like it */
        }
        // Where seeding is refused by configuration (production), seed data must never exist.
        for (const c of collections) {
          if (INTERNAL.has(c.slug)) continue
          try {
            const { totalDocs } = await payload.count({ collection: c.slug as never, where: { [MARKER]: { equals: true } } as never, overrideAccess: true })
            if (totalDocs) payload.logger.error(`Seed data found in “${c.slug}” (${totalDocs}) where seeding is not allowed. Remove it with removeSeed().`)
          } catch {
            /* collection without a database table yet */
          }
        }
      },
    }
  }
