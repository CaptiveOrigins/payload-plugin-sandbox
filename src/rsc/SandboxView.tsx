import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import { SandboxPanel } from '../client/SandboxPanel.js'

type Props = AdminViewServerProps & { sandboxAccess?: (req: PayloadRequest) => boolean | Promise<boolean>; sandboxOnly?: string[]; sandboxHidden?: string[] }

const INTERNAL = /^(payload-|sandbox-)/

/** The Sandbox area (/admin/sandbox): plan, run, read the coverage, sign in as a persona, remove. */
export async function SandboxView({ initPageResult, params, searchParams, sandboxAccess, sandboxOnly, sandboxHidden }: Props) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const { payload } = req
  const allowed = Boolean(req.user && (await sandboxAccess?.(req)))
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)' }}>
        <h1>Sandbox</h1>
        {allowed ? (
          <SandboxPanel
            apiPath={`${payload.config.routes.api}/sandbox-batches`}
            batchesPath={`${payload.config.routes.api}/sandbox-batches`}
            siteHome="/"
            collections={payload.config.collections.map((c) => c.slug).filter((s) => !INTERNAL.test(s) && !sandboxHidden?.includes(s) && (!sandboxOnly || sandboxOnly.includes(s))).sort()}
          />
        ) : (
          <p>You don’t have access to the sandbox.</p>
        )}
      </div>
    </DefaultTemplate>
  )
}

/** Admin menu link, for people the sandbox lets in. Link only: the view checks access again. */
export function SandboxNavLink({ payload }: { payload: Payload }) {
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/sandbox`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }}>
      <span className="nav__link-label">Sandbox</span>
    </a>
  )
}
