# CSV Bulk Invite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host upload a CSV of `name,email` rows from the event edit
modal and have gathio email each valid row a link to the event, with bad
rows skipped and summarized rather than failing the whole upload.

**Architecture:** A new pure module (`src/lib/invite.ts`) parses and
validates the uploaded CSV buffer (structure, row cap, per-row email
validity) and returns a `{ valid, skipped }` result with no I/O. A new route
`POST /event/:eventID/invite` (`src/routes/event.ts`) — gated by the same
`editToken` check every other host-only event route uses — accepts the file
via a dedicated `multer` instance, calls that parser, then loops over the
valid rows calling `req.emailService.sendEmailFromTemplate` with a new
`"inviteToEvent"` template, mirroring the existing `eventGroupUpdated`
broadcast loop. The frontend adds an "Invite people" card to the existing
edit modal, driven by a new small Alpine component in
`public/js/modules/event-edit.js`, independent of the existing
`editEventForm()` component and its submit handler.

**Tech Stack:** Express (TypeScript, `src/routes/`), `multer` (memory
storage) for uploads, `csv-parse` (new dependency) for CSV parsing,
Handlebars views + `handlebars-i18next`, Alpine.js in
`public/js/modules/`, Cypress e2e (no unit test runner in this repo).

**Spec:** `docs/superpowers/specs/2026-08-20-csv-bulk-invite-design.md`

## Global Constraints

- No `Attendee` records are created by this feature — invites only email a
  link; recipients RSVP themselves.
- CSV upload cap: **100KB** file size (multer `limits.fileSize`) and
  **200** data rows (checked in `parseInviteCsv`) — exceeding either
  rejects the *entire* upload before anything is sent.
- Per-row validation: missing/invalid email, or a `\r`/`\n` character in
  either the `email` or `name` field, skips that row (does not fail the
  upload); duplicate emails (case-insensitive) within one upload are
  deduped, keeping the first occurrence.
- Reuse `validateEmail` from `src/util/validation.ts` (export it) rather
  than writing a second email regex — same linear, non-backtracking
  pattern, one source of truth.
- Outbound email HTML template uses `{{name}}` (auto-escaped), never
  `{{{name}}}`.
- No new dependency beyond `csv-parse`; no new app-wide rate-limiting
  middleware (per spec's Non-goals).
- Repo has no unit test runner — verification is `pnpm build` (tsc),
  `pnpm exec eslint <file>`, `pnpm exec prettier --check <file>`, and
  Cypress e2e (`pnpm test`, needs a real MongoDB + a Cypress-capable
  browser environment; this sandbox lacks both, so the executor must
  actually run these against a working `pnpm dev`/`pnpm test` setup).
- `eslint.config.js` globally ignores all of `public/js/**` (vendored +
  app scripts alike), confirmed by running eslint directly against
  `public/js/modules/event-edit.js` — it reports "File ignored because of
  a matching ignore pattern" rather than linting it. This is pre-existing,
  matches `CLAUDE.md`'s note that `public/js/` is lint-ignored, and is not
  something this feature should change. `event-edit.js` changes are
  verified by `pnpm build` (irrelevant, it's not compiled), Prettier, and
  the Cypress e2e in Task 5 — not eslint.
- Running `pnpm lint` / bare `prettier --check .` unscoped from a repo
  root that has stray non-project dotfiles at its root (harness/IDE
  artifacts such as `.claude`, `.mcp.json`, `.idea`, `.vscode`) can fail
  with permission errors reading those paths in some sandboxed dev setups
  — unrelated to this feature's files. If that happens, scope the check
  to project paths instead, e.g.
  `pnpm exec prettier --check src public/js/modules cypress locales package.json config`
  and `pnpm exec eslint src cypress`, which cover everything this plan
  touches.

---

## Task 1: CSV parsing and validation module

**Files:**

- Create: `src/lib/invite.ts`
- Modify: `src/util/validation.ts:82` (export `validateEmail`)
- Modify: `package.json` (add `csv-parse` dependency)

**Interfaces:**

- Consumes: `validateEmail(email: string): boolean` (exported from
  `src/util/validation.ts` by this task).
- Produces: `parseInviteCsv(buffer: Buffer): ParseInviteCsvResult` and the
  types `ParsedInvite { name?: string; email: string }`,
  `SkippedInviteRow { row: number; reason: string }`, and
  `ParseInviteCsvResult = { ok: true; valid: ParsedInvite[]; skipped:
  SkippedInviteRow[] } | { ok: false; error: string }`, plus the exported
  constant `MAX_INVITE_ROWS = 200`. Task 3's route imports all of these
  from `../lib/invite.js`.

- [ ] **Step 1: Export `validateEmail`**

  In `src/util/validation.ts`, change line 82 from:

  ```typescript
  const validateEmail = (email: string) => {
  ```

  to:

  ```typescript
  export const validateEmail = (email: string) => {
  ```

- [ ] **Step 2: Add the `csv-parse` dependency**

  Run: `pnpm add csv-parse`

  This adds a `dependencies["csv-parse"]` entry to `package.json` and
  updates `pnpm-lock.yaml`. `csv-parse` ships its own TypeScript types, has
  no native bindings, and its synchronous API (`csv-parse/sync`) needs no
  extra `Node >= 22` accommodation.

- [ ] **Step 3: Write `src/lib/invite.ts`**

  ```typescript
  import { parse } from "csv-parse/sync";
  import { validateEmail } from "../util/validation.js";

  export const MAX_INVITE_ROWS = 200;

  export interface ParsedInvite {
    name?: string;
    email: string;
  }

  export interface SkippedInviteRow {
    row: number;
    reason: string;
  }

  export type ParseInviteCsvResult =
    | {
        ok: true;
        valid: ParsedInvite[];
        skipped: SkippedInviteRow[];
      }
    | {
        ok: false;
        error: string;
      };

  export function parseInviteCsv(buffer: Buffer): ParseInviteCsvResult {
    let records: Record<string, string>[];
    try {
      records = parse(buffer.toString("utf8"), {
        columns: (header: string[]) =>
          header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch {
      return { ok: false, error: "The file could not be parsed as CSV." };
    }

    if (records.length === 0) {
      return { ok: false, error: "The CSV file has no data rows." };
    }

    if (!Object.keys(records[0]).includes("email")) {
      return {
        ok: false,
        error: "The CSV file must have a header row with an \"email\" column.",
      };
    }

    if (records.length > MAX_INVITE_ROWS) {
      return {
        ok: false,
        error: `The CSV file has ${records.length} rows, which is more than the ${MAX_INVITE_ROWS}-row limit per upload.`,
      };
    }

    const valid: ParsedInvite[] = [];
    const skipped: SkippedInviteRow[] = [];
    const seenEmails = new Set<string>();

    records.forEach((record, index) => {
      const rowNumber = index + 2; // row 1 is the header
      const rawEmail = (record.email || "").trim();
      const rawName = (record.name || "").trim();

      if (/[\r\n]/.test(rawEmail) || /[\r\n]/.test(rawName)) {
        skipped.push({ row: rowNumber, reason: "invalid characters" });
        return;
      }
      if (!validateEmail(rawEmail)) {
        skipped.push({ row: rowNumber, reason: "invalid email" });
        return;
      }
      const normalizedEmail = rawEmail.toLowerCase();
      if (seenEmails.has(normalizedEmail)) {
        skipped.push({ row: rowNumber, reason: "duplicate email" });
        return;
      }
      seenEmails.add(normalizedEmail);
      valid.push({ email: rawEmail, name: rawName || undefined });
    });

    return { ok: true, valid, skipped };
  }
  ```

- [ ] **Step 4: Build and lint**

  Run: `pnpm build`
  Expected: compiles with no errors.

  Run: `pnpm exec eslint src/lib/invite.ts src/util/validation.ts`
  Expected: no errors.

  Run: `pnpm exec prettier --check src/lib/invite.ts src/util/validation.ts`
  Expected: passes. If not, run
  `pnpm exec prettier --write src/lib/invite.ts src/util/validation.ts`
  and re-check.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/invite.ts src/util/validation.ts package.json pnpm-lock.yaml
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add CSV parsing/validation module for bulk event invites

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 2: Invite email template

**Files:**

- Modify: `src/lib/email.ts:17-34` (`EmailTemplateName` union)
- Create: `views/emails/inviteToEvent/inviteToEventHtml.handlebars`
- Create: `views/emails/inviteToEvent/inviteToEventText.handlebars`
- Modify: `locales/en.json`

**Interfaces:**

- Consumes: none new.
- Produces: the `"inviteToEvent"` `EmailTemplateName` value and its paired
  templates, expecting `templateData: { name?: string; eventID: string;
  eventName: string }`. Task 3's route calls
  `sendEmailFromTemplate({ ..., templateName: "inviteToEvent", templateData
  })` with exactly this shape.

- [ ] **Step 1: Add `"inviteToEvent"` to the `EmailTemplateName` union**

  In `src/lib/email.ts`, insert alphabetically between `"eventGroupUpdated"`
  and `"removeEventAttendee"` (lines 29-30):

  ```typescript
  type EmailTemplateName =
    | "addEventAttendee"
    | "addEventComment"
    | "attendeeAwaitingApproval"
    | "attendeeAnswered"
    | "attendeeApproved"
    | "attendeeJoined"
    | "attendeePendingConfirmation"
    | "createEvent"
    | "createEventGroup"
    | "createEventMagicLink"
    | "declineEvent"
    | "deleteEvent"
    | "editEvent"
    | "eventGroupUpdated"
    | "inviteToEvent"
    | "removeEventAttendee"
    | "resendRemovalLink"
    | "subscribed"
    | "unattendEvent";
  ```

- [ ] **Step 2: Add the locale strings**

  Add to `locales/en.json` (flat key/value, matches existing style —
  placement in the file doesn't need to be alphabetical, existing entries
  aren't strictly sorted either):

  ```json
  "routes.invitetoeventsubject": "You're invited to {{ eventName }}",
  "views.emails.invitetoevent.eventlink": "View the event",
  "views.emails.invitetoevent.greeting": "Hi",
  "views.emails.invitetoevent.greetingfallback": "Hi there,",
  "views.emails.invitetoevent.preface": "You've been invited to an event on {{ siteName }}:",
  "views.emails.invitetoevent.viewevent": "View the event",
  ```

- [ ] **Step 3: Write the HTML email template**

  Create `views/emails/inviteToEvent/inviteToEventHtml.handlebars`
  (styling matches the existing `attendeeApproved` template's button
  block):

  ```handlebars
  <p style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;">{{#if name}}{{t "views.emails.invitetoevent.greeting" }} {{name}},{{else}}{{t "views.emails.invitetoevent.greetingfallback" }}{{/if}}</p>
  <p style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;">{{t "views.emails.invitetoevent.preface" }} <strong>{{eventName}}</strong>.</p>

  <table border="0" cellpadding="0" cellspacing="0" class="btn btn-primary" style="border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; width: 100%; box-sizing: border-box;">
    <tbody>
      <tr>
        <td align="left" style="font-family: sans-serif; font-size: 14px; vertical-align: top; padding-bottom: 15px;">
          <table border="0" cellpadding="0" cellspacing="0" style="border-collapse: separate; mso-table-lspace: 0pt; mso-table-rspace: 0pt; width: auto;">
            <tbody>
              <tr>
                <td style="font-family: sans-serif; font-size: 14px; vertical-align: top; background-color: #28a745; border-radius: 5px; text-align: center;"> <a href="https://{{domain}}/{{eventID}}" target="_blank" style="display: inline-block; color: #ffffff; background-color: #28a745; border: solid 1px #28a745; border-radius: 5px; box-sizing: border-box; cursor: pointer; text-decoration: none; font-size: 14px; font-weight: bold; margin: 0; padding: 12px 25px; text-transform: capitalize; border-color: #28a745;">{{t "views.emails.invitetoevent.viewevent" }}</a> </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
    </tbody>
  </table>

  <p style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;">{{t "views.emails.love" }}</p>
  <p style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;">{{siteName}}</p>
  ```

- [ ] **Step 4: Write the plain-text email template**

  Create `views/emails/inviteToEvent/inviteToEventText.handlebars`:

  ```handlebars
  {{#if name}}{{t "views.emails.invitetoevent.greeting" }} {{name}},{{else}}{{t "views.emails.invitetoevent.greetingfallback" }}{{/if}}

  {{t "views.emails.invitetoevent.preface" }} {{eventName}}.

  {{t "views.emails.invitetoevent.eventlink" }}: https://{{domain}}/{{eventID}}

  {{t "views.emails.love" }}
  {{siteName}}
  ```

- [ ] **Step 5: Build and validate**

  Run: `pnpm build`
  Expected: compiles with no errors (confirms the `EmailTemplateName`
  union edit is syntactically valid TypeScript).

  Run: `python3 -c "import json; json.load(open('locales/en.json')); print('valid json')"`
  Expected: `valid json`.

  Run: `pnpm exec prettier --check locales/en.json`
  Expected: passes (or `pnpm exec prettier --write locales/en.json`, then
  re-check). Note `views/` is Prettier-ignored per `CLAUDE.md`, so the two
  new `.handlebars` files need no Prettier check.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/email.ts locales/en.json views/emails/inviteToEvent
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add inviteToEvent email template

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 3: Backend route — `POST /event/:eventID/invite`

**Files:**

- Modify: `src/routes/event.ts:56-64` (add a `csvUpload` multer instance
  next to the existing `icsUpload`)
- Modify: `src/routes/event.ts:626-628` (insert the new route between the
  end of the `PUT /event/:eventID` handler and the start of
  `POST /import/event`)

**Interfaces:**

- Consumes: `parseInviteCsv`, `MAX_INVITE_ROWS` (`src/lib/invite.ts`,
  Task 1), `EmailTemplateName: "inviteToEvent"` and its templates
  (Task 2), `Event` model, `addToLog` (`src/helpers.ts`), `i18next`
  (already imported in this file).
- Produces: `POST /event/:eventID/invite` (multipart field name
  `csvUpload`, requires `editToken` via `?e=` query or `editToken` body
  field — same pattern as the existing attendee-approval routes at
  `event.ts:1209-1218`). Responds `200 { sent: number; skipped: number;
  skippedReasons: string[] }` on success, or `400`/`403`/`404` `{ errors:
  [{ message: string }] }` on failure. Task 4's frontend code calls this
  exact route/shape.

- [ ] **Step 1: Add the `csvUpload` multer instance**

  In `src/routes/event.ts`, immediately after the existing `icsUpload`
  block (after line 64, before the blank line at 65):

  ```typescript
  const csvUpload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 },
    fileFilter: function (_, file, cb) {
      const allowedMimetypes = ["text/csv", "application/vnd.ms-excel", "text/plain"];
      if (!allowedMimetypes.includes(file.mimetype)) {
        return cb(new Error("Only CSV files are allowed."));
      }
      cb(null, true);
    },
  });
  ```

- [ ] **Step 2: Add the `parseInviteCsv` import**

  Add to the import block near the top of `src/routes/event.ts`, alongside
  the other `../lib/*` imports:

  ```typescript
  import { parseInviteCsv } from "../lib/invite.js";
  ```

- [ ] **Step 3: Add the route**

  Insert between the closing `);` of the `PUT /event/:eventID` handler
  (line 626) and `router.post("/import/event", ...)` (line 628):

  ```typescript
  router.post(
    "/event/:eventID/invite",
    csvUpload.single("csvUpload"),
    async (req: Request, res: Response) => {
      if (!req.file) {
        return res.status(400).json({
          errors: [{ message: "No CSV file was provided." }],
        });
      }

      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.status(404).json({
          errors: [{ message: "Event not found." }],
        });
      }

      const submittedEditToken = req.query.e || req.body.editToken;
      if (!submittedEditToken || event.editToken !== submittedEditToken) {
        addToLog(
          "inviteToEvent",
          "error",
          `Attempt to send invites for event ${req.params.eventID} failed with error: token does not match`,
        );
        return res.status(403).json({
          errors: [{ message: "Edit token is invalid." }],
        });
      }

      const parsed = parseInviteCsv(req.file.buffer);
      if (!parsed.ok) {
        return res.status(400).json({ errors: [{ message: parsed.error }] });
      }

      const subject = i18next.t("routes.invitetoeventsubject", {
        eventName: event.name,
      });
      await Promise.all(
        parsed.valid.map((invite) =>
          req.emailService.sendEmailFromTemplate({
            to: invite.email,
            subject,
            templateName: "inviteToEvent",
            templateData: {
              name: invite.name,
              eventID: event.id,
              eventName: event.name,
            },
          }),
        ),
      );

      addToLog(
        "inviteToEvent",
        "success",
        `Sent ${parsed.valid.length} invite(s) for event ${req.params.eventID}, skipped ${parsed.skipped.length}`,
      );

      return res.json({
        sent: parsed.valid.length,
        skipped: parsed.skipped.length,
        skippedReasons: parsed.skipped.map(
          (s) => `Row ${s.row}: ${s.reason}`,
        ),
      });
    },
  );
  ```

- [ ] **Step 4: Build and lint**

  Run: `pnpm build`
  Expected: compiles with no errors.

  Run: `pnpm exec eslint src/routes/event.ts`
  Expected: no errors.

  Run: `pnpm exec prettier --check src/routes/event.ts`
  Expected: passes (or `pnpm exec prettier --write src/routes/event.ts`,
  then re-check).

- [ ] **Step 5: Manual smoke test**

  With MongoDB running and the app started (`CYPRESS=true pnpm run start`
  in one terminal, after `pnpm build`), create an event via the UI, note
  its `eventID` and `editToken` from the resulting URL, then:

  ```bash
  printf 'name,email\nAda Lovelace,ada@example.com\nBad Row,not-an-email\n' > $TMPDIR
  curl -s -X POST "http://localhost:3000/event/<eventID>/invite?e=<editToken>" \
    -F "csvUpload=@$TMPDIR"
  ```

  Expected: `{"sent":1,"skipped":1,"skippedReasons":["Row 3: invalid email"]}`.
  Also try omitting `?e=...` and confirm a `403`.

- [ ] **Step 6: Commit**

  ```bash
  git add src/routes/event.ts
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add POST /event/:eventID/invite route for CSV bulk invites

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 4: Frontend — "Invite people" section in the edit modal

**Files:**

- Modify: `views/partials/editeventmodal.handlebars:15-31`
- Modify: `public/js/modules/event-edit.js`
- Modify: `locales/en.json`

**Interfaces:**

- Consumes: `POST /event/:eventID/invite` (Task 3) — `FormData` field
  `csvUpload`, query param `?e={editToken}`; response `{ sent, skipped,
  skippedReasons }` or `{ errors: [{ message }] }`.
- Produces: no new interfaces for later tasks — this is the last
  application-code task; Task 5 tests it end-to-end.

- [ ] **Step 1: Add the locale strings**

  Add to `locales/en.json`:

  ```json
  "views.partials.editevent.invite.description": "Upload a CSV file with \"name\" and \"email\" columns to email each person a link to this event. Up to 200 rows per upload.",
  "views.partials.editevent.invite.filelabel": "Choose CSV file",
  "views.partials.editevent.invite.heading": "Invite people",
  "views.partials.editevent.invite.send": "Send invites",
  "views.partials.editevent.invite.sending": "Sending...",
  ```

- [ ] **Step 2: Add the "Invite people" card to the edit modal**

  In `views/partials/editeventmodal.handlebars`, insert a new card between
  the closing `{{> eventForm }}` (line 18) and the existing "Delete this
  event" `form-group` div (lines 20-29), inside the same `<form
  id="editEventForm">`:

  ```handlebars
          {{> eventForm }}

          <div class="form-group" x-data="inviteForm()">
            <div class="card mb-3">
              <div class="card-header">{{t "views.partials.editevent.invite.heading" }}</div>
              <div class="card-body">
                <p>{{t "views.partials.editevent.invite.description" }}</p>
                <input type="file" class="form-control-file" accept=".csv,text/csv" x-ref="csvUpload" id="invite-csv-upload">
                <div class="mt-2">
                  <button type="button" class="button button--secondary" @click="sendInvites" x-bind:disabled="sending" x-text="sending ? '{{t "views.partials.editevent.invite.sending" }}' : '{{t "views.partials.editevent.invite.send" }}'"></button>
                </div>
                <p class="mt-2" x-show="summary" x-text="summary" id="invite-summary"></p>
                <p class="mt-2 text-danger" x-show="error" x-text="error" id="invite-error"></p>
              </div>
            </div>
          </div>

          <div class="form-group">
            <div class="card border-danger mb-3">
  ```

  (The last line above is the existing line 21 — only the new block is
  inserted before it; the delete-event card and everything after it is
  unchanged.)

- [ ] **Step 3: Add the `inviteForm()` Alpine component**

  Append to `public/js/modules/event-edit.js`:

  ```javascript
  function inviteForm() {
    return {
      sending: false,
      summary: "",
      error: "",
      async sendInvites() {
        const file = this.$refs.csvUpload.files[0];
        if (!file) {
          this.error = "Please choose a CSV file first.";
          this.summary = "";
          return;
        }
        this.sending = true;
        this.error = "";
        this.summary = "";
        const formData = new FormData();
        formData.append("csvUpload", file);
        try {
          const response = await fetch(
            `/event/${window.eventData.id}/invite?e=${window.eventData.editToken}`,
            { method: "POST", body: formData },
          );
          this.sending = false;
          const json = await response.json();
          if (!response.ok) {
            this.error =
              json.errors && json.errors[0]
                ? json.errors[0].message
                : "Could not send invites.";
            return;
          }
          this.summary = `${json.sent} invite(s) sent, ${json.skipped} skipped.`;
          if (json.skippedReasons && json.skippedReasons.length) {
            this.summary += ` (${json.skippedReasons.join("; ")})`;
          }
          this.$refs.csvUpload.value = "";
        } catch (err) {
          console.log(err);
          this.sending = false;
          this.error = "Could not send invites.";
        }
      },
    };
  }
  ```

- [ ] **Step 4: Build and lint**

  Run: `pnpm build`
  Expected: compiles with no errors.

  Skip eslint on this file: `eslint.config.js` globally ignores all of
  `public/js/**` (see Global Constraints), so `pnpm exec eslint
  public/js/modules/event-edit.js` only reports "File ignored because of a
  matching ignore pattern" — not a real check. This matches existing
  repo/CLAUDE.md convention; do not change the eslint config to force it.

  Run: `pnpm exec prettier --check public/js/modules/event-edit.js locales/en.json`
  Expected: passes (or `--write` then re-check). `views/` stays
  Prettier-ignored.

  Run: `python3 -c "import json; json.load(open('locales/en.json')); print('valid json')"`
  Expected: `valid json`.

- [ ] **Step 5: Manual UI smoke test**

  With `pnpm dev` (or `CYPRESS=true pnpm run start` after `pnpm build`)
  running and MongoDB up: create an event in the browser, open the event
  page with the edit link, click "Edit", confirm the new "Invite people"
  card renders, upload a small CSV (`name,email` header + one valid row),
  click "Send invites", and confirm the summary text appears (e.g. "1
  invite(s) sent, 0 skipped.").

- [ ] **Step 6: Commit**

  ```bash
  git add views/partials/editeventmodal.handlebars public/js/modules/event-edit.js locales/en.json
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add "Invite people" CSV upload UI to the event edit modal

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 5: Cypress e2e coverage

**Files:**

- Create: `cypress/e2e/invite.cy.ts`

**Interfaces:**

- Consumes: the full stack built in Tasks 1-4 — no new production code.

- [ ] **Step 1: Write the spec**

  Create `cypress/e2e/invite.cy.ts`, modeled on the `beforeEach` in
  `cypress/e2e/event.cy.ts` (create an event via the UI, capture
  `eventID`/`editToken` from the resulting URL, stay on that page since
  `#editEvent` is already visible there):

  ```typescript
  import eventData from "../fixtures/eventData.json";

  function csvFile(contents: string, fileName = "invites.csv") {
    return {
      contents: Cypress.Buffer.from(contents),
      fileName,
      mimeType: "text/csv",
    };
  }

  describe("CSV bulk invite", () => {
    beforeEach(() => {
      cy.visit("/new");
      cy.get("#showNewEventFormButton").click();

      cy.get("#eventName").type(eventData.eventName);
      cy.get("#eventLocation").type(eventData.eventLocation);
      cy.get("#eventStart").type(eventData.eventStart);
      cy.get("#eventEnd").type(eventData.eventEnd);

      cy.get("select#timezone + span.select2").click();
      cy.get(".select2-results__option")
        .contains(eventData.timezone)
        .click({ force: true });

      cy.get("#eventDescription").type(eventData.eventDescription);
      cy.get("#eventURL").type(eventData.eventURL);
      cy.get("#hostName").type(eventData.hostName);
      cy.get("#creatorEmail").type(eventData.creatorEmail);
      cy.get("#joinCheckbox").check();

      cy.get("#newEventFormSubmit").click();
      cy.url({ timeout: 10000 }).should("not.include", "/new");

      cy.url().then((url) => {
        const [eventID, editToken] = url.split("/").pop()!.split("?");
        cy.wrap(eventID).as("eventID");
        cy.wrap(editToken.slice(2)).as("editToken");
      });

      cy.get("#editEvent").click();
      cy.get("#editModal").should("be.visible");
    });

    it("sends valid rows and reports skipped rows in the summary", function () {
      cy.get("#invite-csv-upload").selectFile(
        csvFile(
          "name,email\nAda Lovelace,ada@example.com\nBad Row,not-an-email\n",
        ),
        { force: true },
      );
      cy.get("#editModal button").contains("Send invites").click();
      cy.get("#invite-summary").should(
        "contain.text",
        "1 invite(s) sent, 1 skipped.",
      );
      cy.get("#invite-summary").should("contain.text", "invalid email");
    });

    it("rejects a CSV missing the email column", function () {
      cy.get("#invite-csv-upload").selectFile(
        csvFile("name,phone\nAda Lovelace,555-0100\n"),
        { force: true },
      );
      cy.get("#editModal button").contains("Send invites").click();
      cy.get("#invite-error").should("contain.text", "email");
    });

    it("rejects a CSV with more than 200 data rows", function () {
      const header = "name,email\n";
      const rows = Array.from(
        { length: 201 },
        (_, i) => `Person ${i},person${i}@example.com`,
      ).join("\n");
      cy.get("#invite-csv-upload").selectFile(csvFile(header + rows), {
        force: true,
      });
      cy.get("#editModal button").contains("Send invites").click();
      cy.get("#invite-error").should("contain.text", "row limit");
    });

    it("rejects a non-CSV file", function () {
      cy.get("#invite-csv-upload").selectFile(
        {
          contents: Cypress.Buffer.from("not a csv"),
          fileName: "invites.txt",
          mimeType: "application/octet-stream",
        },
        { force: true },
      );
      cy.get("#editModal button").contains("Send invites").click();
      // A rejected fileFilter surfaces as a failed fetch (non-JSON error
      // response), which the Alpine handler's catch block reports.
      cy.get("#invite-error").should("be.visible");
    });

    it("rejects an invite request without a valid editToken", function () {
      cy.request({
        method: "POST",
        url: "/event/nonexistent-event-id/invite",
        failOnStatusCode: false,
      }).then((response) => {
        expect(response.status).to.eq(400);
      });
    });
  });
  ```

- [ ] **Step 2: Run the new spec**

  Run: `pnpm build`

  Run (in one terminal): `CYPRESS=true pnpm run start`

  Run (in another, once the server is up):
  `pnpm exec cypress run --e2e --browser chrome --spec cypress/e2e/invite.cy.ts`

  Expected: all 5 tests pass. If the "rejects a non-CSV file" test is
  flaky because the fetch error path differs from expected, adjust the
  assertion to match the actual observed `#invite-error` text rather than
  changing production behavior.

- [ ] **Step 3: Commit**

  ```bash
  git add cypress/e2e/invite.cy.ts
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add Cypress e2e coverage for CSV bulk invite

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 6: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

  Run: `pnpm build`
  Expected: no errors.

- [ ] **Step 2: Full lint**

  Run: `pnpm lint`
  Expected: no errors (eslint + prettier --check across the repo). If this
  fails on permission errors reading non-project dotfiles at the repo root
  (see Global Constraints), run the scoped equivalent instead:
  `pnpm exec eslint src cypress` and
  `pnpm exec prettier --check src public/js/modules cypress locales package.json config`.

- [ ] **Step 3: Full Cypress suite**

  Run: `pnpm test`
  Expected: all specs pass, including the new `invite.cy.ts` alongside the
  existing suite (confirms the new route/multer instance/locale keys
  didn't regress `event.cy.ts`, `group.cy.ts`, etc.).

- [ ] **Step 4: Report**

  Summarize what was built and confirm all three checks above passed. No
  further commit needed — this task is verification-only.
