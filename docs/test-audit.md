# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

## 2026-11-10: first audit

Suite before: 82 tests. After: 94 tests (`npx vitest run`; the integration file needs the local MongoDB test container on 127.0.0.1:27018, or `MONGODB_URL`). No `docs/decisions.md` yet, so the promises come from the README, `CHANGELOG.md` and code comments. The guard and the markers come first: Seed must never write to production and must only ever remove what it marked.

Files: `core` = `test/core.test.ts`, `int` = `test/integration.test.ts`, `claude`, `plan` = `coveragePlan`, `sizing`, `settings`.

### Never in production (the guard)

| Promise | Test |
| --- | --- |
| Check 1: `allow()` is required; missing, false or not truthy refuses | core › guard › refuses without allow(); guard edges › reads production in any case… (allow returning undefined); int › refuses to run where it is not allowed |
| Check 2: the database name must be readable (URL, adapter name, Postgres pool) and must not contain "prod" in any case; only the exact name in `allowDatabases` is exempt | core › guard › refuses without allow()…; guard edges › reads production in any case… |
| Check 3: a test-database marker for this name and this host; missing, unreadable, other name or other host refuses; a restored copy is refused | core › guard › refuses when the marker can't be read…; int › refuses a database whose marker was written on another host |
| An unreadable host refuses, before any marker is read | guard edges › refuses when the host can't be read |
| The first checks fail before the database is read | core › guard › refuses before reading the database |
| `assertQuiet` that throws or rejects refuses | core › guard › refuses when the marker…; guard edges › refuses when assertQuiet rejects asynchronously; int › refuses while outgoing effects are on |
| `isAllowed` is false for every refusal | guard edges › … isAllowed says no for every refusal |
| `markTestDatabase` refuses production, `allow()` false, an unreadable host and a name not typed exactly; writes nothing then; marks once; can't be written through the API | guard edges › never marks production…; int › marks a test database only when the name is typed |
| Host read without credentials, same for any host order | core › guard › reads the host without credentials |
| Where configuration refuses, start-up logs marked data and removes nothing; an unmarked test database isn't reported | int › doesn't report seed data as misplaced… |
| Admin area hidden where not allowed | core › guard › adds the marker… hides its admin; int › offers the admin area only where allowed |

### Who may use it (access, refusals)

| Promise | Test |
| --- | --- |
| Every endpoint (`/plan`, `/run`, `/size`, `/remove`, `/sign-in-as`) refuses with 403, before touching the database, with no user, no `access`, `access` false, or `allow()` false or missing | who may use the seed › refuses every endpoint… |
| `/run` and `/size` refuse with 403 on a production-looking database, even for an allowed admin | who may use the seed › refuses run and size with 403… |
| The seed's own collections and settings global are readable only by people `access` lets in, where allowed; batches, records and markers can't be created or updated through the API; records and markers can't be deleted through it | who may use the seed › opens its own collections and settings only… |
| "Sign in as" only for accounts the seed made (marked and in a batch or the register), only where allowed | int › signs in as sandbox accounts only…; only the seed marks › refuses to sign in to a collection without accounts, a missing account, or a marked account no batch made |

### Markers and removal (never touch real data)

| Promise | Test |
| --- | --- |
| Every generated document carries the marker and its batch | int › creates every collection…; the batch id on the marker › writes no register documents… |
| Only the seed can set the marker or batch id; nobody can change the marker (field access) | who may use the seed › lets only the seed set the marker and batch id |
| The same, through the real API: a signed-in person's `sandbox`/`sandboxBatch` are ignored on create and update | only the seed marks › ignores the marker and batch id when a signed-in person sends them |
| Removal deletes everything a batch made and nothing else; one batch never touches another | int › removes everything it created, and nothing else; … removes one batch without touching another |
| An unmarked record carrying a batch id is never removed, one at a time or in bulk | only the seed marks › never removes an unmarked record that carries a batch id |
| Register rows delete only documents still marked; bad rows reported (`notSeeded`), gone ones dropped, unreadable ones kept (`failed`) | int › never deletes a document a register row points at…; counts draft-only seeded documents… |
| `keep` is never deleted, even when marked, and the batch is kept | int › never deletes what the site keeps… |
| `bulkRemove` removes only this batch's marked records; refused at start-up for versioned or unknown collections; a kept collection falls back to one at a time | int › bulk removal; core › bulk removal settings; only the seed marks › removes a kept collection one at a time… |
| Removal order: reverse of what batches did, then the schema | core › removal order; int › creates every collection in order |
| Removal ends when a delete always says "not found"; recipe-made documents adopted with `ctx.track` are removed | int › ends even when a delete…; adopts a document a recipe made |

### Money (Claude text and the spend cap)

| Promise | Test |
| --- | --- |
| The worst case never passes `capUSD`, including the cache-write premium | claude › never lets the worst case pass the spend cap; counts the cache-write premium… |
| Above `askAboveUSD` the run stops before writing anything until the amount is confirmed (19.99 for 20.00 refuses) | int › asking before spending |
| An unknown model is refused, never treated as free; cached text costs nothing | claude › refuses a model it has no price for; pays nothing for text it already has |
| Worst case above likely case | claude › estimates the worst case above the likely one |
| Without a key, nothing is sent; small seeds never call the text source | claude › without a key…; int › small seeds never call the site's text source |

### Data that could leak

| Promise | Test |
| --- | --- |
| Only descriptions of records are sent, never ids, documents or keys | claude › sends only descriptions of records; int › writes text from a text source… never ids |
| AI plans see the schema's shape, never documents, and are checked against the schema | int › an AI plan is checked, then used |
| Emails on `example.invalid`; content rules drop placeholder text, seed markers, outside domains, blocked words | int › creates every collection… (email); claude › drops values that break the content rules; cleaning one value; int › the realism audit |

### Sizing (refuses before writing)

| Promise | Test |
| --- | --- |
| Refuses, loading nothing, when minimums don't fit; never past the hard cap; fails closed on bad input | sizing › refuses…; never projects past the hard cap; fails closed on bad input; int › sizes counts… and refuses before writing |
| A database it can't measure is an error, never 0 | int › measuring the cluster |
| Resume measures again and refuses if the rest no longer fits | int › measures again before carrying on… |

Coverage, pairwise cases, plans, coverage plans in CI, settings, realism, retries and the rename are covered by the existing tests in `core`, `plan`, `settings`, `sizing` and `int`; they hold no access or data-loss rule, so this audit lists them without remapping each one.

### Gaps added (with their tests)

- Every endpoint refusing (5 endpoints x 5 cases) before the database is touched: core › who may use the seed › refuses every endpoint….
- `/run` and `/size` refusing a production-looking database with 403: core › refuses run and size with 403….
- Access on the seed's own collections and settings global: core › opens its own collections and settings only….
- Field access on the marker and batch id: core › lets only the seed set the marker and batch id.
- The guard's edges (case, adapter name, Postgres pools, exact `allowDatabases`, unreadable URL and host, async `assertQuiet`, `isAllowed`): core › guard edges (3 tests).
- `markTestDatabase` refusals that write nothing: core › never marks production….
- API attempts to set or clear the marker: int › ignores the marker and batch id….
- Unmarked records carrying a batch id, both removal paths: int › never removes an unmarked record….
- `bulkRemove` with `keep`: int › removes a kept collection one at a time….
- "Sign in as" refusals (no accounts, missing account, marked without a batch): int › refuses to sign in to….

### Gaps skipped (with why)

- Payload enforcing field and collection access itself: framework internals. The new integration test proves it once for the marker, through the real API.
- Every helper in `values.ts`, `random.ts`, `png.ts`: covered by the run tests that use them; separate tests would repeat them.
- The admin screens (`src/client`, `src/rsc`): presentation; the decisions they show come from endpoints tested above.
- `markedBy` trimmed to 120 characters, labels, default slugs: trivial.

### For the lead

- `/plan` checks `access` and `allow()` but not the database checks (name, marker), so an allowed admin can store a planned batch on an unmarked database. It writes no seed data, only a batch with status `planned`; decide whether it should call `assertAllowed` too.
- Field access on the marker relies on `overrideAccess: false`. Any server code calling the Local API with `overrideAccess: true` (Payload's default) can set `sandbox: true`, and such a record would then be removable. Worth a sentence in the README, or a hook that checks `req.context` regardless of `overrideAccess`. Bigger than a test.
- The `/run` endpoint's spend confirmation (`confirmSpendUSD` ignored when negative or not a number) has no endpoint-level test; `runSeed` enforces the same rule and is tested, so the risk is low. An endpoint test needs a real Payload with a text source.
- `onInit` reporting is tested with users only; a test across several collections, including one without a table yet, needs the integration setup.
