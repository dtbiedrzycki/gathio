# Replace `ical` — Design

## Context

`ical@0.6.0` (`package.json:41`) is used at exactly one call site,
`src/routes/event.ts:755`:

```ts
const iCalObject = ical.parseICS(req.file.buffer.toString("utf8"));
```

This parses an already-uploaded `.ics` file's contents (a buffer from a
file upload, not a URL). `ical.fromURL(...)` — the function that would
fetch a calendar from a remote URL — is never called anywhere in this
codebase. That matters because `ical@0.6.0` depends on the deprecated,
unmaintained `request` package (last published `2.88.2` in 2020, with an
SSRF advisory that has no real fix — `request` itself has no patched
release). `feat/security-deps-update` confirmed this and ruled it an
accepted risk rather than something to override: **the SSRF-relevant path
is dead code in this app**, since only `parseICS` (buffer-in, no network
call) is used.

So this item is lower security urgency than it looks from the advisory
alone. It's still worth doing: `request` drags in a whole stale subtree —
`tough-cookie`, `form-data@2.x`, `ajv`, `qs`, `uuid`, `har-validator` — all
dead weight with their own (mostly moderate/low) advisories, none of which
are reachable either, but all of which add supply-chain surface and show
up as audit noise on every future `pnpm audit` run.

## Goals

- Replace `ical` with a maintained library that has a `.ics`-buffer-parsing
  function equivalent to `parseICS`, with no `request`/deprecated-package
  dependents.
- Confirm the parsed-object shape (whatever `iCalObject` is used for
  downstream in `src/routes/event.ts` after line 755 — read that code
  before picking a replacement) is either identical or can be adapted with
  a thin mapping layer, without changing behavior for whatever this import
  flow actually does with the parsed calendar data.
- Remove `ical`, `@types/ical`, and the `request` subtree entirely from
  `package.json`/the lockfile once the replacement lands — this is a net
  reduction in dependency count, not a swap that keeps both.

## Non-goals

- Adding new calendar-import capabilities (recurring-event expansion,
  timezone handling improvements, etc.) beyond what the current `ical`
  usage already provides — this is a dependency swap, not a feature
  change.
- Re-enabling or adding any URL-fetching calendar import (`fromURL`-style)
  — that functionality doesn't exist today and isn't being added here. If
  a future feature wants it, it gets its own spec (and its own SSRF-safety
  review, since that's exactly the class of risk this deferred finding was
  about).

## Open questions (resolve via `superpowers:brainstorming` before planning)

1. **Pick the replacement library.** `node-ical` (an actively maintained
   fork in the same ecosystem, same `parseICS`-equivalent API in most
   versions) is the obvious first candidate — confirm its current API,
   whether it depends on anything equally stale, and whether its parsed
   output shape matches closely enough to avoid touching downstream code.
   Evaluate at least one alternative (e.g. `ical.js`, which has a
   different, more object-oriented API) before committing, per
   brainstorming's "propose 2-3 approaches" step.
2. **Read all of `src/routes/event.ts`'s usage of `iCalObject` after line
   755** (not just the parse call) to know exactly what shape the
   replacement needs to produce — this spec doesn't attempt that here,
   since it requires reading the surrounding handler in full.
3. **Confirm no other file imports `ical`** (`grep -rn "from \"ical\"\|require(\"ical\")" src/`)
   before assuming this is truly a single-call-site change — re-verify at
   kickoff time in case something changed between this spec being written
   and picked up.

## Testing

- If existing Cypress coverage exercises `.ics` upload/import (check
  `cypress/e2e/` for any spec touching this route), it should continue
  passing unmodified if the parsed-object shape is preserved exactly —
  that's the acceptance bar, not new test-writing, unless investigation
  finds no existing coverage (in which case, add a minimal one covering
  the parse-and-whatever-happens-next flow).
