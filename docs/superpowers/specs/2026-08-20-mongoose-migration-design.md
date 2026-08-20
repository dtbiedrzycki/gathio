# Mongoose 5 → 6+ Migration — Design

## Context

`mongoose@5.13.22` (`package.json:49`) carries the only Critical finding
left after `feat/security-deps-update`: a search-injection advisory, plus a
High-severity `$nor`-sanitization NoSQL-injection issue and a Moderate
prototype-pollution-in-update-casting issue (via `__proto__`-prefixed
dotted paths). All three are fixed only in the 6.x line
(`>=6.13.6`/`>=6.13.9`/`>=6.13.10` respectively — likely superseded by now;
confirm current advisory floors at kickoff, they may have moved). This is
not a version-range bump: mongoose 6 (and mongoose is now well past 6, at
8.x+) changed enough API surface that this needs a real migration.

**Scope, by file count:** `grep -rl "mongoose" src/` finds 6 files —
`src/start.ts` (connection setup), the four models in `src/models/`
(`Event.ts`, `EventGroup.ts`, `MagicLink.ts`, `Log.ts`), and
`src/routes/frontend.ts`. But queries against those models happen far more
broadly than the files that import `mongoose` directly: `src/routes/*.ts`
and the untyped legacy router `src/routes.js` (980 lines, ~21
query/update/save-shaped calls by a rough grep) both call model methods
(`Event.find(...)`, `.findOne(...)`, `.save()`, etc.) without importing
`mongoose` itself. **The real audit surface is every model-method call in
the app, not just the 6 files that `import mongoose`.**

Per `CLAUDE.md`'s architecture notes: `Event` has embedded attendees,
comments/replies, followers, an ActivityPub message log, and custom
questions — Mongoose's handling of subdocuments and embedded-array updates
is one of the areas most likely to have behavior changes across major
versions. This is also the model most routes touch.

## Goals

- Reach a mongoose version where all three findings above are patched
  (6.13.10+ is the minimum; going further to a current major, e.g. 8.x, may
  be the better target if the security floor and the "how much API churn
  do we accept" trade-off favor it — decide during brainstorming, this
  spec does not pre-decide the target version).
- Every model (`Event`, `EventGroup`, `MagicLink`, `Log`) and every query
  site across `src/routes/*.ts` and `src/routes.js` continues to behave
  identically from the app's perspective — this is a dependency migration,
  not a data-model redesign.
- Full Cypress suite passes, since this touches the actual query/mutation
  logic behind nearly every route (unlike the other three items in this
  roadmap, which are narrow-surface dependency swaps) — Cypress is the
  real regression net here, not optional per-route manual spot-checks.

## Non-goals

- Schema redesign, new indexes, or data migration scripts for existing
  production data — this is an ODM version migration, not a schema change.
  If mongoose 6+ requires an index or schema-option change to keep current
  behavior (e.g. `strictQuery` defaults changed across versions — verify),
  that's in scope; adding _new_ schema capabilities is not.
- Any change to the auth model, ActivityPub message handling, or other
  business logic that happens to touch mongoose-backed models — only the
  ODM layer changes, not what routes decide to do with query results.

## Why this needs its own investigation phase before a plan can be written

Unlike the other three items in this roadmap, this spec cannot responsibly
name specific breaking changes to expect — mongoose 5→8's actual breaking-change
list (removed callback support, `strict`/`strictQuery` default changes,
`findOneAndUpdate`/`findOneAndRemove` behavior, subdocument `_id` handling,
connection-option changes like the now-unneeded `useNewUrlParser`/
`useUnifiedTopology`, discriminator changes, etc.) needs to be checked
against **this app's actual usage patterns**, not assumed generically. The
right first step when this item is picked up is:

1. Read mongoose's official migration guides for 5→6, 6→7, and 7→8
   (they publish one per major).
2. Grep every model-method call across `src/models/`, `src/routes/*.ts`,
   and `src/routes.js` (not just files importing `mongoose`) and classify
   each against the migration guides' breaking-change list.
3. **Only then** run `superpowers:writing-plans` — a plan written before
   this investigation would be guessing at what needs to change.

This is a spike-shaped first step (`superpowers:brainstorming`'s "spike"
path: a feasibility/scoping question whose output is a classified list, not
code) before the item becomes a normal architectural spec-then-plan cycle.
Budget for this being a bigger effort than the other three items combined —
that's expected given the blast radius, not a sign something's wrong with
the scoping.

## Open questions (resolve via investigation spike, then `superpowers:brainstorming`)

1. **Target version**: minimum-patched (6.13.10) vs. current major (8.x+)?
   Going further costs more migration work up front but avoids doing this
   exercise again soon; going to the minimum patched floor is the smaller
   diff but leaves the app on an EOL-adjacent major.
2. **`strictQuery` and `strict` defaults** — these changed across mongoose
   majors and affect which fields silently get dropped vs. rejected on
   save; confirm current schema definitions in `src/models/*.ts` are
   explicit enough not to depend on a version-specific default.
3. **Embedded-array behavior on `Event`** (attendees, comments/replies,
   followers, ActivityPub message log, custom questions) — the highest-risk
   area given how much of the app mutates these; needs the most careful
   before/after behavioral verification.
4. **`src/routes.js` (legacy, untyped)** — per `CLAUDE.md`, this file is
   mid-migration to typed routers already; decide whether mongoose-call
   sites touched by this migration in that file should also move to a
   typed router as part of this work, or stay untouched and typed only
   incidentally by whatever TypeScript inference mongoose 6+'s types
   provide. Recommend: touch only what mongoose's API change requires,
   don't bundle in the broader routes.js migration — that's a separate,
   pre-existing effort per `CLAUDE.md`'s "Route layering" notes.

## Testing

- Full `pnpm test` (Cypress) is the primary regression gate — this is the
  one item in this roadmap where per-route manual smoke checks are not a
  sufficient substitute, given how broadly mongoose query behavior is
  exercised across the suite.
- Consider adding a temporary before/after diff harness during the
  investigation spike (run the same set of representative queries against
  both mongoose versions against a snapshot of test data, diff the
  results) if the migration guides surface enough ambiguity to warrant it
  — decide this during the spike, not now.
