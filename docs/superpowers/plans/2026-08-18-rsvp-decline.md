# RSVP Decline ("Can't Attend") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an event viewer explicitly say "I can't attend," give the host
a private, named list of who declined, and let anyone switch between
attending/declined without re-entering their details.

**Architecture:** `Attendee.status` (already a loose string field) gains a
third value, `"declined"`, alongside the existing `"provisioned"` and
`"attending"`. The existing provision → modal → POST flow used for RSVPing
is reused for declining (same `removalPassword`, same
`/attendee/provision` endpoint), so declining and attending are just two
target statuses on the same record, switchable with a single click once a
record exists. The host-only "Can't attend" card and the RSVP bar's fourth
state are driven by the same `resolveLocationAccess`/attendee-processing
code already added for the "You're going" / "Pending approval" states.

**Tech Stack:** Express (TypeScript, `src/routes/`), Mongoose 5
(`src/models/Event.ts`), Handlebars views (`views/event.handlebars`),
jQuery/axios in inline `<script>` (no bundler), Cypress e2e (no unit test
runner in this repo).

**Spec:** `docs/superpowers/specs/2026-08-18-rsvp-decline-design.md`

## Global Constraints

- `Attendee.status` values: `"provisioned"`, `"attending"`, `"declined"` —
  no schema/migration change (loose string field).
- Declining never requires host approval and never consumes
  `maxAttendees` capacity.
- Declining asks for a name only — no email, no custom questions, no
  headcount.
- The "Can't attend" list is host-only (`editingEnabled`) — never shown to
  the public or other attendees.
- Switching attending ↔ declined replaces the existing record in place (same
  `removalPassword`) — never creates a duplicate.
- The federation-specific `GET /oneclickunattendevent/:eventID/:attendeeID`
  route (`src/routes.js:537`) and the host's own
  `DELETE /event/:eventID/attendee/:attendeeID` removal route
  (`src/routes/event.ts:1076`) are **out of scope** — do not touch them.
- Button/indicator copy is exact: **"RSVP: Going"**, **"RSVP: Not Going"**,
  "You're going", "Pending approval", "You said you can't attend",
  "Can't attend".
- Repo has no unit test runner — verification is `pnpm build` (tsc),
  `pnpm exec eslint <file>`, `pnpm exec prettier --check <file>`, the
  Handlebars precompile parse-check pattern already used on this branch,
  and Cypress e2e (`pnpm test`, needs a real MongoDB + a Cypress-capable
  browser environment; this sandbox lacks both, so the executor must
  actually run these against a working `pnpm dev`/`pnpm test` setup).

---

## Task 1: Backend — decline and toggle support in the attendee POST route

**Files:**

- Modify: `src/routes/event.ts:833-975` (`POST /event/:eventID/attendee`)
- Modify: `locales/en.json` (`views.event.addme`, `views.event.removeme`)

**Interfaces:**

- Consumes: `Event` model (`src/models/Event.ts`), `getApprovedAttendeeCount`,
  `collectCustomQuestionAnswers` (local fn, `src/routes/event.ts:73`),
  `notifyHostOfNewAttendee` (`src/lib/email.ts:275`).
- Produces: the route now accepts an optional `attendeeStatus` field in the
  POST body (`"attending"` | `"declined"`, defaults to `"attending"` for
  backward compatibility with the existing form). Later tasks (bar UI, decline
  modal, e2e tests) POST this field to reach the decline/toggle behavior.

- [ ] **Step 1: Update the two locale strings the bar/modal buttons will use**

  Edit `locales/en.json`:

  ```json
  "views.event.addme": "RSVP: Going",
  ```

  ```json
  "views.event.removeme": "RSVP: Not Going",
  ```

  (Both keys already exist — from `git log`, `addme` currently reads "RSVP"
  and `removeme` currently reads "I cannot go". Change only the values,
  leave the keys.)

- [ ] **Step 2: Rewrite the route to branch on target status**

  Replace `src/routes/event.ts:833-975` (the full `POST
/event/:eventID/attendee` handler) with:

  ```typescript
  router.post(
    "/event/:eventID/attendee",
    async (req: Request, res: Response) => {
      const {
        removalPassword,
        attendeeName,
        attendeeEmail,
        attendeeNumber,
        attendeeVisible,
        attendeeStatus,
      } = req.body;

      const targetStatus: "attending" | "declined" =
        attendeeStatus === "declined" ? "declined" : "attending";

      if (!removalPassword) {
        return res.status(400).json({ error: "Removal password is required." });
      }

      try {
        const event = await Event.findOne({ id: req.params.eventID });
        if (!event) {
          return res.status(404).json({ error: "Event not found." });
        }

        const attendee = event.attendees?.find(
          (a) => a.removalPassword === removalPassword,
        );
        if (!attendee) {
          return res.status(404).json({ error: "Attendee not found." });
        }

        // Check if this is the host adding an attendee (via edit token)
        const editToken = req.query.e || req.body.editToken;
        const isHostAdding = editToken && editToken === event.editToken;

        if (targetStatus === "declined") {
          // Declining: name only, no capacity check, no approval, no custom
          // questions, no confirmation email (no email is ever collected).
          const name = attendeeName || attendee.name;
          if (!name) {
            return res.status(400).json({ error: "Name is required." });
          }
          attendee.status = "declined";
          attendee.name = name;

          event.markModified("attendees");
          await event.save();

          addToLog(
            "declineEventAttendee",
            "success",
            `Attendee declined event ${req.params.eventID}`,
          );

          if (isHostAdding) {
            return res.redirect(`/${req.params.eventID}?e=${editToken}`);
          }
          return res.redirect(
            `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}`,
          );
        }

        // targetStatus === "attending" — covers both the original full-form
        // RSVP and a one-click "switch back to attending" toggle (which sends
        // only removalPassword + attendeeStatus, no other fields). Fields not
        // present in the request keep their existing value on the record.
        const effectiveNumber =
          attendeeNumber !== undefined
            ? parseInt(attendeeNumber, 10) || 1
            : attendee.number || 1;

        // Check capacity - for approval-required events, only count approved attendees
        if (event.maxAttendees !== null && event.maxAttendees !== undefined) {
          const freeSpots =
            event.maxAttendees - getApprovedAttendeeCount(event);
          if (effectiveNumber > freeSpots) {
            return res
              .status(403)
              .json({ error: "Not enough spots available." });
          }
        }

        // Collect answers to the event's custom questions. This is a plain form
        // POST, so a bad answer redirects with a message rather than serving raw
        // JSON. Skipped entirely for a bare toggle (no question fields present).
        const hasQuestionFields = Object.keys(req.body).some((key) =>
          key.startsWith("customQuestion_"),
        );
        let answers = attendee.answers || [];
        if (hasQuestionFields) {
          const collected = collectCustomQuestionAnswers(event, req.body);
          if (collected === null) {
            return res.redirect(`/${req.params.eventID}?m=badanswer`);
          }
          answers = collected;
        }

        // Update attendee
        attendee.status = "attending";
        attendee.name = attendeeName || attendee.name;
        attendee.email =
          attendeeEmail !== undefined ? attendeeEmail : attendee.email;
        attendee.number = effectiveNumber;
        attendee.visibility =
          attendeeVisible !== undefined
            ? attendeeVisible
              ? "public"
              : "private"
            : attendee.visibility || "public";
        attendee.answers = answers;

        // Auto-approve if host is adding, or if event doesn't require approval
        if (isHostAdding || !event.approveRegistrations) {
          attendee.approved = true;
        }

        // Mark subdocument as modified so Mongoose detects changes
        event.markModified("attendees");
        await event.save();

        addToLog(
          "addEventAttendee",
          "success",
          `Attendee added to event ${req.params.eventID}`,
        );

        // Send confirmation email to attendee
        if (attendeeEmail && attendee.approved) {
          try {
            await req.emailService.sendEmailFromTemplate({
              to: attendeeEmail,
              subject: i18next.t("routes.addeventattendeesubject", {
                eventName: event.name,
              }),
              templateName: "addEventAttendee",
              templateData: {
                eventID: req.params.eventID,
                removalPassword,
                removalPasswordHash: hashString(removalPassword),
                answers,
              },
            });
          } catch (e) {
            console.error("Error sending addEventAttendee email:", e);
          }
        } else if (attendeeEmail && !attendee.approved) {
          try {
            await req.emailService.sendEmailFromTemplate({
              to: attendeeEmail,
              subject: i18next.t("routes.attendeependingconfirmationsubject", {
                eventName: event.name,
              }),
              templateName: "attendeePendingConfirmation",
              templateData: {
                eventID: req.params.eventID,
                eventName: event.name,
                removalPassword,
              },
            });
          } catch (e) {
            console.error(
              "Error sending attendeePendingConfirmation email:",
              e,
            );
          }
        }

        // Notify the host of the new RSVP, unless they added the attendee
        // themselves
        if (!isHostAdding) {
          await notifyHostOfNewAttendee({
            emailService: req.emailService,
            event,
            attendeeName: attendee.name,
            answers,
            logProcess: "addEventAttendee",
          });
        }

        // Redirect appropriately based on who is adding the attendee
        if (isHostAdding) {
          // Host added attendee - redirect back to edit view
          return res.redirect(`/${req.params.eventID}?e=${editToken}`);
        } else if (event.approveRegistrations) {
          // Approval required - show save link modal since location is hidden until approved
          return res.redirect(
            `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}&m=rsvppending`,
          );
        } else {
          // No approval needed - just redirect with ?p
          return res.redirect(
            `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}`,
          );
        }
      } catch (e) {
        addToLog(
          "addEventAttendee",
          "error",
          `Attempt to add attendee to event ${req.params.eventID} failed with error: ${e}`,
        );
        return res.status(500).json({ error: "An unexpected error occurred." });
      }
    },
  );
  ```

  Note the `notifyHostOfNewAttendee` call now passes `attendee.name` instead
  of the raw `attendeeName` variable, so a bare toggle (no `attendeeName` in
  the body) still notifies with the attendee's actual name rather than
  `undefined` — though in practice the toggle path only reaches "attending"
  when switching back from "declined", which already has a name on file.

- [ ] **Step 2: Build and lint**

  Run: `pnpm build`
  Expected: `tsc` completes with no errors.

  Run: `pnpm exec eslint src/routes/event.ts`
  Expected: no output (clean).

  Run: `pnpm exec prettier --check src/routes/event.ts locales/en.json`
  Expected: `All matched files use Prettier code style!` (if not, run
  `pnpm exec prettier --write src/routes/event.ts locales/en.json` and
  re-check).

- [ ] **Step 3: Commit**

  ```bash
  git add src/routes/event.ts locales/en.json
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Support declining and toggling RSVP status in the attendee route

  Extends POST /event/:eventID/attendee to accept an attendeeStatus of
  "declined" (name only, no capacity/approval/email) alongside the
  existing "attending" flow, and lets an existing record toggle between
  the two with a single field-sparse request.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 2: Backend — emailed unattend link declines instead of deletes

**Files:**

- Modify: `src/routes/event.ts:796-831` (`GET
/event/:eventID/unattend/:removalPasswordHash`)
- Create: `views/emails/declineEvent/declineEventHtml.handlebars`
- Create: `views/emails/declineEvent/declineEventText.handlebars`
- Modify: `locales/en.json` (new `declineevent` keys)
- Modify: `src/lib/email.ts` (register the new template name, if templates
  are typed there)

**Interfaces:**

- Consumes: `Event` model, `hashString` (`src/util/generator.ts`),
  `req.emailService.sendEmailFromTemplate` (existing `EmailService` API used
  identically to the `unattendEvent` template elsewhere in this file).
- Produces: nothing new consumed by later tasks — this is a leaf change.

- [ ] **Step 1: Check how email template names are typed**

  Run: `grep -n "EmailTemplateName" src/lib/email.ts | head -5`

  If `EmailTemplateName` is a string union type listing every template
  (e.g. `"addEventAttendee" | "unattendEvent" | ...`), add `"declineEvent"`
  to that union. If it's a plain `string`, skip this — no type change
  needed.

- [ ] **Step 2: Add the new email template's locale strings**

  Add to `locales/en.json`, near the existing `unattendevent` keys:

  ```json
  "routes.declineeventattendeesubject": "Your RSVP has been updated",
  "views.emails.declineevent.preface": "You've let {{siteName}} know you can't attend {{eventName}}.",
  "views.emails.declineevent.desc": "If you change your mind, you can RSVP again at any time from the event page.",
  "views.emails.declineevent.dontknow": "If you didn't do this, someone else may have access to your RSVP link. You can RSVP again from the event page at any time.",
  ```

- [ ] **Step 3: Create the HTML email template**

  Write `views/emails/declineEvent/declineEventHtml.handlebars`, modeled on
  the existing `views/emails/unattendEvent/unattendEventHtml.handlebars`:

  ```handlebars
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{t "views.emails.declineevent.preface"}}</p>
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{t "views.emails.declineevent.desc"}}</p>
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{t "views.emails.addeventattendee.eventlink"}}:
    <a
      href="https://{{domain}}/{{eventID}}"
    >https://{{domain}}/{{eventID}}</a></p>
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{t "views.emails.love"}}</p>
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{siteName}}</p>
  <hr />
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  ><strong>{{t "views.emails.holdup"}}</strong></p>
  <p
    style="font-family: sans-serif; font-size: 14px; font-weight: normal; margin: 0; Margin-bottom: 15px;"
  >{{t "views.emails.declineevent.dontknow"}}</p>
  ```

- [ ] **Step 4: Create the plain-text email template**

  Run: `cat views/emails/unattendEvent/unattendEventText.handlebars` first
  to copy its exact structure, then write
  `views/emails/declineEvent/declineEventText.handlebars` following the same
  structure but with the `declineevent` locale keys from Step 2 in place of
  `unattendevent`'s.

- [ ] **Step 5: Change the route to decline instead of delete**

  Replace `src/routes/event.ts:796-831`:

  ```typescript
  // Used to one-click unattend an event from an email.
  router.get(
    "/event/:eventID/unattend/:removalPasswordHash",
    async (req: Request, res: Response) => {
      // Find the attendee by the unattendPasswordHash
      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.redirect("/404");
      }
      const attendee = event.attendees?.find(
        (o) =>
          hashString(o.removalPassword || "") ===
          req.params.removalPasswordHash,
      );
      if (!attendee) {
        return res.redirect(`/${req.params.eventID}`);
      }
      // Mark the attendee as declined rather than deleting their record
      attendee.status = "declined";
      event.markModified("attendees");
      await event.save();
      // Send email to the attendee
      if (attendee.email) {
        req.emailService.sendEmailFromTemplate({
          to: attendee.email,
          subject: i18next.t("routes.declineeventattendeesubject"),
          templateName: "declineEvent",
          templateData: {
            eventID: req.params.eventID,
            eventName: event.name,
          },
        });
      }
      addToLog(
        "declineEventAttendee",
        "success",
        `Attendee declined event ${req.params.eventID} via one-click link`,
      );
      return res.redirect(
        `/${req.params.eventID}?p=${encodeURIComponent(attendee.removalPassword || "")}`,
      );
    },
  );
  ```

  `domain` and `siteName` are not passed here because
  `EmailService.sendEmailFromTemplate` (`src/lib/email.ts:216-249`) already
  injects both into every template's data automatically — the same reason
  the neighboring `addEventAttendee` call in this file (`src/routes/event.ts:905-917`)
  doesn't pass them either.

  Note the rewritten route no longer redirects with `?m=unattend` (it
  redirects straight to `?p=...`, since the bar itself now communicates the
  outcome) — Step 6 below removes the now-orphaned message.

- [ ] **Step 6: Remove the now-unused "unattend" message**

  `src/util/messages.ts`'s `unattend` entry
  (`"You have been removed from this event."`) was only ever produced by
  the route just rewritten in Step 5 — confirmed by
  `grep -rn "m=unattend" src/` matching only that one call site. Since
  Step 5 no longer redirects with `?m=unattend`, remove the entry:

  In `src/util/messages.ts`, delete `| "unattend"` from the `MessageId`
  union type and delete the `unattend: ...` line from
  `queryStringMessages`.

- [ ] **Step 7: Build, lint, and parse-check**

  Run: `pnpm build`
  Expected: no errors.

  Run: `pnpm exec eslint src/routes/event.ts`
  Expected: clean.

  Run:

  ```bash
  node -e "
  const fs = require('fs');
  const Handlebars = require('handlebars');
  for (const f of ['views/emails/declineEvent/declineEventHtml.handlebars', 'views/emails/declineEvent/declineEventText.handlebars']) {
    Handlebars.precompile(fs.readFileSync(f, 'utf8'));
    console.log('OK:', f);
  }
  "
  ```

  Expected: both print `OK: <path>`.

- [ ] **Step 8: Commit**

  ```bash
  git add src/routes/event.ts src/util/messages.ts locales/en.json views/emails/declineEvent
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Make the emailed unattend link decline instead of delete

  GET /event/:eventID/unattend/:removalPasswordHash now marks the
  attendee's status as declined and sends a new declineEvent
  confirmation email, rather than deleting their record outright.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 3: Backend — detect the declined viewer state and build the host's decline list

**Files:**

- Modify: `src/routes/frontend.ts:141-201` (`resolveLocationAccess`)
- Modify: `src/routes/frontend.ts:405-414` (destructure call site)
- Modify: `src/routes/frontend.ts` (attendee-processing block, after
  `rawAttendees`/`attendees` construction, roughly lines 462-534)
- Modify: `src/routes/frontend.ts:574-...` (`res.render("event", {...})` call)

**Interfaces:**

- Consumes: `AttendeeLite` interface (`src/routes/frontend.ts:32-42`),
  `AttendeeView` interface (`src/routes/frontend.ts:58-71`), `stringToColor`
  (`src/routes/frontend.ts:104`).
- Produces: `resolveLocationAccess` now also returns `viewerDeclined:
boolean`. The template context gains `viewerDeclined`,
  `declinedAttendees: { id: string; name: string; avatarLetter: string;
avatarColor: string }[]`, and `numberOfDeclined: number` — Task 5 (host
  card) and Task 4 (bar) consume these by name.

- [ ] **Step 1: Widen the viewer-attendee lookup to match declined records too**

  In `resolveLocationAccess` (`src/routes/frontend.ts`), the `viewerAttendee`
  lookup added on `feat/rsvp-floating-bar` currently is:

  ```typescript
  let viewerAttendee: AttendeeLite | undefined;
  if (!editingEnabled && query.p) {
    const removalPassword = String(query.p);
    viewerAttendee = (event.attendees as AttendeeLite[] | undefined)?.find(
      (a: AttendeeLite) =>
        a.removalPassword === removalPassword && a.status === "attending",
    );
  }
  ```

  Change the status check to accept both statuses:

  ```typescript
  let viewerAttendee: AttendeeLite | undefined;
  if (!editingEnabled && query.p) {
    const removalPassword = String(query.p);
    viewerAttendee = (event.attendees as AttendeeLite[] | undefined)?.find(
      (a: AttendeeLite) =>
        a.removalPassword === removalPassword &&
        (a.status === "attending" || a.status === "declined"),
    );
  }
  ```

- [ ] **Step 2: Add a `viewerDeclined` flag to the function's return value**

  In the same function, after the existing:

  ```typescript
  const viewerRegistered = !!viewerAttendee;
  const viewerRegisteredUnapproved =
    !!viewerAttendee && !viewerAttendee.approved;
  ```

  add:

  ```typescript
  const viewerDeclined = viewerAttendee?.status === "declined";
  ```

  Add `viewerDeclined: boolean;` to the function's return type annotation
  (the `{ viewerApprovedForLocation: boolean; ... }` block right after the
  function signature), and add `viewerDeclined,` to the returned object.

  `viewerRegistered` therefore now also becomes `true` for a declined
  viewer — Task 4's bar template must check `viewerDeclined` **before**
  `viewerRegistered` when deciding which of the four states to render (a
  declined viewer is "registered" but should get the fourth state, not the
  "You're going" state).

- [ ] **Step 3: Destructure the new flag at the call site**

  In the `router.get("/:eventID", ...)` handler
  (`src/routes/frontend.ts:405-414`), add `viewerDeclined` to the
  destructured result of `resolveLocationAccess(...)`:

  ```typescript
  const {
    viewerApprovedForLocation,
    viewerRegistered,
    viewerRegisteredUnapproved,
    viewerDeclined,
    viewerAttendeeId,
    editingEnabled,
  } = resolveLocationAccess(
    event,
    req.query as Record<string, string | string[] | undefined>,
  );
  ```

- [ ] **Step 4: Build the host-only declined-attendee list**

  Immediately after the existing attendee-processing block that builds
  `attendees`, `numberOfHiddenAttendees`, and `totalAttendees` (ends around
  `src/routes/frontend.ts:534`, right before `let spotsRemaining,
noMoreSpots;`), add:

  ```typescript
  // Host-only list of attendees who declined. Never shown publicly or to
  // other attendees - editingEnabled gates it the same way canApprove/
  // canRemove gate the Attendees card's host actions.
  const declinedAttendees: {
    id: string;
    name: string;
    avatarLetter: string;
    avatarColor: string;
  }[] = editingEnabled
    ? ((event.attendees as AttendeeLite[] | undefined) || [])
        .filter((a) => a.status === "declined")
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => ({
          id: (a._id || a.id) as string,
          name: a.name,
          avatarLetter: a.name.charAt(0).toUpperCase(),
          avatarColor: stringToColor(a.name),
        }))
    : [];
  const numberOfDeclined = declinedAttendees.length;
  ```

- [ ] **Step 5: Pass the new fields into the render context**

  In the `res.render("event", {...})` call (`src/routes/frontend.ts:576` in
  the current file, right after `viewerRegistered,`), add:

  ```typescript
  viewerRegistered,
  viewerRegisteredUnapproved,
  viewerDeclined,
  declinedAttendees,
  numberOfDeclined,
  ```

  (only `viewerDeclined`, `declinedAttendees`, and `numberOfDeclined` are
  new — the other two already exist at that call site; add the three new
  lines alongside them without disturbing the existing ones.)

- [ ] **Step 6: Build and lint**

  Run: `pnpm build`
  Expected: no errors. If TypeScript complains that `declinedAttendees`'
  element type doesn't match an existing narrower type expected somewhere,
  double-check the inline type annotation in Step 4 matches exactly what
  Task 5's template iterates over (id/name/avatarLetter/avatarColor).

  Run: `pnpm exec eslint src/routes/frontend.ts`
  Expected: clean.

  Run: `pnpm exec prettier --check src/routes/frontend.ts`
  Expected: clean (or `--write` then re-check).

- [ ] **Step 7: Commit**

  ```bash
  git add src/routes/frontend.ts
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Detect declined viewers and build the host's decline list

  Widens resolveLocationAccess's ?p= lookup to match declined
  attendees too (so the bar can render a fourth state), and adds a
  host-only declinedAttendees list plus numberOfDeclined count to the
  event page's render context.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 4: Frontend — RSVP bar's fourth state, decline modal, and toggle handlers

**Files:**

- Modify: `views/event.handlebars` (RSVP bar block, currently
  `views/event.handlebars:364-387`)
- Modify: `views/event.handlebars` (new `#declineModal`, placed next to
  `#attendModal`/`#unattendModal`, currently ending around line 340)
- Modify: `views/event.handlebars` (script block, `#attendEvent` handler
  around line 723 and the area around it)
- Modify: `locales/en.json` (new indicator/modal strings)

**Interfaces:**

- Consumes: `viewerRegistered`, `viewerRegisteredUnapproved`,
  `viewerDeclined`, `noMoreSpots`, `editingEnabled`, `eventData.id` (all
  from Task 3 / the existing render context). The existing
  `/attendee/provision` endpoint (`src/routes.js:466`, unchanged) and the
  `POST /event/:eventID/attendee` route from Task 1 (now accepting
  `attendeeStatus`).
- Produces: nothing new consumed by later tasks — this is the primary
  attendee-facing UI change; Task 6 (e2e tests) exercises the DOM ids
  introduced here.

- [ ] **Step 1: Add the new locale strings**

  Add to `locales/en.json`, near the existing `youaregoing`/`pendingapproval`
  keys:

  ```json
  "views.event.youdeclined": "You said you can't attend",
  "views.event.declineself": "RSVP: Not Going to '{{eventData.name}}'",
  "views.event.deletemyinfo": "Permanently delete my info instead",
  ```

- [ ] **Step 2: Add the decline modal**

  In `views/event.handlebars`, immediately after the closing `</div>` of
  `#unattendModal` (the modal ends at line 340 in the current file, right
  before the closing `</div>` of the `usersCanAttend` card wrapper at line
  341), insert a new modal:

  ```handlebars
  <div
    class="modal fade"
    id="declineModal"
    tabindex="-1"
    role="dialog"
    aria-labelledby="declineModalLabel"
    aria-hidden="true"
  >
    <div class="modal-dialog" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="declineModalLabel">{{t
              "views.event.declineself"
            }}</h5>
          <button
            type="button"
            class="close"
            data-dismiss="modal"
            aria-label="Close"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <form
          id="declineEventForm"
          action="/event/{{eventData.id}}/attendee"
          method="post"
        >
          {{#if editingEnabled}}
            <input
              type="hidden"
              name="editToken"
              value="{{eventData.editToken}}"
            />
          {{/if}}
          <input type="hidden" name="attendeeStatus" value="declined" />
          <div class="modal-body">
            <div class="form-group">
              <label for="declineAttendeeName">{{t
                  "views.event.attendeename"
                }}</label>
              <div class="form-group">
                <input
                  type="text"
                  class="form-control"
                  id="declineAttendeeName"
                  name="attendeeName"
                  placeholder="{{t 'views.event.attendeenamedesc'}}"
                  data-validation="required length"
                  data-validation-length="1-30"
                />
              </div>
            </div>
            <input
              type="hidden"
              id="declineRemovalPassword"
              name="removalPassword"
            />
          </div>
          <div class="modal-footer">
            <button
              type="button"
              class="button button--secondary"
              data-dismiss="modal"
            >{{t "common.close"}}</button>
            <button type="submit" class="button button--primary">{{t
                "views.event.removeme"
              }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
  ```

  This mirrors `#attendModal`'s structure exactly, minus the fields declining
  doesn't need (headcount, email, visibility, custom questions).

- [ ] **Step 3: Rewrite the RSVP bar's four states**

  Replace the current bar block (`views/event.handlebars:364-387`):

  ```handlebars
  <div class="rsvp-bar" id="rsvpBar">
    <div class="rsvp-bar__inner" role="group" aria-label="Attendance controls">
      {{#if editingEnabled}}
        {{#unless noMoreSpots}}
          <button
            type="button"
            id="attendEvent"
            class="button button--primary"
            data-event-id="{{eventData.id}}"
          ><i class="fas fa-user-plus"></i>
            {{t "views.event.addattendee"}}</button>
        {{/unless}}
      {{else}}
        {{#if viewerDeclined}}
          <span class="rsvp-bar__status">
            <i class="fas fa-times-circle"></i>
            {{t "views.event.youdeclined"}}
          </span>
          <button
            type="button"
            id="reattendEvent"
            class="button button--primary"
          ><i class="fas fa-user-plus"></i> {{t "views.event.addme"}}</button>
          <button
            type="button"
            id="deleteMyInfo"
            class="button button--outline-secondary button--sm"
            data-toggle="modal"
            data-target="#unattendModal"
          >{{t "views.event.deletemyinfo"}}</button>
        {{else}}
          {{#if viewerRegistered}}
            <span class="rsvp-bar__status">
              {{#if viewerRegisteredUnapproved}}
                <i class="fas fa-clock"></i>
                {{t "views.event.pendingapproval"}}
              {{else}}
                <i class="fas fa-check-circle"></i>
                {{t "views.event.youaregoing"}}
              {{/if}}
            </span>
            <button
              type="button"
              id="declineExisting"
              class="button button--secondary"
            ><i class="fas fa-user-times"></i>
              {{t "views.event.removeme"}}</button>
          {{else}}
            {{#unless noMoreSpots}}
              <button
                type="button"
                id="attendEvent"
                class="button button--primary"
                data-event-id="{{eventData.id}}"
              ><i class="fas fa-user-plus"></i>
                {{t "views.event.addme"}}</button>
            {{/unless}}
            <button
              type="button"
              id="declineEvent"
              class="button button--secondary"
              data-event-id="{{eventData.id}}"
            ><i class="fas fa-user-times"></i>
              {{t "views.event.removeme"}}</button>
          {{/if}}
        {{/if}}
      {{/if}}
    </div>
  </div>
  ```

  State mapping (matches the spec table exactly):

  - Not responded (`!viewerRegistered && !viewerDeclined`): `#declineEvent`
    ("RSVP: Not Going") always shows; `#attendEvent` ("RSVP: Going") is
    additionally gated on `!noMoreSpots`, since declining never consumes
    capacity but attending does — both open a modal via provisioning
    (Step 4).
  - Attending, approved: "You're going" + `#declineExisting` ("RSVP: Not
    Going") — one-click toggle, no modal (Step 5).
  - Attending, pending: "Pending approval" + `#declineExisting` — same
    one-click toggle.
  - Declined: "You said you can't attend" + `#reattendEvent` ("RSVP: Going",
    one-click toggle) + `#deleteMyInfo` (opens the existing `#unattendModal`,
    unchanged full-erasure flow).

- [ ] **Step 4: Add the decline-modal-opening click handler**

  In the script block, immediately after the existing `#attendEvent` click
  handler (`views/event.handlebars:723-748`), add a parallel handler for
  `#declineEvent` that provisions the same way but opens `#declineModal`:

  ```javascript
  $("#declineEvent").on("click", function (event) {
    const modal = $("#declineModal");
    const eventID = $(this).attr("data-event-id");
    axios
      .post("/attendee/provision", {}, { params: { eventID } })
      .then((response) => {
        modal
          .find("#declineRemovalPassword")
          .val(response.data.removalPassword);
        try {
          const rpStore = JSON.parse(
            localStorage.getItem("gathioRemovalPasswords") || "{}",
          );
          rpStore[eventID] = response.data.removalPassword;
          localStorage.setItem(
            "gathioRemovalPasswords",
            JSON.stringify(rpStore),
          );
        } catch (e) {
          /* ignore persistence errors */
        }
        modal.modal();
      })
      .catch((error) => {
        console.error(error);
        return false;
      });
  });
  ```

- [ ] **Step 5: Add the one-click toggle handlers**

  Immediately after the handler from Step 4, add the two toggle handlers.
  Both read the `removalPassword` from the `?p=` query param, which is
  guaranteed present whenever `viewerRegistered` or `viewerDeclined` is true
  (the existing `autoAppendRemovalPassword` IIFE, `views/event.handlebars:775-789`,
  ensures this on every page load):

  ```javascript
  function toggleRsvpStatus(targetStatus) {
    const eventID = $("#eventName").attr("data-event-id");
    const removalPassword = new URLSearchParams(window.location.search).get(
      "p",
    );
    if (!removalPassword) {
      console.error("No removal password found for RSVP toggle");
      return;
    }
    axios
      .post(`/event/${eventID}/attendee`, {
        removalPassword,
        attendeeStatus: targetStatus,
      })
      .then(() => {
        window.location.reload();
      })
      .catch((error) => {
        console.error(error);
      });
  }

  $("#declineExisting").on("click", function () {
    toggleRsvpStatus("declined");
  });

  $("#reattendEvent").on("click", function () {
    toggleRsvpStatus("attending");
  });
  ```

  Note: `axios.post` with a plain object body sends JSON
  (`Content-Type: application/json`), which Express's `express.json()`
  middleware parses into `req.body` identically to a form POST for this
  route's purposes (it only reads `req.body.removalPassword` etc., not
  `req.body` as a whole). Run
  `grep -n "express.json" src/app.ts` to confirm the JSON body parser is
  mounted globally before this fetches; if it's scoped to specific content
  types only, adjust this step to use
  `axios.post(url, new URLSearchParams({removalPassword, attendeeStatus:
targetStatus}), {headers: {'Content-Type':
'application/x-www-form-urlencoded'}})` instead so the server parses it
  the same way as the existing form POST.

- [ ] **Step 6: Add CSS for the button--outline-secondary + button--sm delete link if missing**

  Run: `grep -n "button--outline-secondary" public/css/style.css | head -3`

  The `.remove-attendee`/`.approve-attendee` buttons in the Attendees card
  already use `button--outline-secondary button--sm` — confirm these
  Bootstrap-derived classes exist and render as a de-emphasized small button
  (they should, since they're already used elsewhere in this same template).
  No new CSS should be needed; if the "permanently delete my info instead"
  link looks too prominent when you view the page, reduce it further by
  adding a `.rsvp-bar__delete-link { font-size: 0.8rem; opacity: 0.7; }`
  rule to `public/css/style.css` near the existing `.rsvp-bar__status` rule
  and applying that class to the `#deleteMyInfo` button instead of
  `button--outline-secondary button--sm`.

- [ ] **Step 7: Build, lint, and parse-check**

  Run: `pnpm build`
  Expected: no errors (this task is template/JS/locale only, so `tsc`
  should be unaffected unless Step 6 touched a `.ts` file, which it
  shouldn't).

  Run:

  ```bash
  node -e "
  const fs = require('fs');
  const Handlebars = require('handlebars');
  Handlebars.precompile(fs.readFileSync('views/event.handlebars', 'utf8'));
  console.log('OK');
  "
  ```

  Expected: `OK`.

  Run: `python3 -c "import json; json.load(open('locales/en.json')); print('valid json')"`
  Expected: `valid json`.

  Run: `pnpm exec prettier --check public/css/style.css locales/en.json`
  (views/ is Prettier-ignored per this repo's config, so don't check the
  `.handlebars` file itself)
  Expected: clean, or `--write` then re-check.

- [ ] **Step 8: Commit**

  ```bash
  git add views/event.handlebars locales/en.json public/css/style.css
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add the RSVP bar's decline state, modal, and toggle handlers

  Adds a fourth RSVP bar state ("You said you can't attend"), a
  minimal name-only decline modal for first-time responses, and
  one-click JS handlers that toggle an existing record between
  attending and declined via the extended POST /event/:eventID/attendee
  route.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 5: Frontend — host-only "Can't attend" card

**Files:**

- Modify: `views/event.handlebars` (new card, placed after the existing
  `#eventAttendees` card, before `#attendModal`)
- Modify: `locales/en.json` (card title strings)

**Interfaces:**

- Consumes: `editingEnabled`, `numberOfDeclined`, `declinedAttendees` (from
  Task 3's render context — each item is `{ id, name, avatarLetter,
avatarColor }`).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add the locale strings**

  Add to `locales/en.json`, near `views.event.attendees`:

  ```json
  "views.event.cantattend": "Can't attend",
  "views.event.numberofcantattend": "({{numberOfDeclined}})",
  ```

- [ ] **Step 2: Add the card**

  In `views/event.handlebars`, immediately after the closing `</div>` of the
  `#eventAttendees` card (ends at line 252 in the current file, right before
  the `<div class="modal fade" id="attendModal" ...>` block), insert:

  ```handlebars
  {{#if editingEnabled}}
    {{#if numberOfDeclined}}
      <div class="card mb-4" id="eventDeclined">
        <h5 class="card-header">{{t "views.event.cantattend"}}
          {{t "views.event.numberofcantattend"}}</h5>
        <div class="card-body text-center">
          <ul class="attendeesList">
            {{#each declinedAttendees}}
              <li
                data-attendee-name="{{this.name}}"
                data-attendee-id="{{this.id}}"
              >
                <span
                  class="attendee-avatar"
                  style="background-color: {{this.avatarColor}}"
                >{{this.avatarLetter}}</span>
                <span class="attendee-info">
                  <span class="attendee-info__main">
                    <span class="attendee-name">{{this.name}}</span>
                  </span>
                </span>
              </li>
            {{/each}}
          </ul>
        </div>
      </div>
    {{/if}}
  {{/if}}
  ```

This block goes right after `#eventAttendees`'s closing `</div>` (line 252)
and before the `#attendModal` markup that follows it — both already sit
inside the file's `{{#if eventData.usersCanAttend}}...{{/if}}` wrapper
(opened at line 154, closed at line 372 per Task 4's file layout), so the
new card inherits that same scope and its `editingEnabled`/
`numberOfDeclined`/`declinedAttendees` context variables are available
without any additional nesting.

- [ ] **Step 3: Parse-check and validate JSON**

  Run:

  ```bash
  node -e "
  const fs = require('fs');
  const Handlebars = require('handlebars');
  Handlebars.precompile(fs.readFileSync('views/event.handlebars', 'utf8'));
  console.log('OK');
  "
  ```

  Expected: `OK`.

  Run: `python3 -c "import json; json.load(open('locales/en.json')); print('valid json')"`
  Expected: `valid json`.

- [ ] **Step 4: Commit**

  ```bash
  git add views/event.handlebars locales/en.json
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add a host-only "Can't attend" card

  Lists declined attendees by name for the host, separate from the
  public Attendees card and never rendered for non-host viewers.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 6: Cypress e2e coverage

**Files:**

- Create: `cypress/e2e/rsvpDecline.cy.ts`
- Modify: `cypress/e2e/event.cy.ts:330-361` (update the existing "one-click
  unattend link" test to match the new decline behavior)

**Interfaces:**

- Consumes: `cy.createEventWithApproval` (`cypress/support/commands.ts:66`,
  reused as-is), the `visitFresh` local-helper pattern already used in
  `cypress/e2e/attendeeApproval.cy.ts:2-8` (duplicate it locally in the new
  spec file — Cypress spec files in this repo don't share helpers beyond the
  registered custom commands).

- [ ] **Step 1: Write the new decline spec**

  Create `cypress/e2e/rsvpDecline.cy.ts`:

  ```typescript
  import eventData from "../fixtures/eventData.json";

  function visitFresh(url: string) {
    cy.visit(url, {
      onBeforeLoad(win) {
        win.localStorage.clear();
      },
    });
  }

  describe("RSVP Decline", () => {
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
      cy.get("#maxAttendees").type("10");

      cy.get("#newEventFormSubmit").click();
      cy.url({ timeout: 10000 }).should("not.include", "/new");

      cy.url().then((url) => {
        const [eventID, editToken] = url.split("/").pop()!.split("?");
        cy.wrap(eventID).as("eventID");
        cy.wrap(editToken).as("editToken");
      });
    });

    it("shows the decline bar state and a host-only Can't attend card", function () {
      visitFresh(`/${this.eventID}`);

      cy.get("button#declineEvent").click();
      cy.get("#declineModal").should("be.visible");
      cy.get("#declineAttendeeName").type("Cannot Come");
      cy.get("form#declineEventForm").submit();

      // Declined viewer sees the fourth bar state
      cy.get(".rsvp-bar__status").should(
        "contain.text",
        "You said you can't attend",
      );
      cy.get("button#reattendEvent").should("be.visible");
      cy.get("button#deleteMyInfo").should("be.visible");

      // Host sees the decline card; public attendee list is unaffected
      cy.visit(`/${this.eventID}?e=${this.editToken}`);
      cy.get("#eventDeclined").should("contain.text", "Cannot Come");
      cy.get("#eventAttendees").should("not.contain.text", "Cannot Come");
    });

    it("toggles from attending to declined and back without duplicating the record", function () {
      visitFresh(`/${this.eventID}`);

      cy.get("button#attendEvent").click();
      cy.get("#attendModal").should("be.visible");
      cy.get("#attendModal").should("have.focus");
      cy.get("#attendeeName").type("Maybe Later");
      cy.get("form#attendEventForm").submit();

      cy.get(".rsvp-bar__status").should("contain.text", "You're going");
      cy.get(".attendeesList").should("contain.text", "Maybe Later");

      // Switch to declined
      cy.get("button#declineExisting").click();
      cy.get(".rsvp-bar__status").should(
        "contain.text",
        "You said you can't attend",
      );
      cy.get(".attendeesList").should("not.contain.text", "Maybe Later");

      // Switch back to attending
      cy.get("button#reattendEvent").click();
      cy.get(".rsvp-bar__status").should("contain.text", "You're going");
      cy.get(".attendeesList").should("contain.text", "Maybe Later");

      // Host sees exactly one record, not two
      cy.visit(`/${this.eventID}?e=${this.editToken}`);
      cy.get(".attendeesList li").should("have.length", 1);
    });

    it("does not count a decline against capacity", function () {
      visitFresh(`/${this.eventID}`);

      cy.get("button#declineEvent").click();
      cy.get("#declineModal").should("be.visible");
      cy.get("#declineAttendeeName").type("Cannot Come");
      cy.get("form#declineEventForm").submit();

      cy.get("#attendees-alert").should("contain.text", "10 spots remaining");
    });

    it("still permanently deletes via the de-emphasized link", function () {
      visitFresh(`/${this.eventID}`);

      cy.get("button#declineEvent").click();
      cy.get("#declineModal").should("be.visible");
      cy.get("#declineAttendeeName").type("Cannot Come");
      cy.get("form#declineEventForm").submit();

      cy.get("button#deleteMyInfo").click();
      cy.get("#unattendModal").should("be.visible");
      cy.get("#unattendModal #removalPassword")
        .invoke("val")
        .should("not.be.empty");
      cy.get("form#unattendEventForm").submit();

      cy.visit(`/${this.eventID}?e=${this.editToken}`);
      cy.get("#eventDeclined").should("not.exist");
    });
  });
  ```

- [ ] **Step 2: Update the existing one-click unattend link test**

  In `cypress/e2e/event.cy.ts`, the test `"removes you from the event with a
one-click unattend link"` (currently lines 330-361) builds
  `unattendLink` as `` `/event/${this.eventID}/unattend/${removalPasswordHash}` ``
  — this is exactly the `GET /event/:eventID/unattend/:removalPasswordHash`
  route Task 2 changed from delete to decline. The test currently asserts
  `#event__message` contains "You have been removed from this event." after
  visiting that link; since Task 2's Step 5 no longer redirects with
  `?m=unattend` (and Task 2's Step 6 removed that message entirely), this
  assertion is now stale and must be replaced.

  Replace the assertions after `cy.visit(unattendLink);` (originally
  expecting removal) with:

  ```typescript
  cy.visit(unattendLink);
  cy.url().should("include", `?p=`);
  cy.get(".rsvp-bar__status").should(
    "contain.text",
    "You said you can't attend",
  );
  cy.get("#attendees-alert").should("contain.text", "10 spots remaining");
  ```

  (removing the old `#event__message` "You have been removed" assertion,
  since the route no longer redirects with that message — it redirects
  straight to the event page with `?p=`, per Task 2's Step 5).

- [ ] **Step 3: Verify against a running app**

  This sandbox has no MongoDB or Cypress-capable browser (see the Global
  Constraints note), so this step must be run by the executor in an
  environment with both:

  Run: `pnpm build`
  Then, with MongoDB reachable at the URL in `config/config.toml`:

  ```bash
  (CYPRESS=true pnpm run start &) ; sleep 2 && npx wait-on http://localhost:3000 && npx cypress run --e2e --browser electron --spec "cypress/e2e/rsvpDecline.cy.ts,cypress/e2e/event.cy.ts"
  ```

  Expected: all specs pass, including the updated "one-click unattend link"
  test and the four new `rsvpDecline.cy.ts` tests. If the environment lacks
  a display server for Electron, prefix with `xvfb-run -a`.

- [ ] **Step 4: Commit**

  ```bash
  git add cypress/e2e/rsvpDecline.cy.ts cypress/e2e/event.cy.ts
  git -c gpg.format=ssh \
      -c user.signingkey=~/.ssh/<signing_key> \
      commit -S -m "$(cat <<'EOF'
  Add e2e coverage for the RSVP decline feature

  Covers declining as a fresh visitor, toggling attending<->declined
  without duplicating the record, capacity being unaffected by
  declines, and the permanently-delete escape hatch. Updates the
  existing one-click-unattend-link test to match its new decline
  (not delete) behavior.

  Commit-Machine: toolbx
  EOF
  )"
  ```

---

## Task 7: Final full-suite verification

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Full build**

  Run: `pnpm build`
  Expected: no errors.

- [ ] **Step 2: Full lint**

  Run: `pnpm lint`
  Expected: no errors from ESLint or Prettier on any file this plan touched
  (ignore any pre-existing unrelated sandbox/dotfile permission errors if
  running inside a restricted container — those are environmental, not
  from this change; if running on a normal machine, `pnpm lint` should be
  fully clean).

- [ ] **Step 3: Full Cypress run**

  With MongoDB and a Cypress-capable browser available:

  Run: `pnpm test`
  Expected: all specs pass, including `attendeeApproval.cy.ts`,
  `customQuestions.cy.ts`, `event.cy.ts`, `group.cy.ts`, `magicLink.cy.ts`,
  `publicEvent.cy.ts`, `publicGroup.cy.ts`, and the new
  `rsvpDecline.cy.ts`. (Two pre-existing, unrelated failures were noted on
  `feat/rsvp-floating-bar` before this branch diverged — a jQuery
  load-order bug in `customQuestions.cy.ts`'s "Standalone answers form" and
  a Cypress typing flake in `event.cy.ts`'s "allows editing an event after
  it starts" — neither is expected to be affected by this plan's changes;
  if they still fail, that's expected and out of scope, but if any
  _other_ test newly fails, investigate before proceeding.)

- [ ] **Step 4: Manually verify the four bar states in a browser**

  With `pnpm dev` running against a real MongoDB, walk through:

  1. A fresh event page (never RSVP'd): confirm "RSVP: Going" and "RSVP:
     Not Going" buttons appear side by side.
  2. Click "RSVP: Not Going", fill in a name, submit: confirm the bar shows
     "You said you can't attend" with "RSVP: Going" and a small
     "Permanently delete my info instead" link.
  3. Click "RSVP: Going" from that state: confirm the bar flips to "You're
     going" with a "RSVP: Not Going" button, and the attendee appears in the
     public Attendees list.
  4. As the host (`?e=<editToken>`), confirm the "Can't attend" card only
     appears when there's at least one decliner, and never shows attending
     attendees.

  This step has no pass/fail command output to paste — confirm visually and
  note any discrepancy from the spec table before considering the plan
  complete.
