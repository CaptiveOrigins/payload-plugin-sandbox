import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import { SeedPanel } from '../client/SeedPanel.js'

type Props = AdminViewServerProps & { seedAccess?: (req: PayloadRequest) => boolean | Promise<boolean>; seedOnly?: string[]; seedHidden?: string[] }

const INTERNAL = /^(payload-|sandbox-)/

/** The Seed area (/admin/seed): plan, run, read the coverage, sign in as a persona, remove. */
export async function SeedView({ initPageResult, params, searchParams, seedAccess, seedOnly, seedHidden }: Props) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const { payload } = req
  const allowed = Boolean(req.user && (await seedAccess?.(req)))
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)' }}>
        <h1>Seed</h1>
        {allowed ? (
          <SeedPanel
            apiPath={`${payload.config.routes.api}/sandbox-batches`}
            batchesPath={`${payload.config.routes.api}/sandbox-batches`}
            siteHome="/"
            collections={payload.config.collections.map((c) => c.slug).filter((s) => !INTERNAL.test(s) && !seedHidden?.includes(s) && (!seedOnly || seedOnly.includes(s))).sort()}
          />
        ) : (
          <p>You don’t have access to Seed.</p>
        )}
      </div>
    </DefaultTemplate>
  )
}

/** Admin menu link, for people Seed lets in. Link only: the view checks access again. */
export function SeedNavLink({ payload }: { payload: Payload }) {
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/seed`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }}>
      <span className="nav__link-label">Seed</span>
    </a>
  )
}
