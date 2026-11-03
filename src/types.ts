import type { Payload, PayloadRequest } from 'payload'

import type { Dimension } from './coverage.js'
import type { Random } from './random.js'

export type RecipeContext = {
  payload: Payload
  rnd: Random
  batch: string
  /** The case being built (dimension key → value). */
  case: Record<string, string>
  /** Ids already created in this batch, per collection. */
  created: (collection: string) => string[]
  /** Creates a document in this batch (registered for removal, marked as sandbox). */
  create: (collection: string, data: Record<string, unknown>, options?: { draft?: boolean }) => Promise<string | null>
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
  /** After every collection exists: link documents (shapes such as pedigrees) or add scenario documents. */
  after?: (ctx: Omit<RecipeContext, 'case'>) => Promise<void>
}

export type SandboxOptions = {
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
  recipes?: Record<string, Recipe>
  /** Domain for generated emails; never deliverable. Default example.invalid. */
  emailDomain?: string
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

export type BatchReport = {
  batch: string
  seed: string
  order: string[]
  collections: CollectionReport[]
  failures: Failure[]
  cycles: string[][]
}
