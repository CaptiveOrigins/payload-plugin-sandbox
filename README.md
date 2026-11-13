# @extantape/payload-plugin-seed

Seed for Payload: realistic test data at scale, written with Claude. **Coverage-first** test data for any [Payload](https://payloadcms.com) site. The plugin reads your schema and fills it in dependency order, so that **every option, empty and full case, and relationship shape appears at least once**, instead of piling up random rows. Every document is marked and registered, so a batch can be removed in one step. It **refuses to run in production**.

**Renamed** from `@extantape/payload-plugin-sandbox` (0.2.x); 0.3.0 is the first version under this name. The old export names (`sandboxPlugin`, `runSandbox`, `removeSandbox` and the rest) are gone: use the `Seed` names. Mark each test database once with `markTestDatabase()` before seeding it (see below). Stored names are unchanged, so earlier batches stay removable: the `sandbox-batches` and `sandbox-records` collections, and the `sandbox` marker. The admin screen moved from `/admin/sandbox` to `/admin/seed`.

- **Coverage, not volume**: one document per *pairwise* case. Every pair of values of any two fields appears together at least once (5 fields with 2–3 options each: about 15 documents instead of 108), plus deliberate edge cases (accents, CJK, right-to-left text, emoji, quotes, minimum and maximum numbers, long text).
- **Shapes**: self-references (parents, parent pages, replies) become multi-generation trees with deliberate gaps.
- **Through Payload**: documents are created with the Local API, so validation, hooks and access rules run. What your site rejects is reported with the reason (often a rule nobody wrote down).
- **Reproducible**: the same seed gives the same data.
- **Removable**: remove everything, one batch, or one collection of a batch, in reverse order. Only registered documents are touched, never real data.
- **Safe**: emails use `example.invalid`; generated accounts get random, unstored passwords; images are generated locally (no downloads).

```ts
import { seedPlugin } from '@extantape/payload-plugin-seed'

export default buildConfig({
  plugins: [
    seedPlugin({
      // Required. Install it the same way everywhere; where this is false (production) it only refuses.
      allow: () => process.env.APP_ENV !== 'prod',
      access: (req) => Boolean(req.user?.roles?.includes('admin')),
      recipes: {
        // Optional: rules that live in code rather than in the schema.
        animals: { prepare: (data, ctx) => ({ ...data, name: `${data.name} #${ctx.created('animals').length + 1}` }) },
      },
    }),
  ],
})
```

Run it from a script (`runSeed(payload, options, { seed: 'demo', collections: ['animals'] })`, dependencies added automatically) or `POST /api/sandbox-batches/run`; remove with `removeSeed(payload, options, { batch })` or `POST /api/sandbox-batches/remove`. Each batch stores a coverage report per collection and every refused document with the reason.

## On its own, and with others

**On its own.** Seed needs Payload 3.80 or later with its Next.js admin, and a test database marked once with `markTestDatabase()`. Claude is optional (`@anthropic-ai/sdk` and a key); without it, text comes from word lists. It doesn't use any other Captive Origins plugin.

**Works with:**

- **Sample Kits** (`@extantape/payload-plugin-sample-kits`, not on npm yet): pass the same `allow` you gave Seed as Sample Kits' `adapters.seed`. Its `seedKitStory` and `removeKitRecords` then run only where Seed allows seeding. Sample Kits never imports Seed.

**Family.** Seed is in the Staging family, with Sandbox Mode, which is named but not built yet. The families are a working draft that may change.

## A coverage plan in CI

A seed falls behind the schema quietly: someone adds a field, and the test data never has it. A coverage plan stops that. It says, for every collection, whether the seed generates it (with a plan for every field), refers to it (`existing`) or skips it, each with a reason. `checkCoveragePlan` compares the plan with your Payload config offline, with no database and no key, and lists every gap: a new collection or field without a plan, a skip without a reason, a required field skipped, a select value or field the schema no longer has, a relationship to something the plan doesn't cover.

```ts
// test/seed-coverage.test.ts
import { assertCoveragePlan } from '@extantape/payload-plugin-seed'
import config from '../src/payload.config'
import plan from '../seed/coverage-plan'

it('the seed plan covers the schema', async () => assertCoveragePlan(await config, plan))
```

Globals are planned too (`globals`: existing or skipped, with a reason; the seed never writes them). A plan whose per-value minimums need more records than it makes for that collection fails as well. Start from `draftCoveragePlan(config)`, which plans every field of every collection as filled, with enough records for every minimum, then mark what is existing or skipped. Every value of a filled select appears at least 3 times in big and once in small, unless the plan says otherwise (`selectMinimums` lists them): per value (`values`), or for the whole field with a reason (`minimum: { small, big, reason }`, for long lists such as countries).

## Never in production

Three checks, each failing closed. A refusal says which one failed.

1. `allow()` is required, and only an answer of exactly `true` counts. Without it, or when it returns anything else (`false`, the string `'false'` from an environment variable, `1`, a promise, or an error thrown), nothing is generated and the admin is hidden. Compare an environment variable yourself: `allow: () => process.env.SEED_ALLOW === 'true'`.
2. The database name must be readable and must not contain "prod", unless it's listed in `allowDatabases`.
3. The database must be marked as a test database, for its own name and host. A person does this once, typing the database name to confirm:

   ```ts
   import { markTestDatabase } from '@extantape/payload-plugin-seed'
   await markTestDatabase(payload, seedOptions, { confirm: 'test', by: 'who ran it' })
   ```

   It refuses where checks 1 or 2 fail, so production can't be marked. The marker records the database name and host (never credentials), so a copy restored on another cluster, or under another name, is refused until someone marks it again.

Give `assertQuiet` (a function that throws while email, webhooks or payments are on) and seeding also refuses while it throws. Switching effects off in `around` isn't proof they're off.
- Every generated document carries a read-only `sandbox` marker that only Seed can set. Where seeding is not allowed, start-up logs an error if any marked document exists (for example after copying a test database).

## Big seeds

A small seed makes one record per coverage case. A big one makes the coverage cases first, then more records up to counts you set, so the site feels lived in:

- **Settings in the admin** (`seed-settings`, under Seed): counts per collection as `{ "ceiling", "minimum", "bulk" }`, the target share of the database, its limit, every database on the cluster, measured bytes per record, models and the spend cap. The site's code gives defaults (`seedPlugin({ defaults })`); an empty field uses them.
- **Sized before anything is written.** A big run measures the cluster and sizes the counts (below). If they don't fit, it refuses and writes nothing. "Check what fits" in the admin shows the counts and the projected share first.
- **Text people read** comes from `texts` (for example Claude, see below), for big seeds only. Each record is described by the values code chose for it, never ids or real data; code still decides every value that has to be right. Deliberate edge cases keep their odd text. Small seeds use word lists, so CI stays free.
- **Interrupted runs carry on.** Progress is saved as it goes; "Carry on where it stopped" (or `runSeed(payload, options, { resume: batchId })`) keeps what was made and makes the rest, after measuring the cluster again: if the rest would pass the hard cap, it refuses.
- **Exact counts** (`runSeed(..., { counts })`) skip sizing, for tests and code that already checked with `planSize()`. Big runs from the admin always size.
- **Speed:** coverage cases are created one at a time, the rest `concurrency` at once (default 4). Unique values (emails, slugs) carry a short batch tag, so batches never collide.

## Realism audit

After every run, Seed reads what the batch made and checks that it looks like real use. It only reads: a failed check marks the run "done with problems" and lists what failed, with examples. The checks:

- No text of 40 characters or more appears more than twice (ignoring case and punctuation).
- At least 97% of people's names are distinct, once there are 50 or more.
- No placeholder text (lorem ipsum), and no "Seed:" or "Sandbox:" in visible text.
- Emails and links only on example domains (`example.com`, `.org`, `.net`, or `.invalid`).
- With `coveragePlan` in the options, every select value reaches its minimum in what was really made.

Turn it off with `audit: false`. The result is on the batch (`report.realism`) and in the admin.

## Text written by Claude

For big seeds, `claudeTexts()` writes the text people read (names, titles, notes, bios) with Claude:

```ts
import { claudeTexts, fileTextCache, seedPlugin } from '@extantape/payload-plugin-seed'

seedPlugin({
  // ...
  texts: claudeTexts({ about: 'A site for reptile keepers.', cache: fileTextCache('.cache/seed-texts.jsonl') }),
})
```

- **Key:** `ANTHROPIC_API_KEY` (or `apiKeyEnv`), read on the server only when a run needs it; never stored, logged or shown. Without one, nothing is sent and word lists stay. Install `@anthropic-ai/sdk` (an optional peer dependency).
- **Models:** the settings' `models.fill` (default Claude Haiku 5.5), through the Message Batches API at half price, with structured JSON output and the system prompt cached.
- **What's sent:** a description of each record built from values code chose (a status, a date, a species), never ids, documents or anything real from the database.
- **Cost, asked first:** before a big run, the admin shows the worst case and the likely cost, with the date of the price table. Above `spend.askAboveUSD` (default $5) it asks once, naming the amount. `spend.capUSD` (default $10) is a hard cap: requests go out only while their worst case still fits (the system prompt at the cache-write price, input with a 50% margin over the estimate, every output token used), so the cap holds whatever comes back. The real cost is written onto the batch (`report.texts.costUSD`). `estimateRun()` gives the same figures in code.
- **Checked before use:** every value must parse, fit its field, and pass content rules: no placeholder text, no "Seed:" or "Sandbox:", no email or link outside example domains, no blocked words (`blockList`). Refused, errored or expired requests are retried once outside the batch, then fall back to word lists. The batch report counts all of it.
- **Text cache:** answers are kept by what was asked (seed, prompt version, model, language, record description). `fileTextCache(path)` keeps them in a file outside the database, so a reload pays only for what changed. Keep that file out of git (add it to `.gitignore`): it's generated, and can be large.

## Size: fill to a share of the cluster

Small database tiers have hard limits, and a seed that overshoots can stop the site writing. Seed measures and plans before it loads:

- `measureCluster(payload, { databases })` measures the way MongoDB Atlas enforces its free-tier limit: uncompressed data plus indexes, summed over the databases you name. The list is required and must name every database on the cluster, the current one included. A database it can't measure, or one with no collections (usually a typo), is an error, never 0.
- `planCounts({ rules, bytesPerRecord, usedBytes, limitBytes, targetShare })` turns per-kind ceilings and minimums into counts that fill the cluster up to `targetShare` (default 80%). Kinds marked `bulk` shrink first, in proportion; the others shrink only after every bulk kind is at its minimum. If the minimums don't fit, it refuses and nothing loads. It never projects above `hardCap` (default 95%).
- `calibrate({ bytesPerRecord, counts, growthBytes })` turns a measured load (`measureCluster` before and after) into an `indirectFactor`, so versions, audit entries and other records your hooks write count too.
- `sizeStatus(usedBytes, limitBytes)` is for a daily check: ok, warn at 90%, alert at 96%.

## Where a batch is remembered

Since 0.3.0 each seeded document carries its batch id beside the marker (`sandboxBatch`), and removal finds documents by it: collections in reverse dependency order, newest first within one. There's no register document per record, which matters at scale (about 0.4 KB saved per record, so tens of MB on a big world). Set `register: 'records'` to keep the old register. Batches made either way can still be removed. A recipe that creates documents itself adopts them into the batch with `ctx.track(collection, id)`. Removal deletes one document at a time with your hooks on, so a big world takes a while to remove. Name what a removal must never delete with `keep` (per collection, a `where`, for example administrators): matches are skipped even when marked, and listed as kept.

On a database with automatic indexing off, build the new `sandboxBatch` index the way you build your others.

Removal goes one record at a time with your hooks on, which is slow for big loads. Name collections whose delete hooks don't need to run (no counts to update, no files to remove) in `bulkRemove`, and each is removed with one delete instead: still only the seed's marked records of that batch, never a collection in `keep`, and refused at start-up for a collection that keeps versions.

## Plans, people and the admin area

Where seeding is allowed, the admin gets a **Seed** area: write a plan, read it, run it, read the coverage and what your site refused, sign in as one of its people, and remove it in one step.

- **Plans.** A plan says which collections to fill, with sample wording and people. With `ai` set, a model writes it (it sees the shape of your schema, never documents; everything it returns is checked against the schema). Without it, or if it fails, you get a plain plan. Nothing is created until you press Run.
- **People.** Personas are fictional accounts with a story of what to try. Give your own (`personas`), let AI plans suggest more, and turn their `traits` into roles in a recipe (`ctx.persona`).
- **Who gets in.** `access` must answer exactly `true` for a signed-in person. Anything else, a thrown error included, is a 403 from every Seed endpoint, no Seed collections or settings, and "You don’t have access to Seed" in the admin.
- **Sign in as.** A real session as a seeded account, for whoever `access` allows, wherever seeding is allowed. Only accounts Seed made qualify; real accounts are out of reach.
- **Long runs.** Set `defer` (in Next.js, `(task) => after(task)`) and the admin doesn't wait; for runs longer than a request may last, call `runSeed` from a script.

```ts
seedPlugin({
  allow: () => process.env.APP_ENV !== 'prod',
  access: (req) => Boolean(req.user?.roles?.includes('admin')),
  only: ['users', 'animals'],                                  // generate just these
  existing: { sites: { where: { slug: { equals: 'main' } } } }, // refer to these, never generate them
  around: (task) => withoutEmail(task),                         // wrap every run and removal
  personas: [{ collection: 'users', name: 'New Keeper', story: 'Has no animals yet. Try adding one.', traits: ['member'] }],
  ai: async ({ system, prompt, schema }) => yourModel({ system, prompt, schema }), // returns JSON
})
```

After installing, run `payload generate:importmap` so the admin finds the Seed screen.

## License

MIT
