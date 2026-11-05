import { getFieldsToSign, jwtSign, type PayloadRequest } from 'payload'
import { addSessionToUser } from 'payload/shared'

import { isAllowed } from './guard.js'
import { defaultSlugs, MARKER } from './run.js'
import type { SandboxOptions } from './types.js'

const HOUR = 60 * 60

export class SignInRefused extends Error {}

/**
 * Starts a real session as a sandbox account, so a tester can follow a persona's story.
 * Only for accounts this sandbox made (marked and in its register), only by someone
 * `access` lets in, and never where the sandbox is refused. Real accounts are out of reach.
 */
export async function signInAs(req: PayloadRequest, options: SandboxOptions, collection: string, id: string): Promise<{ cookie: string; user: { id: string; email: string } }> {
  const { payload } = req
  if (!isAllowed(payload, options)) throw new SignInRefused('The sandbox is not allowed in this environment.')
  const slugs = defaultSlugs(options)
  const registered = await payload.count({ collection: slugs.records as never, where: { and: [{ collection: { equals: collection } }, { docId: { equals: id } }] } as never, overrideAccess: true })
  if (!registered.totalDocs) throw new SignInRefused('Only sandbox accounts can be signed in to.')
  const cfg = payload.collections[collection as never]?.config
  if (!cfg?.auth) throw new SignInRefused('That collection has no accounts.')
  const target = (await payload.findByID({ collection: collection as never, id, depth: 0, overrideAccess: true, showHiddenFields: true, disableErrors: true })) as unknown as Record<string, unknown> | null
  if (!target || target[MARKER] !== true) throw new SignInRefused('Only sandbox accounts can be signed in to.')
  const { sid } = await addSessionToUser({ collectionConfig: cfg, payload, req, user: target as never })
  const seconds = Math.min(cfg.auth.tokenExpiration ?? HOUR, 8 * HOUR)
  const { token } = await jwtSign({ fieldsToSign: getFieldsToSign({ collectionConfig: cfg, email: String(target.email ?? ''), sid, user: target as never }), secret: payload.secret, tokenExpiration: seconds })
  const secure = cfg.auth.cookies?.secure ? '; Secure' : ''
  const sameSite = typeof cfg.auth.cookies?.sameSite === 'string' ? cfg.auth.cookies.sameSite : 'Lax'
  const domain = cfg.auth.cookies?.domain ? `; Domain=${cfg.auth.cookies.domain}` : ''
  return { cookie: `${payload.config.cookiePrefix}-token=${token}; Path=/; HttpOnly; Max-Age=${seconds}; SameSite=${sameSite}${secure}${domain}`, user: { id, email: String(target.email ?? '') } }
}
