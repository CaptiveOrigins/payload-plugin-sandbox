# Design note: writing seed data with Claude

Draft, 2026-11-09, for review. Nothing here is built. This is how the plugin turns from "coverage-first test data" into **Seed for Payload: realistic test data at scale, written with Claude**. The rename itself is done in 0.3.0 (`payload-plugin-seed`, `seedPlugin`, `/admin/seed`); stored names (`sandbox-batches`, `sandbox-records`, the `sandbox` marker) stay, so earlier batches remain removable.

What 0.2.1 already does, and keeps doing: reads the schema, fills collections in dependency order with pairwise coverage, writes through Payload's Local API so the site's own rules run, registers every document for removal, marks every document, refuses production, and offers "Sign in as" for generated accounts. What it lacks: scale (it makes tens of records, not tens of thousands), human-sounding text at that scale, and a way to keep a test site full on a schedule.

## 1. The split: code decides, Claude writes

Code decides everything that has to be right: how many records, who owns what, relationships, dates, select values, which edge cases appear. It does this from a fixed random seed, so the same seed gives the same structure every time.

Claude writes the parts people read: names, bios, notes, messages, posts, place-appropriate wording, the occasional typo. It never decides structure, and nothing it returns is written without being checked (section 5).

Two jobs, two models:

| Job | When | Model (default) | Why |
| --- | --- | --- | --- |
| **Plan**: the world, its personas and their stories | Once per world, reviewed before anything runs | the capable model, Claude Opus 5.5 (`claude-opus-5-5`) | Few calls, judgment matters |
| **Fill**: the text on each record | In bulk, through the Message Batches API | the fast model, Claude Haiku 5.5 (`claude-haiku-5-5`) | Many calls, half price in batches |

Model ids are settings, not code. The admin lists what the key can use (Models API) and warns if a chosen id is retired. Prices come from a small table in the plugin, dated, that the cost estimate names ("prices as of 2026-11-09"); a release updates it. Checked 2026-11-09: Opus 5.5 $4 / $20 per million tokens in and out, Haiku 5.5 $0.10 / $0.50 (prompts up to 100K tokens), batches half of that. Re-check against Anthropic's pricing page before release.

## 2. Settings in the admin

Rules live in a global, `seed-settings`, shown in the admin's Seed area to whoever `access` allows, and only where `allow()` is true. The site's code supplies defaults (`seedPlugin({ defaults })`); the global stores only what an admin changed, so a code update to a default reaches every site that didn't override it. A "Reset to the site's default" button sits beside each changed setting.

```ts
type SeedSettings = {
  size: 'small' | 'big' | 'custom'
  seed: string                         // same seed, same world
  counts: Record<string, { ceiling: number; minimum: number; bulk?: boolean }>  // auto-sized between these
  targetShare: number                  // fill the cluster up to this share of its limit (default 0.8)
  distributions: Record<string, Distribution>  // e.g. animals per keeper: long tail, median 2
  personas: PersonaRule[]              // types of account, their share, their stories
  languages: { code: string; share: number }[]
  mess: { typoRate: number; missingOptional: number; duplicates: number }
  models: { plan: string; fill: string; effort: { plan: Effort; fill: Effort } }
  spend: { capUSD: number; askAboveUSD: number }   // hard cap; ask again above this
  images: { strategy: 'shared'; pool: string[] }   // media ids to reuse
  prodGuard: { databasePattern: string; markerCollection: string }  // see section 7
  skip: { path: string; reason: string }[]         // coverage exceptions, each with a reason
}
```

Everything here is plain data the admin can read and change. The site's recipes (code) stay for rules that can't be data: "an animal's owner is its group's owner".

## 3. The API key

- The site sets `ANTHROPIC_API_KEY` (or names another variable with `apiKeyEnv`). The plugin reads it on the server when a call is made.
- It's never stored in the database, never sent to the browser, never logged, and never written into a report or an error message. The admin shows only "Key found" or "No key", and which models it can use.
- Without a key, the plugin still works: it plans and fills from its own word lists, as 0.2.1 does, and says so on the run's page.
- The key is never read where `allow()` is false.

## 4. Batching and the text cache

Fill requests are grouped by collection and language: one request asks for the text of up to 50 records, described by their structure only (for example "female, hatched 2019, red-footed tortoise, kept outdoors in Texas, keeper is a mid-size breeder writing in Spanish"). No real data from the site is ever in a request.

- **Batches:** fill requests go through the Message Batches API (up to 100,000 requests or 256 MB per batch, usually done within an hour, at most 24 hours, results kept 29 days). The run waits, shows progress, and can be left: the batch id is stored on the run, and a later visit picks up the results.
- **Structured output:** each request asks for JSON against a schema built from the collection's fields (`output_config.format`), so the answer has a known shape before validation.
- **Prompt caching:** the system prompt and the world plan go first and are marked for caching, so thousands of requests pay for them once.
- **A text cache that survives reloads:** every answer is stored by a key made from the seed, the record's structure, the prompt version and the model. A reload with the same seed and prompt pays nothing for text it already has. Changing a prompt or model invalidates only what it touches. The cache lives in a plugin collection, `seed-texts`, and is removable on its own.
- **Refusals and failures:** a request that comes back refused, errored or expired is retried once outside the batch; if it fails again those records fall back to word-list text and the report counts them. A run never stalls on one bad answer.

## 5. Validation before anything is written

Claude proposes, code checks. In order:

1. **Shape:** the answer parses and matches the request's schema.
2. **Schema:** every value fits its field: type, required, min and max, length, select options, `hasMany`, unique. Unknown keys are dropped.
3. **Structure stays code's:** Claude's answer can't change an id, a relationship, a date, a count or a select value that code chose. Those fields aren't in the request schema at all.
4. **Site rules:** the record goes through Payload's Local API with hooks and validation on. What the site refuses is reported with its reason, as now.
5. **Content rules:** no lorem, no "Seed:" or "Sandbox:" markers in visible text, no real email domains, no URLs outside `example.com`/`example.org`/`.invalid`, no names from a block list (offensive words, well-known real people). A failing value is replaced, and the report counts it.

## 6. Cost: shown first, capped always

- Before a run, the admin shows an estimate: tokens in and out per model, cache savings, batch discount, the dollar total, the date of the price table, and how much text is already cached (free). Measured with the token-counting endpoint on a sample of real requests, then scaled.
- Nothing runs until an admin presses Run on that estimate.
- `spend.capUSD` is a hard cap: the plugin counts actual usage from every response and stops sending requests when the next one could cross it. Records it couldn't fill get word-list text. The report says the cap was reached.
- `spend.askAboveUSD`: any estimate above this needs a second confirmation that names the amount.
- Every run records its real cost per model.

Rough sense of scale, my estimate for a site of 2,000 accounts and 20,000 main records with library text: a few million output tokens through Haiku batches and one planning conversation on Opus, so a few dollars for a full world, and close to nothing for a reload. The real estimate replaces this before anyone pays.

## 7. Never in production

Three independent checks. Every one must pass, and each fails closed: if a check can't tell, the answer is no.

1. **The site says so:** `allow()` returns true (unchanged from 0.2.1).
2. **The database doesn't look like production:** its name doesn't match `prodGuard.databasePattern` (default `/prod/i`), unless listed in `allowDatabases` (unchanged). A database name that can't be read now counts as a refusal, where 0.2.1 let it through.
3. **The database says it's a test database:** a marker document in a plugin collection (`seed-marker`), written once by a person with `markTestDatabase()`, which asks them to type the database name (built 2026-11-10; sites wrap it in their own command). A copy of a test database restored elsewhere carries the marker, so the marker also records the **database name and the cluster host** it was written for, and both must match. A dump restored under the same name on another cluster is refused. Marking itself refuses when check 1 or 2 fails.

A refusal names which check failed. Where the plugin is refused, it reads no key, shows no admin, and at start-up logs an error if any marked record exists (unchanged).

Side effects are off for every run through the site's `around` wrapper (email, webhooks, payments, label purchases). It isn't enough to switch them off: a site can supply `assertQuiet()`, which throws if outgoing effects are enabled in this environment, and the plugin refuses to run when it throws. Generated emails use `@example.invalid`. Records that a provider would normally create (payments, labels, external syncs) are written directly with ids that can't exist, never through the code path that calls the provider.

**Removing only what the seed made.** A wipe removes a record only when it carries the marker and is in the register; the plugin never deletes a collection wholesale. Sites can name accounts that are never touched (`keep: { users: where }`, for example administrators and service accounts), and a wipe refuses to delete them even if marked. Hand-made test data in the same collections is left alone.

**Other plugins can skip seeded records.** The marker field is indexed and readable, so translation, search or analytics plugins can leave seeded records out (for example a translation plugin's include filter), so a big world doesn't trigger paid work.

## 8. Copying settings from production

Optional, and off unless the site sets it up. For sites that want a test database that looks like production's configuration.

- The plugin connects to production read-only (a separate connection string, ideally a database user with read rights only) and copies only fields on an allow-list the site supplies.
- A field on the list is still refused if its name or value looks like a key, token, secret, webhook, payment id, email credential or postal address. That check fails closed.
- Unknown fields are skipped and listed in the report. Nothing read from production is ever sent to Claude.
- Where the site already has its own copy script, the plugin calls it instead (`copySettings: (report) => …`), and needs no production connection string of its own. That's the recommended setup.
- **Keyless, preferred (decided 2026-11-09).** It's a new surface on production, so it's off unless the site turns it on, and it gets its own security review (the site's platform review plus a Whitehat check) before it's built. production serves one read-only export endpoint built only from the allow-list, so a secret field can't be included by construction, and it fails closed on any unknown field. The caller is the site's CI job, proved by a short-lived OIDC token from the CI provider (for GitHub Actions: signature against the provider's published keys; audience; issued and expiry times; repository, workflow file, ref and deployment environment claims; no replayed `jti`). The endpoint is rate-limited and audited. No database credential leaves production.
- Otherwise, a site may schedule the copy, but only with a read-only credential, ideally limited to the collections it copies. Before reading anything, the copy asks the database for its own privileges and refuses unless every one is a read, so a credential that can write fails closed. The credential lives in the site's secret store (for example a CI environment secret), never in the plugin's settings.
- Settings are copied **before** the seed loads, so a copy can't remove seeded records or change ids they point at.

## 9. Coverage check in CI

`npx seed coverage` reads the Payload config and the site's seed plan, and fails when a collection, field, select value or relationship has neither a minimum count nor a skip with a written reason. It runs offline: no database, no key. Sites add it to CI the way they'd add a lint step. A new field without a plan fails the build, which is the point: the seed can't silently fall behind the schema.

The same file sets minimums: each select value at least 3 times in big and once in small, and each relationship pattern the site names (for example private parents, transfers, custody chains) in several combinations.

## 10. Realism audit

Runs after every generation, writes `report.realism` on the run, and shows pass or fail with numbers:

- **Names:** share of distinct person and record names (pass at 97% or more for people), spread across the configured languages within 3 points of their shares.
- **Repeats:** no free-text value of 40 characters or more appears more than twice; near-duplicates (same text after lowercasing and stripping punctuation) counted too.
- **Distributions:** each configured distribution compared with what was made (for example median records per account, top 1% share), within a stated tolerance.
- **Markers and filler:** zero "Seed:"/"Sandbox:" markers, zero lorem, zero block-list hits, zero emails outside `example.invalid`.
- **Mess:** typo rate, missing-optional rate and planned duplicates each within tolerance of the settings.
- **Coverage:** the CI rules, measured on the real data.

A failed audit doesn't delete the data; it marks the run "done with problems" and lists what failed.

## 11. Images

Each image field points at one shared copy per kind (silhouettes, a small set of licensed stock images the site provides), so 20,000 records don't mean 20,000 uploads. The plugin never downloads images. 0.2.1's locally generated PNGs stay as the fallback.

## 12. Size, speed and snapshots

- **Small** (tens of records per collection) runs in CI on every pull request, without Claude: word lists only, so it's free and stays deterministic.
- **Big** runs on a test database on demand or on a schedule. It writes through the Local API in chunks with progress, and can be resumed after an interruption (the register knows what exists).
- **Size is measured the way the database host enforces it.** On MongoDB Atlas's free tier that's uncompressed data plus indexes, summed over every database on the cluster. Before every run the plugin projects the whole cluster's size after the run, and refuses above the site's cap with a clear report. The projection comes from a measured load (`dbStats` before and after), scaled. That way, records the site's own hooks create (audit entries, versions, history, search records) are counted, not just the records the seed meant to write. A scheduled run that refuses alerts and never half-loads.
- **The owner's limits for the reference site (2026-11-09).** That site sets `targetShare: 0.8` (the owner: "Auto-size to 80% (Recommended)"): each load fills the cluster up to 80%. The earlier figures are ceilings, not targets: aim for 85–90% of the cluster after a load, with up to 93% accepted ("I'm fine with 93% if it means a better testing UX and it doesn't cause problems"). A hard cap at 95% projected. A daily size check that alerts at 96% and trims in a set order: old test-only audit entries and notifications first, then the seed's largest optional sets.
- **Auto-sizing [decided 2026-11-09; the owner: "Auto-size to 80% (Recommended)"]:**
  - Each run measures the cluster first and fills only up to a target share of the enforced limit (default 80%, a setting).
  - The configured counts are a ceiling, each type with a minimum. Types marked bulk shrink first, in proportion. Headline types shrink only after the bulk types reach their minimums, and never below a few examples of every persona kind and relationship pattern.
  - If there isn't room for the minimums, the run refuses and alerts.
  - Tests: clusters at 60%, 75% and 79% before seeding, minimums held, and the refusal.
- **A smaller register [decided 2026-11-09]:** store the batch id in each record's marker instead of one register document per record. At tens of thousands of records the register is a noticeable share of the database; the marker already exists and is indexed.
- **Snapshots:** after a full generation, the site can export the generated data (`npx seed snapshot`), and later load it again in minutes without Claude (`npx seed restore`). Snapshots stay private to the site; the plugin never uploads them anywhere.

## 13. What changes for sites on 0.2.x

- `ai` (bring-your-own model function) stays, for sites that want another provider or their own wrapper. With a key and no `ai`, the plugin uses its built-in Claude client.
- Batches, records and markers keep their shapes. New plugin collections: `seed-settings` (global), `seed-texts`, `seed-marker`.
- The guard gets stricter (section 7, checks 2 and 3). A site upgrading needs to mark its test databases once.

## 14. Decisions

Owner, 2026-11-09, in Helm's chat, relayed word for word. Asked together as "species mix from Seed World's weights (editable in the admin); people's settings mostly default; Opus 5.5 plans, Haiku 5.5 fills; $10 spend cap per run; CI's small seed uses word lists only. Accept all?". Answer: "Accept all (Recommended)".

- **Default models:** Claude Opus 5.5 plans, Claude Haiku 5.5 fills. Both stay settings.
- **Default spend cap:** $10 per run (`spend.capUSD`).
- **Small seed in CI:** word lists only, no Claude.
- **Before the cost estimator ships**, its price table is checked against the live pricing page, and dated.
