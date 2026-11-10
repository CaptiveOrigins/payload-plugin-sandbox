import type { Payload, PayloadRequest, Where } from 'payload'

import type { Dimension } from './coverage.js'
import type { Random } from './random.js'

export type RecipeContext = {
  payload: Payload
  rnd: Random
  batch: string
  /** The case being built (dimension key → value). */
  case: Record<string, string>
  /** When this document is a persona's account: who they are. */
  persona?: Persona
  /** Ids already created in this batch, per collection. */
  created: (collection: string) => string[]
  /** Creates a document in this batch (registered for removal, marked as sandbox). */
  create: (collection: string, data: Record<string, unknown>, options?: { draft?: boolean }) => Promise<string | null>
  /** Adds a document the recipe created itself (with the marker set) to this batch, so removal takes it too. */
  track: (collection: string, id: string) => Promise<void>
  /** Updates a document created in this batch. */
  update: (collection: string, id: string, data: Record<string, unknown>) => Promise<void>
}

/**
 * Site-specific rules for one collection (optional: everything works without recipes).
 * Use them for rules that live in code rather than in the schema.
 */
export type Recipe = {
  /** Never generate this collection. */
  skip?: boolean
  /** Adjust coverage dimensions (add scenario dimensions, drop noisy ones). */
  dimensions?: (dimensions: Dimension[]) => Dimension[]
  /** Most documents to generate from coverage cases (default 40). */
  maxCases?: number
  /** Change a generated document before it is created; return null to skip the case. */
  prepare?: (data: Record<string, unknown>, ctx: RecipeContext) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  /** Optional links the sandbox shouldn't fill in by itself, because they must agree with something else (link them in `after`). */
  noLinks?: string[]
  /** After every collection exists: link documents (shapes such as pedigrees) or add scenario documents. */
  after?: (ctx: Omit<RecipeContext, 'case'>) => Promise<void>
}

/** A fictional person to sign in as, with a story of what to try. */
export type Persona = {
  /** The account collection. */
  collection: string
  name: string
  story: string
  /** Short tags a recipe can turn into roles or settings. */
  traits?: string[]
  /** Exact field values (site-written personas only; AI plans can't set these). */
  data?: Record<string, unknown>
}

/** What a run will do, reviewed before it starts. Plain data. */
export type SeedPlan = {
  source: 'ai' | 'plain'
  summary: string
  collections: { slug: string; note?: string; samples?: Record<string, string[]> }[]
  personas: Persona[]
}

export type AiRequest = { system: string; prompt: string; schema: Record<string, unknown> }

export type SeedOptions = {
  /**
   * Where the sandbox may run. Required: without it, or when it returns false, the
   * plugin only refuses sandbox data (install it the same way in production).
   */
  allow?: () => boolean
  /** Database names allowed even though they look like production (/prod/i). Default none. */
  allowDatabases?: string[]
  /** Who may plan, run and remove sandboxes (default: nobody). */
  access?: (req: PayloadRequest) => boolean | Promise<boolean>
  /** Collections never generated (in addition to the plugin's own). */
  exclude?: string[]
  /** Generate only these (what they need must be here or in `existing`). */
  only?: string[]
  /** Collections to refer to rather than generate: documents you already have (your site, your taxonomy). */
  existing?: Record<string, { where?: Where; limit?: number }>
  /** Wraps every run and removal, e.g. to switch off outgoing email while it works. */
  around?: <T>(task: () => Promise<T>) => Promise<T>
  recipes?: Record<string, Recipe>
  /** Your site's fictional people to sign in as (added to any AI plan's). */
  personas?: Persona[]
  /** One or two sentences about the site, for AI plans. */
  about?: string
  /**
   * Optional AI that writes plans: gets a system prompt, the schema (never documents) and a
   * JSON schema, returns JSON. Bring your own model and key. Without it, generation is plain.
   */
  ai?: (request: AiRequest) => Promise<unknown>
  /** Runs work after the response (Next.js: `after`), so the admin doesn't wait. Default: the admin waits. */
  defer?: (task: () => Promise<void>) => void
  /** Domain for generated emails; never deliverable. Default example.invalid. */
  emailDomain?: string
  /**
   * How a batch remembers its documents. `marker` (default since 0.4.0): the batch id sits on each document, which
   * costs a few bytes instead of a register document per record. `records`: one register document per record, as before.
   * Batches made either way can always be removed.
   */
  register?: 'marker' | 'records'
  /** Slugs of the plugin's collections. */
  slugs?: { batches?: string; records?: string }
}

export type Failure = { collection: string; case?: Record<string, string>; message: string }

export type CollectionReport = {
  collection: string
  created: number
  cases: number
  dimensions: number
  pairs: { covered: number; total: number }
  failures: number
}

export type PersonaReport = Persona & { id: string; email: string }

export type BatchReport = {
  batch: string
  seed: string
  personas?: PersonaReport[]
  order: string[]
  collections: CollectionReport[]
  failures: Failure[]
  cycles: string[][]
}
