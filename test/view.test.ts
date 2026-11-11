import { describe, expect, it, vi } from 'vitest'

// Payload's admin shell and the client panel are stubbed: this checks the view's decision, not its rendering.
vi.mock('@payloadcms/next/templates', () => ({ DefaultTemplate: ({ children }: { children: unknown }) => children }))
vi.mock('../src/client/SeedPanel.js', () => ({ SeedPanel: () => null }))

const { SeedView } = await import('../src/rsc/SeedView.js')
const { SeedPanel } = await import('../src/client/SeedPanel.js')

type El = { type?: unknown; props?: { children?: unknown } }
/** Every element type in a React element tree. */
const types = (node: unknown): unknown[] => {
  if (Array.isArray(node)) return node.flatMap(types)
  if (!node || typeof node !== 'object') return []
  const el = node as El
  return [el.type, ...types(el.props?.children)]
}
const view = (seedAccess: unknown, user: unknown = { id: 'u' }) =>
  SeedView({
    initPageResult: { req: { user, payload: { config: { routes: { api: '/api' }, collections: [] } }, i18n: {} }, permissions: {}, visibleEntities: {}, locale: undefined },
    params: {},
    searchParams: {},
    seedAccess,
  } as never)

describe('the Seed admin view (test audit 2026-11-11)', () => {
  it('shows the panel only when access answers exactly true, and the refusal for anything else, a throw included', async () => {
    const answers: [string, () => unknown][] = [
      ["'false'", () => 'false'],
      ['1', () => 1],
      ['an object', () => ({})],
      ['a thrown error', () => {
        throw new Error('roles store down')
      }],
      ['a rejected promise', async () => {
        throw new Error('roles store down')
      }],
    ]
    for (const [what, answer] of answers) expect(types(await view(answer)), what).not.toContain(SeedPanel)
    expect(types(await view(() => true, null))).not.toContain(SeedPanel)
    expect(types(await view(undefined))).not.toContain(SeedPanel)
    expect(types(await view(async () => true))).toContain(SeedPanel)
  })
})
