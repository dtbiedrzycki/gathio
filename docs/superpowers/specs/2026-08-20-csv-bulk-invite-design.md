# Bulk Invite via CSV Upload — Design

## Context

Today, getting people to an event page is entirely manual: the host shares a
link themselves (or federation delivers a post to followers). There is no
host-initiated "invite these people" flow anywhere in the app — attendees
only ever arrive and self-RSVP. This spec adds one: a host, from the event
edit modal, uploads a CSV of `name,email` pairs and gathio emails each of
them a link to the event.

Branch: new branch off `feat/rsvp-hide-removal-password`.

## Goals

- A host can upload a CSV (`name,email` columns, header row required) from
  the event edit modal and have gathio email every valid row a link to the
  event.
- Bad rows (missing/invalid email) are skipped, not fatal — the host gets a
  summary (`"12 sent, 2 skipped"`) with reasons.
- The upload path is hardened against it becoming an abuse vector: it sits
  behind the existing editToken gate, but that gate is a URL-embedded secret
  (see `AUTH_MODEL` in CLAUDE.md), not a login — so the endpoint must not
  become a way to blast arbitrary volumes of email or inject content into
  outbound mail.

## Non-goals

- Pre-registering CSV rows as attendees. Approved in brainstorming: invites
  only email a link; recipients RSVP themselves like anyone else. No
  `Attendee` documents are created by this feature.
- Tracking invite delivery/open status, resending, or dedup against
  previously-invited addresses. One upload, one send pass, no persistence of
  the recipient list.
- General-purpose CSV import (e.g. importing into EventGroup subscribers).
  Scoped to one-off event invites only.
- Any new app-wide rate-limiting middleware. This spec adds narrow,
  feature-local limits (below); a general `express-rate-limit` rollout is a
  separate concern.

## Data flow

1. Host opens the event edit modal (`views/partials/editeventmodal.handlebars`,
   sourced by `/{eventID}?e={editToken}`), which already requires the
   editToken to render edit controls.
2. New "Invite people" section: file input (CSV only) + "Send invites"
   button + a result area.
3. `event-edit.js` builds `FormData` with the file, POSTs to
   `/event/:eventID/invite?e={editToken}`.
4. `src/routes/event.ts` handler:
   - Confirms `editToken` matches the event (same check used by the
     existing `PUT /event/:eventID` handler).
   - Multer (memoryStorage, single file field `csvUpload`) enforces a
     **100KB** file size cap and a MIME allowlist before the handler body
     runs at all.
   - Parses the buffer with `csv-parse/sync`, requiring a header row
     containing `name` and `email` columns (case-insensitive, order-
     independent).
   - Caps parsed data rows at **200**; if the file has more, the whole
     upload is rejected before anything is sent (no partial sends on an
     oversized file).
   - Validates each row (details in Security below); valid rows are
     deduped by lowercased email within the same upload.
   - For each valid row, calls
     `emailService.sendEmailFromTemplate({ to, subject, templateName: "inviteToEvent", templateData })`,
     mirroring the existing per-recipient loop in `event.ts:267-280` for
     `eventGroupUpdated`.
   - Responds `{ sent, skipped, skippedReasons: string[] }`.
5. Frontend renders the summary in the result area.

## Security considerations

This is the part flagged for extra care, since the endpoint parses
user-uploaded, untrusted file content and drives outbound email.

- **File size / DoS**: multer `limits.fileSize` caps the upload at 100KB
  before any parsing occurs (well over what 200 short CSV rows need, well
  under what enables a memory-exhaustion attempt). The 200-row cap is a
  second, independent limit in case someone crafts a small file with
  pathologically long lines.
- **MIME/content sniffing**: multer's `fileFilter` checks the declared
  `mimetype` (`text/csv`, `application/vnd.ms-excel`, or `text/plain` — many
  browsers/OSes mislabel CSV) as a first filter, but the filter is
  advisory only (client-controlled header). The real validation is
  structural: after parsing, the handler requires a recognizable
  `name`/`email` header row and at least one syntactically valid email, or
  it rejects the file outright with a clear error — so a renamed non-CSV
  file just fails to parse usefully rather than being trusted.
- **No disk writes, no client filename use**: memoryStorage only; the
  uploaded filename is never used to construct a path, so there's no path
  traversal surface.
- **CSV parsing library, not hand-rolled**: use `csv-parse/sync` rather
  than a manual `split(",")`, so quoting/escaping edge cases don't produce
  misparsed fields (e.g. a comma inside a quoted name shifting the email
  into the wrong column).
- **Email header injection**: raw CR/LF in a field can be used to inject
  extra SMTP headers if concatenated unsafely. Every row's `email` and
  `name` fields are rejected (row skipped) if they contain `\r` or `\n`
  after trimming, before ever reaching `sendEmailFromTemplate`/nodemailer.
- **Email address validation**: a simple, linear (non-backtracking) regex
  — e.g. `^[^\s@]+@[^\s@]+\.[^\s@]+$` — avoids ReDoS from a crafted `email`
  field; no complex alternation/nested-quantifier pattern.
- **HTML injection in the outbound email**: the `inviteToEvent` Handlebars
  templates use `{{name}}` (escaped) rather than `{{{name}}}`, consistent
  with default Handlebars escaping used elsewhere in `views/emails/`, so a
  name like `<img src=x onerror=...>` renders as inert text in the HTML
  email, not markup.
- **Abuse via the editToken URL cap**: since the editToken is a bearer
  secret in a URL rather than a login, a leaked/guessed link could
  otherwise be used to spam 200 emails per request repeatedly. This spec
  doesn't add general rate limiting (out of scope, see Non-goals), but the
  per-request 200-row cap plus the existing editToken secrecy model is the
  agreed mitigation for this feature; a follow-up could add a per-event
  cooldown if abuse is observed.
- **No logging of PII to disk beyond existing patterns**: skipped-row
  reasons returned to the host reference row numbers, not full row content,
  to avoid echoing arbitrary uploaded data back verbatim in error text
  (defense against reflected-content surprises); the summary counts are
  fine to log via the existing `addToLog` helper.

## Email template

New `EmailTemplateName` value `"inviteToEvent"` added to the union in
`src/lib/email.ts`. New paired templates:
`views/emails/inviteToEvent/inviteToEventHtml.handlebars` and
`.../inviteToEventText.handlebars`, following the structure of the existing
`eventGroupUpdated` pair. `templateData`: `{ name, eventName, eventID,
domain }`. When `name` is empty, the greeting falls back to a generic
"Hi there,".

## Frontend

- `views/partials/editeventmodal.handlebars`: new section (file input
  restricted via `accept=".csv,text/csv"`, "Send invites" button, a status
  area bound to Alpine state for showing the sent/skipped summary or an
  error).
- `public/js/modules/event-edit.js`: new Alpine method building `FormData`
  and POSTing to `/event/:eventID/invite?e={editToken}`, mirroring the
  existing image-upload `fetch(..., {method: "PUT", body: formData})` call
  shape.

## i18n

New keys added to `locales/en.json` only (existing project convention:
other locales lag and get backfilled separately) for the section label,
button text, file-picker hint, and the result summary strings (including a
pluralized skipped-count message).

## Dependencies

Add `csv-parse` (small, well-maintained, synchronous API available via
`csv-parse/sync`, no native bindings, compatible with Node >=22 per
`package.json` engines).

## Testing

New Cypress spec `cypress/e2e/invite.cy.ts`:
- Happy path: valid CSV (few rows, one with no name) → summary shows
  correct sent count; templateData/name fallback exercised.
- Row with malformed email → skipped, reflected in summary, other valid
  rows still sent.
- CSV missing the required header row → whole upload rejected with an
  error, nothing sent.
- File exceeding the 200-row cap → whole upload rejected, nothing sent.
- File exceeding the size cap / wrong MIME type → rejected by multer
  before parsing.
- Invite route requires a valid `editToken` — request without/with wrong
  token is rejected the same way other edit routes are.

(Following this repo's test conventions: Cypress e2e only, no separate unit
test runner — see `CLAUDE.md`.)
