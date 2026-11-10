# Changelog

## 0.4.0 (not released yet)

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
- **A stricter guard.** Seeding now needs three checks to pass, each failing closed:
  - `allow()`;
  - a readable database name that doesn't look like production (an unreadable name used to pass, and is now refused);
  - a test-database marker for this database name and host, written once by a person with `markTestDatabase()`. It lives in a new collection, `seed-marker`, that the API can't write.
  - `assertQuiet`: optional; seeding refuses while it throws.
  - `assertAllowed` and `isAllowed` are now async. `assertConfigAllowed` keeps the first two checks, synchronous.
- **Removed:** the `sandboxPlugin`, `runSandbox`, `removeSandbox`, `SandboxRefused`, `SandboxOptions` and `SandboxPlan` aliases, and the component aliases `SandboxPanel` (`/client`), `SandboxView` and `SandboxNavLink` (`/rsc`), all deprecated in 0.3.0. Use the `Seed` names.

**Upgrading:** mark each test database once with `markTestDatabase()` before seeding it again. Await `assertAllowed` and `isAllowed`. Build the new `sandboxBatch` index wherever your database doesn't build indexes automatically (for example a script you run after migrations). Stored names are unchanged (`sandbox-batches`, `sandbox-records`, the `sandbox` marker).

## 0.3.0

- Renamed from `@captiveorigins/payload-plugin-sandbox` to `@captiveorigins/payload-plugin-seed`. Exports, the admin area (`/admin/seed`) and wording say Seed; old export names kept as deprecated aliases until 0.4.0. Stored names unchanged.
