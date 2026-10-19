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
});
