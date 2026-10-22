# RSVP Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three small, one-shot effects to the guest event page: an emoji burst
when a guest says "I'm going", their own row highlighted in the attendee list, and
a single waving hand when they say they can't go — each with a still,
reduced-motion version. Also tell guests that one reply can name several people
("Laura & Bob").

**Architecture:** RSVPs are full form posts that redirect back to the event page
with `?m=rsvpgoing` / `?m=rsvpdeclined` / `?m=rsvperased`. The page's existing
inline handler already reads `m` once (then strips it with `replaceState`), so it
becomes the single trigger: it calls a new plain-JS module,
`public/js/modules/rsvp-effects.js`, which adds and removes DOM nodes styled in
`public/css/style.css`. The server only learns one new fact per attendee —
whether they are the viewer (`isViewer`) — so the template can put the viewer
first in the avatar stack and tag their row "You".

**Tech Stack:** Express + Handlebars (`src/routes/frontend.ts`, `src/app.ts`,
`views/event.handlebars`), plain browser JS (no bundler, no new dependency),
CSS keyframes, Cypress e2e (no unit runner in this repo).

**Spec:** No separate spec doc; the design is the mockup canvas
https://claude.ai/artifact/VMJ6imxj3uR1qgRB9Tv2KQ (screens 1, 2 and 5 plus their
reduced-motion row) and the decisions below.

## Global Constraints

- Default celebration emoji: `😀` (U+1F600 GRINNING FACE), held in one constant,
  `DEFAULT_CELEBRATION_EMOJI`, in `rsvp-effects.js`. No per-event picker in this
  plan (see "Out of scope").
- Effects fire only from the `m` URL flag, so each plays once per RSVP; never on a
  plain page load, a reload, or for the host (`?e=`).
- `rsvpgoing` → burst + row highlight. `rsvpdeclined` and `rsvperased` → wave.
  `rsvppending` → nothing (the RSVP isn't confirmed yet).
- Reduced motion = `window.matchMedia("(prefers-reduced-motion: reduce)").matches`,
  checked at play time. When true: no moving or scaling elements are created; the
  burst becomes one still emoji in the RSVP bar status, the highlight becomes a
  still tint, the wave becomes one still 👋 in the status. The CSS also hides
  `.rsvp-burst` / `.rsvp-wave` under `@media (prefers-reduced-motion: reduce)` as a
  backstop.
- Every effect layer is `aria-hidden="true"` and `pointer-events: none`; nothing
  steals focus from the Bootstrap confirmation modal (Bootstrap's z-index is 1050,
  so the effect layer is 1060 and paints over the modal and its backdrop).
- Effect nodes are removed when done: burst after 2500 ms, wave after 1900 ms.
- Timings (match the mockup): burst = 16 emoji, 1300–1900 ms each, start delay
  0–360 ms, 22–36 px, three drift paths; wave = 1700 ms rise with a 1100 ms waggle;
  row glow = 3200 ms fade from `hsl(273,44%,90%)` to transparent.
- New copy goes in `locales/en.json` only: `"views.event.attendeeyou": "You"` and
  `"views.event.attendeenamehint": "Replying for more than one person? Add everyone's names, like Laura & Bob."`
- RSVP names are 1–40 characters after trimming, up from a browser-only 1–30,
  so a few names fit. The limit is enforced in the browser (attend and decline
  modals) **and** on the server (`POST /event/:eventID/attendee`), as
  `MAX_ATTENDEE_NAME_LENGTH = 40` in `src/routes/event.ts`.
- Attendee names wrap in the list instead of being cut off with "…", so the
  names and the "(3 people)" suffix always show in full.
- Relative imports in `.ts` keep their `.js` extension; `public/js/modules/` is
  linted, so `pnpm lint` must pass.
- Commits use the signed `toolbx` invocation from `CLAUDE.md`, with
  `Commit-Machine: toolbx` in the same final paragraph as `Co-Authored-By`.

## Out of scope (differs from the mockup on purpose)

- **Avatar shrinking out / count rolling on decline.** The decline is a page
  reload, so by the time the effect runs the viewer is already gone from the stack
  and the count is already lower. Faking it would need a new redirect flag and
  would be wrong for a first-time decliner who was never "going". The wave alone
  carries the moment.
- **Count roll-up on going.** The count is one translated string
  (`"{{count}} going"`), so the number can't be animated on its own without
  changing every locale.
- **Host-picked emoji.** Easy follow-up: an optional `celebrationEmoji` on
  `Event`, validated against a fixed list, rendered as
  `data-celebration-emoji` on `#rsvpBar`; the module already reads that attribute
  first (Task 2), so the follow-up touches only the form, validation and model.

## Review Focus

1. **Reloading or going back after an RSVP** — expect no second burst. Pinned in
   Task 2 (`does not replay on reload`).
2. **Pending-approval RSVP (`m=rsvppending`)** — expect no burst and no
   highlight. Pinned in Task 2 (`stays still for a pending RSVP`).
3. **Attendee list hidden from the viewer (`attendeesListHidden`)** — the row
   highlight has nothing to expand; expect the burst still to play and no error.
   Pinned in Task 3 (`plays the burst when the list is hidden`).
4. **Viewer RSVPed as private** — they must not appear in the guest avatar stack
   (existing rule), but should still get their tagged, highlighted row. Pinned in
   Task 1 (`keeps a private viewer out of the stack`).
5. **Effect layer blocking the modal** — expect the confirmation modal's close
   button to stay clickable while the burst is playing. Pinned in Task 2
   (`lets the modal be closed mid-burst`).

---

### Task 1: The page knows which attendee is the viewer

**Files:**

- Modify: `src/routes/frontend.ts` (`AttendeeView` interface ~line 58; the
  attendee `.map` ~line 494)
- Modify: `src/app.ts:127-133` (`avatarStack` helper)
- Modify: `views/event.handlebars:153-210` (attendee rows)
- Modify: `public/css/style.css` (new `.attendee-you` rule beside `.attendee-info`)
- Modify: `locales/en.json`
- Create: `cypress/e2e/rsvpEffects.cy.ts`

**Interfaces:**

- Produces: `AttendeeView.isViewer: boolean`; `avatarStack(attendees, max)` returns
  viewer first; each attendee `<li>` gets class `is-viewer` when `isViewer`, and
  contains `<span class="attendee-you">{{t "views.event.attendeeyou"}}</span>`
  after `.attendee-name`.
- Produces (test helpers in `rsvpEffects.cy.ts`, used by Tasks 2–4):

  - `createEvent(overrides?: Record<string, string>)` — same body as
    `guestView.cy.ts`'s helper; aliases `@eventID`, `@editToken`.
  - `addAttendee(eventID, name, visible = true)` — same as `guestView.cy.ts`.
  - `rsvpAndLand(eventID: string, name: string, status: "attending" | "declined", opts?: { visible?: boolean })`
    — provisions, POSTs `/event/${eventID}/attendee` with
    `followRedirect: false` (adding `attendeeStatus` for declines), then
    `cy.visit(response.headers.location)`. This lands on exactly the page a real
    RSVP redirects to, `m` flag included. Aliases `@removalPassword`.
  - Each `describe` block has `beforeEach(() => { cy.viewport(375, 812); createEvent(); })`.
  - `preferReducedMotion()` — `cy.on("window:before:load", win => …)` replacing
    `win.matchMedia` so `(prefers-reduced-motion: reduce)` matches and every
    other query falls through to the original.

- [ ] **Step 1: Write the failing tests** in a new `describe("Viewer row")`:

```ts
it("puts the viewer first in the avatar stack", function () {
  addAttendee(this.eventID, "Mira");
  addAttendee(this.eventID, "Jo");
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".avatar-stack .attendee-avatar").first().should("have.text", "S");
});

it("tags only the viewer's row with You", function () {
  addAttendee(this.eventID, "Mira");
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".attendeesList li.is-viewer .attendee-name").should(
    "have.text",
    "Sam",
  );
  cy.get(".attendeesList .attendee-you")
    .should("have.length", 1)
    .and("have.text", "You");
});

it("keeps a private viewer out of the stack", function () {
  addAttendee(this.eventID, "Mira");
  rsvpAndLand(this.eventID, "Sam", "attending", { visible: false });
  cy.get(".avatar-stack .attendee-avatar")
    .should("have.length", 1)
    .and("have.text", "M");
});

it("tags nobody for a plain visitor", function () {
  addAttendee(this.eventID, "Mira");
  cy.visit(`/${this.eventID}`);
  cy.get(".attendee-you").should("not.exist");
});
```

- [ ] **Step 2: Run to verify they fail**

Start the server with `CYPRESS=true` (`pnpm build && CYPRESS=true pnpm start`), then:
Run: `pnpm exec cypress run --e2e --browser chrome --spec cypress/e2e/rsvpEffects.cy.ts`
Expected: the first three FAIL (no `is-viewer` / `.attendee-you`, stack starts
with "M"); the fourth passes.

- [ ] **Step 3: Implement**

`isViewer: !!isViewerAttendee(a)` in the `.map` (the helper already exists ~line
465). `avatarStack` keeps its non-hidden filter, then orders `isViewer` first
before `slice(0, max)`; add `isViewer?: boolean` to its parameter type. In the
template add `is-viewer` to the `<li>` class list and the `.attendee-you` span in
both the visible and hidden-attendee row blocks. `.attendee-you`: 12.5px, weight
600, `padding: 2px 8px`, `border-radius: 20px`, background
`var(--color-purple-light)`, color `var(--color-purple-dark)` (≥4.5:1). Add the
`attendeeyou` key to `locales/en.json`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm build && pnpm lint`, restart the server, rerun the spec.
Expected: 4 passing; `guestView.cy.ts` still passes (run it too — the stack order
change touches its avatar tests).

- [ ] **Step 5: Commit** — `feat: mark the viewer's own row and put them first in the stack`

---

### Task 2: Emoji burst on "I'm going"

**Files:**

- Create: `public/js/modules/rsvp-effects.js`
- Modify: `views/event.handlebars` (load the module next to `event-page.js` ~line
  563; call it in the `urlParams.has('m')` block ~line 728, before `m` is deleted)
- Modify: `public/css/style.css` (new "RSVP effects" section at the end)
- Modify: `cypress/e2e/rsvpEffects.cy.ts`

**Interfaces:**

- Consumes: `#rsvpBar`, `.rsvp-bar__status` (existing markup).
- Produces: `window.gathioRsvpEffects.play(messageType: string): void` — no-op for
  unknown types and when required elements are missing; never throws.
  Internals other tasks extend: `prefersReducedMotion(): boolean`,
  `celebrationEmoji(): string` (returns `#rsvpBar`'s `data-celebration-emoji` if
  set, else `DEFAULT_CELEBRATION_EMOJI`), `addStillEmoji(emoji: string): void`
  (appends `<span class="rsvp-bar__emoji" aria-hidden="true">` to
  `.rsvp-bar__status`).
- DOM produced: `<div class="rsvp-burst" aria-hidden="true">` on `<body>`
  holding 16 `<span class="rsvp-burst__emoji rsvp-burst__emoji--{a|b|c}">`, each
  with inline `left`, `font-size`, `animation-delay`, `animation-duration`;
  removed after 2500 ms.

- [ ] **Step 1: Write the failing tests** in `describe("Going burst")`:

```ts
it("bursts the default smiley once", function () {
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".rsvp-burst__emoji")
    .should("have.length", 16)
    .first()
    .should("have.text", "😀");
  cy.get(".rsvp-burst", { timeout: 4000 }).should("not.exist");
});

it("does not replay on reload", function () {
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".rsvp-burst", { timeout: 4000 }).should("not.exist");
  cy.reload();
  cy.wait(500);
  cy.get(".rsvp-burst").should("not.exist");
});

it("stays still for a pending RSVP", function () {
  createEvent({ approveRegistrationsCheckbox: "true" });
  cy.get("@eventID").then((id) => rsvpAndLand(String(id), "Sam", "attending"));
  cy.wait(500);
  cy.get(".rsvp-burst").should("not.exist");
  cy.get(".rsvp-bar__emoji").should("not.exist");
});

it("lets the modal be closed mid-burst", function () {
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".rsvp-burst").should("exist");
  cy.get("#rsvpConfirmModal", { timeout: 10000 }).should("have.focus");
  cy.get("#rsvpConfirmModal .close").click();
  cy.get("#rsvpConfirmModal").should("not.be.visible");
});

it("shows one still smiley with reduced motion", function () {
  preferReducedMotion();
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get(".rsvp-bar__status .rsvp-bar__emoji").should("have.text", "😀");
  cy.get(".rsvp-burst").should("not.exist");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec cypress run --e2e --browser chrome --spec cypress/e2e/rsvpEffects.cy.ts`
Expected: "bursts", "lets the modal…" and "reduced motion" FAIL (no
`.rsvp-burst__emoji` / `.rsvp-bar__emoji`); the two negative tests pass already —
they guard regressions.

- [ ] **Step 3: Implement** the module as an IIFE in the style of `event-page.js`,
      with `DEFAULT_CELEBRATION_EMOJI = "😀"`. Burst origin: horizontally across the
      left two-thirds of `#rsvpBar`'s bounding rect (where "I'm going" sat), vertically
      at its top edge; fall back to the bottom-centre of the viewport if the bar is
      missing. Random values within the Global Constraints ranges; drift class cycles
      a/b/c. CSS: `.rsvp-burst` is `position: fixed; inset: 0; z-index: 1060;
pointer-events: none; overflow: hidden`; the three `@keyframes rsvp-rise-a/b/c`
      are the mockup's `rise-a/b/c` (`project/Main.dc.html` on the canvas). Add a
      `rsvp-pop` keyframe (scale 0 → 1, overshoot easing) applied to
      `.rsvp-bar__status .fa-check` when going, so the status lands with the burst.
      Reduced-motion `@media` block: `.rsvp-burst { display: none }` and no pop. Wire
      `gathioRsvpEffects.play(messageType)` into the existing `m` handler.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm build && pnpm lint`, restart, rerun the spec. Expected: all Task 1 and
Task 2 tests pass.

- [ ] **Step 5: Commit** — `feat: emoji burst when a guest says they're going`

---

### Task 3: Highlight the viewer's row after joining

**Files:**

- Modify: `public/js/modules/rsvp-effects.js`
- Modify: `public/css/style.css`
- Modify: `cypress/e2e/rsvpEffects.cy.ts`

**Interfaces:**

- Consumes: `li.is-viewer` (Task 1); `#attendeesToggle` / `#attendeesListWrap`
  (existing disclosure in `event-page.js`); `play()` and
  `prefersReducedMotion()` (Task 2).
- Produces: on `rsvpgoing`, `#attendeesToggle` is clicked open if collapsed, and
  `li.is-viewer` gets class `attendee--just-joined` (motion) or
  `attendee--just-joined-still` (reduced motion). Neither class is removed; the
  glow animation ends transparent by itself.

- [ ] **Step 1: Write the failing tests** in `describe("Joined row")`:

```ts
it("opens the list and highlights the viewer's row", function () {
  addAttendee(this.eventID, "Mira");
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get("#attendeesToggle").should("have.attr", "aria-expanded", "true");
  cy.get("li.is-viewer")
    .should("have.class", "attendee--just-joined")
    .and("be.visible");
});

it("uses a still tint with reduced motion", function () {
  preferReducedMotion();
  rsvpAndLand(this.eventID, "Sam", "attending");
  cy.get("li.is-viewer").should("have.class", "attendee--just-joined-still");
  cy.get("li.is-viewer").should("have.css", "animation-name", "none");
});

it("plays the burst when the list is hidden", function () {
  // An unapproved viewer gets attendeesListHidden, but approval-gated events
  // redirect with rsvppending, so land on rsvpgoing by hand
  createEvent({ approveRegistrationsCheckbox: "true" });
  cy.get("@eventID").then((id) => {
    rsvpAndLand(String(id), "Sam", "attending");
    cy.get("@removalPassword").then((p) =>
      cy.visit(`/${id}?p=${p}&m=rsvpgoing`),
    );
  });
  cy.get("#attendeesToggle").should("not.exist");
  cy.get(".rsvp-burst").should("exist"); // Cypress fails the test on any uncaught error
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: the first two FAIL (no class, toggle still `false`).

- [ ] **Step 3: Implement**

In `play("rsvpgoing")`: if `#attendeesToggle` has `aria-expanded="false"`, call
`.click()` on it (reuses the existing disclosure, keeping ARIA in sync); then add
the class to `li.is-viewer` and `scrollIntoView({ block: "nearest", behavior:
reduced ? "auto" : "smooth" })`. CSS: `.attendee--just-joined` runs the mockup's
`row-in` (320 ms) and `glow` (3200 ms, 200 ms delay) keyframes, with the row's
`padding-inline: .5rem; margin-inline: -.5rem; border-radius: .625rem` so the
tint has room; `.attendee--just-joined-still { background:
var(--color-purple-light) }`; the reduced-motion `@media` block sets
`.attendee--just-joined { animation: none; background: var(--color-purple-light) }`.

- [ ] **Step 4: Run to verify they pass** — rebuild, lint, rerun the spec; all
      pass.

- [ ] **Step 5: Commit** — `feat: open and highlight the guest's row after they join`

---

### Task 4: A small wave on "Can't go"

**Files:**

- Modify: `public/js/modules/rsvp-effects.js`
- Modify: `public/css/style.css`
- Modify: `cypress/e2e/rsvpEffects.cy.ts`

**Interfaces:**

- Consumes: `play()`, `prefersReducedMotion()`, `addStillEmoji()` (Task 2);
  `.rsvp-bar__status--declined` (existing).
- Produces: on `rsvpdeclined` / `rsvperased`, `<div class="rsvp-wave"
aria-hidden="true"><span class="rsvp-wave__hand">👋</span></div>` on `<body>`,
  removed after 1900 ms; with reduced motion, `addStillEmoji("👋")` instead.
  After `rsvperased` the bar has no status element, so the reduced-motion case
  does nothing there.

- [ ] **Step 1: Write the failing tests** in `describe("Goodbye wave")`:

```ts
it("waves once when a guest can't go", function () {
  rsvpAndLand(this.eventID, "Sam", "declined");
  cy.get(".rsvp-wave__hand").should("have.text", "👋");
  cy.get(".rsvp-wave", { timeout: 4000 }).should("not.exist");
  cy.get(".rsvp-burst").should("not.exist");
});

it("shows a still wave with reduced motion", function () {
  preferReducedMotion();
  rsvpAndLand(this.eventID, "Sam", "declined");
  cy.get(".rsvp-bar__status--declined .rsvp-bar__emoji").should(
    "have.text",
    "👋",
  );
  cy.get(".rsvp-wave").should("not.exist");
});

it("waves after deleting my info", function () {
  // Deleting info redirects here (views/event.handlebars, #unattendEventForm)
  cy.visit(`/${this.eventID}?m=rsvperased`);
  cy.get(".rsvp-wave").should("exist");
});
```

- [ ] **Step 2: Run to verify they fail** — the first and third FAIL (no
      `.rsvp-wave`); the second FAILs (no still emoji).

- [ ] **Step 3: Implement**

Position `.rsvp-wave` `fixed`, `z-index: 1060`, `pointer-events: none`, at the
left of `#rsvpBar`'s top edge (fallback bottom-left of the viewport), 40 px. The
`rsvp-drift` (1700 ms) and `rsvp-waggle` (1100 ms, 150 ms delay,
`transform-origin: 70% 85%`) keyframes are the mockup's `drift`/`wave`
(`project/Goodbye.dc.html`). Add `.rsvp-wave { display: none }` to the
reduced-motion `@media` block.

- [ ] **Step 4: Run to verify they pass**

Run the whole suite once: `pnpm test`. Expected: every spec passes, including
`guestView.cy.ts` and `rsvpDecline.cy.ts`, which touch the same bar and modal.

- [ ] **Step 5: Commit** — `feat: wave goodbye when a guest can't go`

---

### Task 5: Say that one reply can name several people

Independent of Tasks 2–4; needs only Task 1's test helpers.

**Files:**

- Modify: `views/event.handlebars:282-286` (attend modal name field) and `:365`
  (decline modal name field)
- Modify: `src/routes/event.ts:1126-1142` (`POST /event/:eventID/attendee`, beside
  the existing removal-password check)
- Modify: `public/css/style.css:893-898` (`.attendee-info .attendee-name`)
- Modify: `locales/en.json`
- Modify: `cypress/e2e/rsvpEffects.cy.ts`

**Interfaces:**

- Produces: `<p class="form-text small" id="attendeeNameHint">` directly under the
  attend modal's `#attendeeName` label, and `<p … id="declineAttendeeNameHint">`
  under the decline modal's; each input gets `aria-describedby` pointing at its
  hint, `maxlength="40"` and `data-validation-length="1-40"`. Server: when
  `attendeeName` is a string, it is trimmed; if the trimmed value is longer than
  `MAX_ATTENDEE_NAME_LENGTH` the handler returns
  `400 { error: "Names can be up to 40 characters." }` before touching the
  attendee. An absent name (the one-click re-attend toggle) is still allowed.
  Label (`"Your name"`) and placeholder
  (`"Your name or nickname"`) are unchanged — the hint is visible text, not a
  placeholder, so it stays readable while typing. Same layout as the existing
  email hint (`views.event.joinemaildesc`).

- [ ] **Step 1: Write the failing tests** in `describe("Several names")`:

```ts
const hint =
  "Replying for more than one person? Add everyone's names, like Laura & Bob.";

it("explains several names in the attend modal", function () {
  cy.visit(`/${this.eventID}`);
  cy.get("#attendEvent").click();
  cy.get("#attendeeNameHint").should("be.visible").and("have.text", hint);
  cy.get("#attendeeName").should(
    "have.attr",
    "aria-describedby",
    "attendeeNameHint",
  );
});

it("explains several names in the decline modal", function () {
  cy.visit(`/${this.eventID}`);
  cy.get("#declineEvent").click();
  cy.get("#declineAttendeeNameHint")
    .should("be.visible")
    .and("have.text", hint);
  cy.get("#declineAttendeeName").should(
    "have.attr",
    "aria-describedby",
    "declineAttendeeNameHint",
  );
});

it("shows a 40-character reply in full at phone width", function () {
  const names = "Laura, Bob & Priya Ramaswamy-Okonkwo Jr."; // exactly 40, over the old 30
  cy.visit(`/${this.eventID}`);
  cy.get("#attendEvent").click();
  cy.get("#attendModal").should("have.focus");
  cy.get("#attendeeName").type(names);
  cy.get("#attendeeNumber").clear().type("3");
  cy.get("#attendEventForm").submit();
  cy.get("li.is-viewer .attendee-name")
    .should("have.text", `${names} (3 people)`)
    .and(($el) => {
      // Nothing clipped: the whole text fits inside the element
      expect($el[0].scrollWidth).to.be.at.most($el[0].clientWidth);
    });
  cy.get("li.is-viewer .attendee-you").should("be.visible");
});

it("stops typing at 40 characters", function () {
  cy.visit(`/${this.eventID}`);
  cy.get("#attendEvent").click();
  cy.get("#attendModal").should("have.focus");
  cy.get("#attendeeName")
    .type("x".repeat(45))
    .should("have.value", "x".repeat(40));
});

it("rejects an over-long name on the server", function () {
  cy.request("POST", `/attendee/provision?eventID=${this.eventID}`).then(
    (res) => {
      cy.request({
        method: "POST",
        url: `/event/${this.eventID}/attendee`,
        form: true,
        failOnStatusCode: false,
        body: {
          removalPassword: res.body.removalPassword,
          attendeeName: "x".repeat(41),
          attendeeNumber: "1",
          fullForm: "1",
        },
      }).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.error).to.eq("Names can be up to 40 characters.");
      });
    },
  );
});

it("trims spaces before counting", function () {
  rsvpAndLand(this.eventID, `  ${"y".repeat(40)}  `, "attending");
  cy.get("li.is-viewer .attendee-name").should("have.text", "y".repeat(40));
});
```

- [ ] **Step 2: Run to verify they fail** — the two hint tests FAIL (no hint
      element); the phone-width test FAILs (30-character browser limit and the
      ellipsis); "stops typing" FAILs (no `maxlength`); the server test FAILs (the RSVP
      succeeds, so the followed redirect returns 200); "trims" FAILs (the name is stored untrimmed).

- [ ] **Step 3: Implement** the two hint paragraphs with
      `{{t "views.event.attendeenamehint" }}`, the `aria-describedby` attributes, the
      40-character `maxlength` and validation length, and the locale key. Server: the
      trim-and-check described above, with the trimmed value used everywhere the
      handler now uses `attendeeName`. CSS: `.attendee-info .attendee-name` drops
      `white-space: nowrap`, `overflow: hidden` and `text-overflow: ellipsis` for
      `overflow-wrap: anywhere` (a single 40-letter word still breaks); keep
      `flex-shrink: 1` and `min-width: 0` on its parent.

- [ ] **Step 4: Run to verify they pass** — rebuild, lint, rerun
      `rsvpEffects.cy.ts`, plus `event.cy.ts`, `rsvpDecline.cy.ts` (both fill these
      fields) and `guestView.cy.ts` and `attendeeApproval.cy.ts` (both lay out
      attendee rows).

- [ ] **Step 5: Commit** — `feat: tell guests one reply can name several people`

---

### Task 6: Check it by eye

**Files:** none (unless fixes are needed)

- [ ] **Step 1:** `pnpm dev`, open an event at 375 px wide, RSVP as going and as
      can't go. Expected: burst rises from the bar and clears in ~2 s; your row is open
      and glowing; the wave drifts up from the bar's left. Close the modal mid-burst —
      it closes on the first click.
- [ ] **Step 2:** Turn on reduced motion (Chrome DevTools → Rendering → Emulate
      CSS media feature `prefers-reduced-motion: reduce`) and repeat. Expected: nothing
      moves; one still 😀 or 👋 sits beside the status; the row has a still tint.
- [ ] **Step 3:** Open "I'm going" at 375 px. Expected: the several-names hint
      sits under "Your name" and wraps cleanly. A 40-character multi-name reply
      wraps onto a second line in the attendee list, "(3 people)" included, with the
      "You" tag still on the row. Repeat on the host's view (`?e=`), where the approve
      and remove buttons leave the least room.
- [ ] **Step 4:** If anything needed fixing, rerun `pnpm lint` and the spec, then
      commit `fix: …`.
