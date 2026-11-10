# @captiveorigins/payload-plugin-seed

Seed for Payload: realistic test data at scale, written with Claude. **Coverage-first** test data for any [Payload](https://payloadcms.com) site. The plugin reads your schema and fills it in dependency order, so that **every option, empty and full case, and relationship shape appears at least once**, instead of piling up random rows. Every document is marked and registered, so a batch can be removed in one step. It **refuses to run in production**.

**Renamed in 0.3.0** from `@captiveorigins/payload-plugin-sandbox`. The old export names (`sandboxPlugin`, `runSandbox`, `removeSandbox`, `SandboxRefused`, `SandboxOptions`, `SandboxPlan`, `SandboxPanel`, `SandboxView`, `SandboxNavLink`) still work until 0.4.0. Stored names are unchanged, so earlier batches stay removable: the `sandbox-batches` and `sandbox-records` collections, and the `sandbox` marker. The admin screen moved from `/admin/sandbox` to `/admin/seed`.

- **Coverage, not volume**: one document per *pairwise* case. Every pair of values of any two fields appears together at least once (5 fields with 2–3 options each: about 15 documents instead of 108), plus deliberate edge cases (accents, CJK, right-to-left text, emoji, quotes, minimum and maximum numbers, long text).
- **Shapes**: self-references (parents, parent pages, replies) become multi-generation trees with deliberate gaps.
- **Through Payload**: documents are created with the Local API, so validation, hooks and access rules run. What your site rejects is reported with the reason (often a rule nobody wrote down).
- **Reproducible**: the same seed gives the same data.
- **Removable**: remove everything, one batch, or one collection of a batch, in reverse order. Only registered documents are touched, never real data.
- **Safe**: emails use `example.invalid`; generated accounts get random, unstored passwords; images are generated locally (no downloads).

```ts
import { seedPlugin } from '@captiveorigins/payload-plugin-seed'

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

## Never in production

- `allow()` is required; without it, or when it returns false, nothing is generated and the admin is hidden.
- Databases whose name contains "prod" are refused unless listed in `allowDatabases`.
- Every generated document carries a read-only `sandbox` marker that only Seed can set. Where seeding is not allowed, start-up logs an error if any marked document exists (for example after copying a test database).

## Plans, people and the admin area

Where seeding is allowed, the admin gets a **Seed** area: write a plan, read it, run it, read the coverage and what your site refused, sign in as one of its people, and remove it in one step.

- **Plans.** A plan says which collections to fill, with sample wording and people. With `ai` set, a model writes it (it sees the shape of your schema, never documents; everything it returns is checked against the schema). Without it, or if it fails, you get a plain plan. Nothing is created until you press Run.
- **People.** Personas are fictional accounts with a story of what to try. Give your own (`personas`), let AI plans suggest more, and turn their `traits` into roles in a recipe (`ctx.persona`).
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
