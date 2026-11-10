export { seedPlugin } from './plugin.js'
export { runSeed, generatable, MARKER } from './run.js'
export { removeSeed } from './remove.js'
export { assertAllowed, databaseName, isAllowed, SeedRefused } from './guard.js'
export { pairwise, pairCoverage, type Case, type Dimension } from './coverage.js'
export { assertCoveragePlan, checkCoveragePlan, draftCoveragePlan, selectMinimums, type CollectionPlan, type CoverageIssue, type CoveragePlan, type CoverageReport, type FieldPlan, type Minimum } from './coveragePlan.js'
export { creationOrder, withDependencies } from './graph.js'
export { readCollection, readFields, relationTargets, type CollectionModel, type FieldModel } from './schema.js'
export { dimensionsFor, buildDoc } from './plan.js'
export { random, type Random } from './random.js'
export { applySamples, cleanPlan, schemaSummary, writePlan } from './plans.js'
export { signInAs, SignInRefused } from './signIn.js'
export { lexical } from './values.js'
export type { AiRequest, BatchReport, CollectionReport, Failure, Persona, PersonaReport, Recipe, RecipeContext, SeedOptions, SeedPlan } from './types.js'

// Renamed from payload-plugin-sandbox in 0.3.0 (owner 2026-11-09). The old names keep working until 0.4.0.
import { seedPlugin } from './plugin.js'
import { runSeed } from './run.js'
import { removeSeed } from './remove.js'
import { SeedRefused } from './guard.js'
import type { SeedOptions, SeedPlan } from './types.js'
/** @deprecated Renamed to `seedPlugin`; the old name goes in 0.4.0. */
export const sandboxPlugin = seedPlugin
/** @deprecated Renamed to `runSeed`; the old name goes in 0.4.0. */
export const runSandbox = runSeed
/** @deprecated Renamed to `removeSeed`; the old name goes in 0.4.0. */
export const removeSandbox = removeSeed
/** @deprecated Renamed to `SeedRefused`; the old name goes in 0.4.0. */
export const SandboxRefused = SeedRefused
/** @deprecated Renamed to `SeedOptions`; the old name goes in 0.4.0. */
export type SandboxOptions = SeedOptions
/** @deprecated Renamed to `SeedPlan`; the old name goes in 0.4.0. */
export type SandboxPlan = SeedPlan
