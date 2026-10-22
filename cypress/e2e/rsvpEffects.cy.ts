// The small moments around an RSVP: the viewer's own row, the emoji burst on
// "I'm going", the highlighted row, the goodbye wave, and replies that name
// several people. Every effect has a still version for reduced motion.

// A module, so these helpers don't clash with guestView.cy.ts's of the same name
export {};

function createEvent(overrides: Record<string, string> = {}) {
  cy.request({
    method: "POST",
    url: "/event",
    form: true,
    body: {
      eventName: "Board game night",
      eventLocation: "Westside Library, Room 2",
      eventStart: "2030-01-01T18:30",
      eventEnd: "2030-01-01T21:30",
      timezone: "America/New_York",
      eventDescription: "Bring a game you love.",
      eventURL: "",
      hostName: "Priya",
      creatorEmail: "",
      publicCheckbox: "false",
      eventGroupCheckbox: "false",
      interactionCheckbox: "true",
      joinCheckbox: "true",
      maxAttendeesCheckbox: "false",
      maxAttendees: "",
      approveRegistrationsCheckbox: "false",
      customQuestions: "[]",
      magicLinkToken: "",
      ...overrides,
    },
  }).then((response) => {
    cy.wrap(response.body.eventID).as("eventID");
    cy.wrap(response.body.editToken).as("editToken");
  });
}

// Provisions an attendee slot and RSVPs into it, as the attend modal does
function addAttendee(eventID: string, name: string, visible = true) {
  cy.request("POST", `/attendee/provision?eventID=${eventID}`).then((res) => {
    cy.request({
      method: "POST",
      url: `/event/${eventID}/attendee`,
      form: true,
      body: {
        removalPassword: res.body.removalPassword,
        attendeeName: name,
        attendeeNumber: "1",
        fullForm: "1",
        ...(visible ? { attendeeVisible: "on" } : {}),
      },
    });
  });
}

// RSVPs, then lands on exactly the page the RSVP redirects to - ?m= flag and
// all - which is where the effects play
function rsvpAndLand(
  eventID: string,
  name: string,
  status: "attending" | "declined",
  opts: { visible?: boolean } = {},
) {
  cy.request("POST", `/attendee/provision?eventID=${eventID}`).then((res) => {
    const removalPassword = res.body.removalPassword;
    cy.wrap(removalPassword).as("removalPassword");
    cy.request({
      method: "POST",
      url: `/event/${eventID}/attendee`,
      form: true,
      followRedirect: false,
      body: {
        removalPassword,
        attendeeName: name,
        attendeeNumber: "1",
        fullForm: "1",
        ...(status === "declined" ? { attendeeStatus: "declined" } : {}),
        ...(opts.visible === false ? {} : { attendeeVisible: "on" }),
      },
    }).then((r) => {
      expect(r.status).to.eq(302);
      cy.visit(r.headers.location as string);
    });
  });
}

// Makes every page load from here on prefer reduced motion. Only the script's
// matchMedia check sees this; the stylesheet's @media backstop doesn't.
function preferReducedMotion() {
  cy.on("window:before:load", (win) => {
    const original = win.matchMedia.bind(win);
    win.matchMedia = (query: string) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => false,
          } as MediaQueryList)
        : original(query);
  });
}

describe("RSVP effects", () => {
  beforeEach(() => {
    cy.viewport(375, 812);
    createEvent();
  });

  describe("Viewer row", () => {
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
  });

  describe("Going burst", () => {
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
      cy.get("@eventID").then((id) =>
        rsvpAndLand(String(id), "Sam", "attending"),
      );
      cy.location("search").should("include", "p=");
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
  });

  describe("Joined row", () => {
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
      cy.get("li.is-viewer").should(
        "have.class",
        "attendee--just-joined-still",
      );
      cy.get("li.is-viewer").should("have.css", "animation-name", "none");
    });

    it("plays the burst when the list is hidden", function () {
      // An unapproved viewer gets attendeesListHidden, but approval-gated
      // events redirect with rsvppending, so land on rsvpgoing by hand
      createEvent({ approveRegistrationsCheckbox: "true" });
      cy.get("@eventID").then((id) => {
        rsvpAndLand(String(id), "Sam", "attending");
        cy.get("@removalPassword").then((p) =>
          cy.visit(`/${id}?p=${p}&m=rsvpgoing`),
        );
      });
      cy.get("#attendeesToggle").should("not.exist");
      // Cypress fails the test on any uncaught error from the page
      cy.get(".rsvp-burst").should("exist");
    });
  });

  describe("Goodbye wave", () => {
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
  });

  describe("Several names", () => {
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
        .should("be.visible")
        .and("have.text", `${names} (3 people)`)
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
  });
});
