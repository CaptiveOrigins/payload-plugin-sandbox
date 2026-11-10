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
  /**
   * This run's counts, sized to the cluster in a big seed (empty in a small one). Kinds that aren't
   * collections can be sized too (for example "how many stories a recipe tells"): give them a count
   * rule and a size per record in the settings, and read the result here.
   */
  counts: Record<string, number>
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

/** One record's text to write: what it is (in words, from values code chose) and which fields. */
export type TextJob = {
  /** `collection:index`, stable for a seed. */
  key: string
  collection: string
  /** Language code to write in. */
  language: string
  describe: string
  fields: { path: string; type: 'text' | 'textarea' | 'richText'; maxLength?: number }[]
}

/** The settings a text source needs. */
export type TextSettings = { models: { plan: string; fill: string }; spend: { capUSD: number; askAboveUSD: number } }

/** What writing the text would cost: the most it can (every request at its output limit) and what's likely. */
export type TextEstimate = { requests: number; worstUSD: number; expectedUSD: number; cached: number; pricesAsOf?: string }

/**
 * Writes text for many records at once; returns values by job key and field path, and optionally a
 * report (cost, failures) kept on the batch. Missing values keep word-list text.
 */
export type TextSource = ((jobs: TextJob[], run: { seed: string; settings: TextSettings }) => Promise<Map<string, Record<string, string>> | { texts: Map<string, Record<string, string>>; report?: Record<string, unknown> }>) & {
  /** Optional: what it would cost, before anything is written or spent. */
  estimate?: (jobs: TextJob[], settings: TextSettings) => Promise<TextEstimate> | TextEstimate
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
  /**
   * Documents a removal never deletes, even when marked: per collection, a `where`
   * (for example administrators and service accounts). Matches are reported as kept.
   */
  keep?: Record<string, Where>
  /**
   * Throws if outgoing effects (email, webhooks, payments) are on in this environment. When given,
   * seeding refuses to run while it throws: switching effects off in `around` isn't proof they're off.
   */
  assertQuiet?: () => void | Promise<void>
  /** Defaults for the `seed-settings` global (counts, sizing, models, spend). Admins override them in the admin. */
  defaults?: Partial<import('./settings.js').SeedSettings>
  /**
   * Writes the text on records in big seeds (for example `claudeTexts()`). Small seeds always use
   * word lists, so CI stays free and deterministic.
   */
  texts?: TextSource
  /** Documents created at once in big seeds (default 4, at most 16). Coverage cases are always one at a time. */
  concurrency?: number
  /**
   * The site's coverage plan (`checkCoveragePlan`): when given, the realism audit also checks every
   * select value reached its minimum in what was really made.
   */
  coveragePlan?: import('./coveragePlan.js').CoveragePlan
  /** Run the realism audit after each run (default true). It only reads. */
  audit?: boolean
  /** Slugs of the plugin's collections. */
  slugs?: { batches?: string; records?: string; marker?: string; settings?: string }
}

export type Failure = { collection: string; case?: Record<string, string>; message: string }

export type CollectionReport = {
  collection: string
  created: number
  cases: number
  dimensions: number
  pairs: { covered: number; total: number }
  failures: number
  /** Documents of this collection in the batch after the run (resumed runs included). */
  total?: number
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
  /** Big seeds: how the counts were sized to the cluster. */
  sizing?: import('./sizing.js').SizePlan
  counts?: Record<string, number>
  /** Records whose text was requested from the text source, and written by it. */
  texts?: { requested: number; written: number } & Record<string, unknown>
  progress?: { done: string[]; made: Record<string, number> }
  /** What the realism audit found (design note section 10). */
  realism?: import('./realism.js').RealismReport
}
