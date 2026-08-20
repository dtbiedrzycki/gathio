# Dependency Security Follow-Ups — Roadmap

## Context

`feat/security-deps-update` (branched off `feat/mad-customizations`) closed
the production-reachable dependency vulnerabilities that could be fixed with
version bumps and pnpm overrides. Four findings were deliberately deferred
because each needs a real design decision or a large, careful migration
rather than a version bump — see that branch's PR description for the
original triage. This roadmap turns those four deferrals into individual,
independently workable items, each with its own spec.

Each item below gets `superpowers:brainstorming` run fresh against its own
spec when picked up (the specs already carry the investigation this session
did — a new session does not need this conversation's history, only the
spec file). Do not start item N+1's implementation before item N is merged;
they don't share files, but they do share the same handful of already-thin
`src/routes/*.ts` files in places, and reviewing them one at a time keeps
each diff readable.

## Sequencing

Ordered by reachability-and-containment first, not raw CVE severity —
mongoose carries the only Critical finding, but is by far the largest
change, so the three contained wins go first to reduce real exposure while
mongoose gets a dedicated planning pass.

| Order | Item                        | Spec                                                                               | Severity                                     | Why this position                                                                                                                                                                                                  |
| ----- | --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `jimp` major upgrade        | [2026-08-20-jimp-upgrade-design.md](2026-08-20-jimp-upgrade-design.md)             | Moderate/Low, but most _reachable_           | Processes user-uploaded banner bytes at 4 call sites — real exposure today. Contained to image-handling code.                                                                                                      |
| 2     | `nodemailer` major bump     | [2026-08-20-nodemailer-upgrade-design.md](2026-08-20-nodemailer-upgrade-design.md) | High                                         | Single-file consumer (`src/lib/email.ts`), but the transport-config API needs review across the major jump.                                                                                                        |
| 3     | Replace `ical`              | [2026-08-20-ical-replacement-design.md](2026-08-20-ical-replacement-design.md)     | Moderate (SSRF advisory, but dead code here) | Lower urgency — the vulnerable path (`request`'s SSRF) is never actually exercised in this app. Valuable cleanup: removes a whole stale subtree (`request`, `tough-cookie`, `form-data@2.x`, `ajv`, `qs`, `uuid`). |
| 4     | `mongoose` 5→6(+) migration | [2026-08-20-mongoose-migration-design.md](2026-08-20-mongoose-migration-design.md) | Critical                                     | Carries the actual Critical finding (search injection) plus High/Moderate ones, but touches every model and nearly every route — needs its own dedicated, multi-session effort.                                    |

## How to pick up an item

1. Read that item's spec file — it has the investigation already done (call
   sites, current vs. target versions, known API-compatibility risks).
2. Run `superpowers:brainstorming` against it if the spec flags open
   questions that need a design decision (several do — see each spec's
   "Open questions" section). Otherwise go straight to
   `superpowers:writing-plans`.
3. Branch off the current tip of `feat/mad-customizations` (not off this
   roadmap doc's branch — by the time an item is picked up, earlier items
   in this sequence may already be merged).
4. Execute via `superpowers:subagent-driven-development` or
   `superpowers:executing-plans`, same as `feat/security-deps-update` was.

## Non-goals of this roadmap doc

- This is not itself an implementation plan for any item — each spec still
  needs `writing-plans` run against it before code changes start.
- Findings this session already ruled fully out of scope (Low-severity
  dev-only chains, `@babel/runtime`'s transpiled-regex ReDoS, `@types/dompurify`
  cleanup) are not repeated here — they weren't judged worth a dedicated
  effort, on `feat/security-deps-update`'s branch or this roadmap.
