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
});
