# Changelog

## Not released yet

- **Register rows are checked before a delete** (security review S1): removal through the older register deletes a document only if it still carries the seed's marker. A row pointing at an unmarked document is skipped, listed under `notSeeded`, and left for a person to look at; one pointing at a document that's gone is dropped.
- **`ctx.counts` in recipes:** the run's counts, sized to the cluster in a big seed. Kinds that aren't collections can be sized and read too ("how many stories to tell").
- **Read-only links order creation:** a relationship shown read-only in the admin (a membership's account) is never filled, but now counts for the order collections are made in. Before, such a collection could be made before what it points at, and every record came out empty.
- **Realism audit** after every run (`auditBatch`, `report.realism`): repeated long text, distinct names, placeholder text, seed markers, emails and links outside example domains, and, with `coveragePlan`, select values below their minimum. It only reads; problems mark the run `done-with-problems` and show in the admin.

## 0.4.0 (2026-11-10)

The first version published under this name. 0.3.0 below was prepared but never published (npm refused it after an earlier staging attempt), so anyone coming from `@captiveorigins/payload-plugin-sandbox` 0.2.x moves straight to 0.4.0.

- **The batch id lives on each seeded document** (`sandboxBatch`, beside the `sandbox` marker) instead of one `sandbox-records` document per record. That saves about 0.4 KB per record, which matters on small database tiers.
  - The default `register` is now `marker`. Set `register: 'records'` to keep the old register.
  - Batches made either way can still be removed, and "Sign in as" accepts accounts seeded either way.
- **Removal** works in reverse dependency order, newest first within a collection, one document at a time with hooks on. It never repeats a document it couldn't delete.
- **`keep`:** per collection, a `where` naming documents a removal never deletes, even when marked. Matches are reported as kept.
- **`ctx.track(collection, id)`:** adopts documents a recipe creates itself into the batch.
- **A coverage plan check for CI:**
  - `checkCoveragePlan`, `assertCoveragePlan`, `draftCoveragePlan` and `selectMinimums`.
  - It covers collections, fields, select values, relationships and globals.
  - It fails on missing reasons (and "TODO" placeholders) and on minimums a plan can never reach.
  - A field can set its own minimum, with a reason (`minimum`), for long lists such as countries.
- **A stricter guard.** Seeding now needs three checks to pass, each failing closed:
  - `allow()`;
  - a readable database name that doesn't look like production (an unreadable name used to pass, and is now refused);
  - a test-database marker for this database name and host, written once by a person with `markTestDatabase()`. It lives in a new collection, `seed-marker`, that the API can't write.
  - `assertQuiet`: optional; seeding refuses while it throws.
  - `assertAllowed` and `isAllowed` are now async. `assertConfigAllowed` keeps the first two checks, synchronous.
- **Auto-sizing:** `measureCluster`, `planCounts`, `calibrate` and `sizeStatus` fill a cluster up to a share of its limit, shrinking bulk kinds first and refusing when the minimums don't fit.
- **Big seeds:** `runSeed(..., { size: 'big' })` makes the coverage cases, then more records up to the counts in a new `seed-settings` global, sized to the cluster first (refusing before writing when they don't fit). Also `counts` (exact), `resume` (carry on an interrupted batch) and `texts` (a text source for what people read; big seeds only). The admin gets a size choice, "Check what fits", progress and "Carry on where it stopped".
- **Claude writes the text** in big seeds: `claudeTexts()` (Message Batches, structured output, cached system prompt, a hard spend cap by worst case, one retry, content checks, word-list fallback), `fileTextCache`/`memoryTextCache`, `estimateRun()` and `SpendNeedsConfirmation`. The admin asks before spending above `spend.askAboveUSD`, naming the amount. Prices as of 2026-11-10. `@anthropic-ai/sdk` is an optional peer dependency.
- **Clashing writes are retried:** a create or update that hits a write conflict (two records updating one parent at once) is retried up to four times before it's reported.
- **Unique values carry a batch tag** (emails are now `seed+<tag><n>@example.invalid`), so separate batches never collide.
- **Coverage plans** skip the seed's own globals.
- **Removed:** the `sandboxPlugin`, `runSandbox`, `removeSandbox`, `SandboxRefused`, `SandboxOptions` and `SandboxPlan` aliases, and the component aliases `SandboxPanel` (`/client`), `SandboxView` and `SandboxNavLink` (`/rsc`), all deprecated in 0.3.0. Use the `Seed` names.

**Upgrading:** mark each test database once with `markTestDatabase()` before seeding it again. Await `assertAllowed` and `isAllowed`. Build the new `sandboxBatch` index wherever your database doesn't build indexes automatically (for example a script you run after migrations). Stored names are unchanged (`sandbox-batches`, `sandbox-records`, the `sandbox` marker).

## 0.3.0 (never published)

- Renamed from `@captiveorigins/payload-plugin-sandbox` to `@captiveorigins/payload-plugin-seed`. Exports, the admin area (`/admin/seed`) and wording say Seed; old export names kept as deprecated aliases until 0.4.0. Stored names unchanged.
