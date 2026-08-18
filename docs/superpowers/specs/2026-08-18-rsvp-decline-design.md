# RSVP Decline ("Can't Attend") — Design

## Context

`feat/rsvp-floating-bar` (merged into this branch's base) reworked the event
page's RSVP call-to-action into a fixed bottom bar and added viewer-state
awareness ("You're going" / "Pending approval" / "I cannot go"). That work
left three usability gaps identified while reviewing it:

1. The "I cannot go" action was always visible, even to visitors who had
   never RSVP'd.
2. The RSVP button stayed visible after someone had already RSVP'd.
3. There was no way for a visitor to indicate they _cannot_ attend — the
   only signal available was silence (never RSVPing).

Items 1 and 2 are already fixed (commit `202adab` on
`feat/rsvp-floating-bar`). This spec covers item 3: giving attendees a
first-class way to decline, and giving hosts visibility into who declined,
for headcount/planning purposes (catering, seating, etc.) — this is the
stated motivation, not just tidier viewer-side copy.

This branch (`feat/rsvp-cannot-attend`) branches off `feat/rsvp-floating-bar`.

## Goals

- A visitor can explicitly say "I can't attend," distinct from never
  responding.
- The host can see, by name, who declined — in a location separate from the
  public Attendees list, never shown to other attendees or the public.
- Declining doesn't consume event capacity.
- Someone can change their mind in either direction (attending → declined,
  declined → attending) without re-entering their details.
- A person can still fully erase their attendee record if they want to,
  just not as the default/primary action anymore.

## Non-goals

- ActivityPub decline semantics. The federation-specific one-click unattend
  route (`GET /oneclickunattendevent/:eventID/:attendeeID` in
  `src/routes.js:537`) is untouched by this spec — converting it to a
  "decline" concept would require its own federation design (e.g. whether
  to broadcast an `Undo`/`Reject` activity) and is out of scope here.
- Changing host-initiated attendee removal
  (`DELETE /event/:eventID/attendee/:attendeeID`, `src/routes/event.ts:1076`)
  — that route is independent of this feature and stays as-is.
- A "reason" or free-text field on decline — declining asks for a name only,
  matching the minimal-friction goal.

## Data model

`Attendee.status` (`src/models/Event.ts`) is already a loose string field
with two observed values today: `"provisioned"` (pre-submission stub created
by `POST /attendee/provision` in `src/routes.js:466`) and `"attending"`. This
spec adds a third value, `"declined"`. No schema/migration change is
needed — just a new value the application code understands.

`getApprovedAttendeeCount` (`src/models/Event.ts:104`) already filters to
`status === "attending"`, so declined attendees are automatically excluded
from capacity counts with no code change there.

## RSVP bar states

Extends the existing bar (`views/event.handlebars`, `.rsvp-bar`), all rows
below apply when `!editingEnabled`:

| State                       | Indicator                   | Action(s)                                                                            |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Not responded               | —                           | **"RSVP: Going"** (primary) + **"RSVP: Not Going"** (secondary), side by side        |
| Attending, approved         | "You're going"              | **"RSVP: Not Going"**                                                                |
| Attending, pending approval | "Pending approval"          | **"RSVP: Not Going"**                                                                |
| Declined                    | "You said you can't attend" | **"RSVP: Going"** + a small, de-emphasized "permanently delete my info instead" link |

Host editing mode (`editingEnabled`) is unchanged from the current bar
("Add attendee" only).

## Interaction model

- **First response** (no existing record) opens a modal:
  - "RSVP: Going" → the existing `#attendModal` (name, headcount, email,
    visibility, custom questions) — unchanged.
  - "RSVP: Not Going" → a new, minimal modal: name only, no email, no
    custom questions, no headcount.
- **Toggling an existing record** (attending ↔ declined, including
  pending → declined) is a single click, no modal — we already have their
  name on file via `removalPassword`. This reuses the same
  `POST /event/:eventID/attendee` route (see below) with a target status,
  rather than re-collecting the full form.
- Declining never requires host approval — `approveRegistrations` only
  gates _location visibility for confirmed attendees_, which doesn't apply
  to a decline.
- The declined state's small "permanently delete my info instead" link
  triggers the existing `DELETE /event/attendee/:eventID` flow
  (`src/routes/event.ts:730`), unchanged. This is the only remaining
  self-service full-erasure path — the RSVP bar's own actions never delete.

## Routes

- **`POST /event/:eventID/attendee`** (`src/routes/event.ts:833`): extend to
  accept a target status (attending or declined) rather than assuming
  "attending". For a **new** attendee, behaves as today plus the declined
  branch (name only, `attendee.approved` irrelevant, no capacity check, no
  custom-question collection, a decline-specific confirmation email instead
  of `addEventAttendee`/`attendeePendingConfirmation`). For an **existing**
  attendee (the one-click toggle), only `status` (and `approved`, if
  applicable) changes — name/email/answers already on file are preserved,
  not overwritten by an empty request.
- **`GET /event/:eventID/unattend/:removalPasswordHash`**
  (`src/routes/event.ts:797`, the emailed one-click unattend link): change
  from `$pull`-deleting the attendee to setting `status: "declined"`. Update
  its confirmation email copy to reflect "you've been marked as not
  attending" rather than "you've been removed," and its redirect message
  (`?m=unattend`) accordingly.
- **`DELETE /event/attendee/:eventID`** (`src/routes/event.ts:730`):
  unchanged in behavior, but now reachable only via the declined state's
  "permanently delete" link, not as the bar's primary action.
- **`src/routes/frontend.ts`, `resolveLocationAccess`**: the `viewerAttendee`
  lookup added in `202adab` currently matches only
  `status === "attending"`. Widen it to also match `"declined"`, and add a
  `viewerDeclined` boolean to the returned/rendered flags so the template
  can pick the fourth bar state. `viewerApprovedForLocation` and
  `getApprovedAttendeeCount` logic stay scoped to `"attending"` only —
  declining never unlocks location visibility.

## Host visibility

A new host-only card on the event page (`editingEnabled`), separate from
the existing Attendees card: **"Can't attend (N)"**, listing decliner names.
Never rendered for non-host viewers and never included in the public
attendee list or count. Reuses the same attendee-row visual pattern as the
Attendees card (avatar letter, name) but without the visibility/approve/
copy-link actions that don't apply to a decline.

## Testing

- Cypress e2e, following the existing patterns in `cypress/e2e/event.cy.ts`
  and `cypress/e2e/attendeeApproval.cy.ts`:
  - Declining as a fresh visitor shows the declined bar state and the
    host-only "Can't attend" card.
  - Switching attending → declined and back, verifying the record updates
    in place (same `removalPassword`, no duplicate).
  - Declining never counts against `maxAttendees` capacity.
  - The emailed unattend link now declines rather than deletes (existing
    "removes you from the event with a one-click unattend link" test in
    `event.cy.ts:330` needs updating to match the new behavior).
  - The "permanently delete my info" link still fully removes the attendee
    record.
- No unit test runner exists in this repo (Cypress e2e only, per
  `CLAUDE.md`), so all coverage here is e2e.
