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
      cy.wrap(editToken.slice(2)).as("editToken");
    });
  });

  it("shows the decline bar state and a host-only Can't attend card", function () {
    visitFresh(`/${this.eventID}`);

    cy.get("button#declineEvent").click();
    cy.get("#declineModal").should("be.visible");
    cy.get("#declineModal").should("have.focus");
    cy.get("#declineAttendeeName").type("Cannot Come");
    cy.get("form#declineEventForm").submit();

    // Declined viewer sees the fourth bar state
    cy.get(".rsvp-bar__status").should(
      "contain.text",
      "You said you can't attend",
    );
    cy.get("button#reattendEvent").should("be.visible");
    cy.get("button#deleteMyInfo").should("be.visible");
    cy.get("#eventDeclined").should("not.exist");

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

    // Dismiss the confirmation modal before interacting with the page
    // behind it - its backdrop blocks clicks until closed.
    cy.get("#rsvpConfirmModal", { timeout: 10000 }).should("be.visible");
    cy.get("#rsvpConfirmModal .close").click();
    // Bootstrap's modal close is a CSS fade transition - the modal (and its
    // click-blocking backdrop) is still display:block for a moment after
    // the close click resolves, so wait for it to actually finish hiding
    // before interacting with anything behind it.
    cy.get("#rsvpConfirmModal").should("not.be.visible");

    cy.get(".rsvp-bar__status").should("contain.text", "You're going");
    cy.get(".attendeesList").should("contain.text", "Maybe Later");

    // Switch to declined
    cy.get("button#declineExisting").click();
    cy.get("#rsvpConfirmModal", { timeout: 10000 }).should("be.visible");
    cy.get("#rsvpConfirmModal .close").click();
    // Bootstrap's modal close is a CSS fade transition - the modal (and its
    // click-blocking backdrop) is still display:block for a moment after
    // the close click resolves, so wait for it to actually finish hiding
    // before interacting with anything behind it.
    cy.get("#rsvpConfirmModal").should("not.be.visible");
    cy.get(".rsvp-bar__status").should(
      "contain.text",
      "You said you can't attend",
    );
    cy.get("#eventAttendees").should("not.contain.text", "Maybe Later");

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
    cy.get("#declineModal").should("have.focus");
    cy.get("#declineAttendeeName").type("Cannot Come");
    cy.get("form#declineEventForm").submit();

    cy.get("#attendees-alert").should("contain.text", "10 spots remaining");
  });

  it("still permanently deletes via the de-emphasized link", function () {
    visitFresh(`/${this.eventID}`);

    cy.get("button#declineEvent").click();
    cy.get("#declineModal").should("be.visible");
    cy.get("#declineModal").should("have.focus");
    cy.get("#declineAttendeeName").type("Cannot Come");
    cy.get("form#declineEventForm").submit();

    cy.get("#rsvpConfirmModal", { timeout: 10000 }).should("be.visible");
    cy.get("#rsvpConfirmModal .close").click();
    // Bootstrap's modal close is a CSS fade transition - the modal (and its
    // click-blocking backdrop) is still display:block for a moment after
    // the close click resolves, so wait for it to actually finish hiding
    // before interacting with anything behind it.
    cy.get("#rsvpConfirmModal").should("not.be.visible");

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
