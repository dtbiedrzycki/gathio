// The phone-first guest event page: top bar, cover band, title block, facts,
// sharing, Who's going, the RSVP bar, and the discussion.

function createEvent(overrides: Record<string, string> = {}) {
  cy.request({
    method: "POST",
    url: "/event",
    form: true,
    body: {
      eventName: "Riverside potluck picnic",
      eventLocation: "Jubilee Park, east lawn",
      eventStart: "2030-01-01T12:00",
      eventEnd: "2030-01-01T14:00",
      timezone: "America/New_York",
      eventDescription: "Bring a dish to share and a blanket.",
      eventURL: "",
      hostName: "Sam",
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

describe("Guest view", () => {
  beforeEach(() => {
    cy.viewport(375, 812);
  });

  describe("Top bar", () => {
    beforeEach(() => createEvent());

    it("shows the wordmark and no create button", function () {
      cy.visit(`/${this.eventID}`);
      cy.get("#sidebar h1 a").should("have.attr", "href", "/");
      cy.get('#sidebar a[href="/new"]').should("not.exist");
      cy.get("#sidebar").then(($s) => {
        expect($s[0].getBoundingClientRect().height).to.be.lessThan(80);
      });
      cy.get("#content").then(($c) => {
        expect($c[0].getBoundingClientRect().width).to.equal(375);
      });
    });
  });

  describe("Cover and title", () => {
    it("uses a flat colour band when there is no image", function () {
      createEvent();
      cy.get("@eventID").then((id) => cy.visit(`/${id}`));
      cy.get("#genericEventImageContainer")
        .should("have.attr", "style")
        .and("match", /background-color:\s*hsl\(/)
        .and("not.contain", "seigaiha");
      cy.get("#genericEventImageContainer").should(
        "have.css",
        "background-image",
        "none",
      );
    });

    it("puts the date directly under a large title", function () {
      createEvent();
      cy.get("@eventID").then((id) => cy.visit(`/${id}`));
      cy.get("#eventName").then(($n) => {
        expect(parseFloat(getComputedStyle($n[0]).fontSize)).to.be.at.least(30);
        const nameBottom = $n[0].getBoundingClientRect().bottom;
        cy.get(".event-when .dt-duration").should("exist");
        cy.get(".event-when").then(($w) => {
          expect($w[0].getBoundingClientRect().top - nameBottom).to.be.at.most(
            24,
          );
        });
      });
    });

    it("wraps a very long name and URL without sideways scroll", function () {
      createEvent({
        eventName: "Supercalifragilisticexpialidocious".repeat(4),
        eventURL: "https://example.com/" + "a".repeat(120),
      });
      cy.get("@eventID").then((id) => cy.visit(`/${id}`));
      cy.document().then((d) => {
        expect(d.documentElement.scrollWidth).to.be.at.most(375);
      });
    });
  });
  describe("Facts and sharing", () => {
    beforeEach(() => createEvent());

    it("keeps the public link out of the facts until Share is used", function () {
      cy.visit(`/${this.eventID}`, {
        onBeforeLoad(win) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (win.navigator as any).share;
        },
      });
      cy.get("#sharePanel").should("not.be.visible");
      cy.get("#copyEventLink").should("not.be.visible");
      cy.get(".event-facts").should("not.contain.text", `/${this.eventID}`);
      cy.get("#shareEvent").click();
      cy.get("#sharePanel")
        .should("be.visible")
        .and("contain.text", `/${this.eventID}`);
      cy.get("#copyEventLink").should("be.visible");
    });

    it("uses the native share sheet when available", function () {
      cy.visit(`/${this.eventID}`, {
        onBeforeLoad(win) {
          Object.defineProperty(win.navigator, "share", {
            value: cy.stub().as("share").resolves(),
            configurable: true,
          });
        },
      });
      cy.get("#shareEvent").click();
      cy.get("@share").should("have.been.calledOnce");
      cy.get("@share").then((stub) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const arg = (stub as any).firstCall.args[0];
        expect(arg.url).to.match(new RegExp(`/${this.eventID}$`));
      });
      cy.get("#sharePanel").should("not.be.visible");
    });

    it("opens the panel when the share sheet is cancelled", function () {
      cy.visit(`/${this.eventID}`, {
        onBeforeLoad(win) {
          Object.defineProperty(win.navigator, "share", {
            value: cy.stub().rejects(new DOMException("cancel", "AbortError")),
            configurable: true,
          });
        },
      });
      cy.get("#shareEvent").click();
      cy.get("#sharePanel").should("be.visible");
    });
  });
  describe("Who's going", () => {
    beforeEach(() => createEvent());

    it("is collapsed for guests and expands on tap", function () {
      ["Asha", "Jun", "Mo"].forEach((n) => addAttendee(this.eventID, n));
      cy.visit(`/${this.eventID}`);
      cy.get("#attendeesToggle")
        .should("have.attr", "aria-expanded", "false")
        .and("contain.text", "3 going");
      cy.get(".avatar-stack .attendee-avatar").should("have.length", 3);
      cy.get(".attendeesList").should("not.be.visible");
      cy.get("#attendeesToggle").click();
      cy.get("#attendeesToggle").should("have.attr", "aria-expanded", "true");
      cy.get(".attendeesList")
        .should("be.visible")
        .and("contain.text", "Asha")
        .and("contain.text", "Jun")
        .and("contain.text", "Mo");
    });

    it("never shows a private attendee's avatar to guests", function () {
      addAttendee(this.eventID, "Asha");
      addAttendee(this.eventID, "Secret", false);
      cy.visit(`/${this.eventID}`);
      cy.get(".avatar-stack .attendee-avatar").should("have.length", 1);
    });

    it("has no toggle when nobody is going", function () {
      cy.visit(`/${this.eventID}`);
      cy.get("#attendeesToggle").should("not.exist");
      cy.get("#eventAttendees").should("contain.text", "No attendees yet!");
    });

    it("is expanded for the host", function () {
      addAttendee(this.eventID, "Asha");
      cy.visit(`/${this.eventID}?e=${this.editToken}`);
      cy.get(".attendeesList").should("be.visible");
    });

    it("has no card chrome", function () {
      cy.visit(`/${this.eventID}`);
      cy.get("#eventDescription .card-header").should("not.exist");
      cy.get("#eventDescription").should("not.have.class", "card");
    });
  });
  describe("RSVP bar", () => {
    beforeEach(() => createEvent());

    it("keeps the main actions on one row at 375px", function () {
      cy.visit(`/${this.eventID}`);
      cy.get("#attendEvent").then(($a) => {
        const attendTop = $a[0].getBoundingClientRect().top;
        cy.get("#declineEvent").then(($d) => {
          expect($d[0].getBoundingClientRect().top).to.equal(attendTop);
        });
        cy.get("#recoverLink")
          .should("be.visible")
          .then(($r) => {
            expect($r[0].getBoundingClientRect().top).to.be.greaterThan(
              attendTop,
            );
          });
      });
    });

    it("doesn't cover the end of the page for a declined guest", function () {
      cy.visit(`/${this.eventID}`);
      cy.get("button#declineEvent").click();
      cy.get("#declineModal").should("be.visible");
      cy.get("#declineAttendeeName").type("Cannot Come");
      cy.get("form#declineEventForm").submit();
      cy.get("button#reattendEvent").should("be.visible");
      cy.get("button#deleteMyInfo").should("be.visible");
      cy.scrollTo("bottom");
      cy.get(".rsvp-bar").then(($bar) => {
        const barTop = $bar[0].getBoundingClientRect().top;
        cy.get("#postComment").then(($post) => {
          expect($post[0].getBoundingClientRect().bottom).to.be.at.most(barTop);
        });
      });
    });
  });
});
