import eventData from "../fixtures/eventData.json";
import groupData from "../fixtures/groupData.json";

describe("Banner image upload", () => {
  it("resizes and attaches a banner image when creating an event", () => {
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
    cy.get("#hostName").type(eventData.hostName);
    cy.get("#creatorEmail").type(eventData.creatorEmail);

    cy.get("#event-image-upload").selectFile(
      "cypress/fixtures/test-header.png",
      { force: true },
    );

    cy.get("#newEventFormSubmit").click();
    cy.url({ timeout: 10000 }).should("not.include", "/new");

    cy.get("#eventImageContainer img")
      .should("be.visible")
      .and("have.attr", "src")
      .and("match", /\/events\/.+\.jpg$/);
  });

  it("resizes and attaches a banner image when creating a group", () => {
    cy.visit("/new");
    cy.get("#showNewEventGroupFormButton").click();

    cy.get("#eventGroupName").type(groupData.eventGroupName);
    cy.get("#eventGroupDescription").type(groupData.eventGroupDescription);
    cy.get("#eventGroupURL").type(groupData.eventGroupURL);
    cy.get("#eventGroupHostName").type(groupData.hostName);
    cy.get("#eventGroupCreatorEmail").type(groupData.creatorEmail);

    cy.get("#group-image-upload").selectFile(
      "cypress/fixtures/test-header.png",
      { force: true },
    );

    cy.get("#newEventGroupForm").submit();
    cy.url({ timeout: 10000 }).should("not.include", "/new");

    cy.get("#eventImageContainer img")
      .should("be.visible")
      .and("have.attr", "src")
      .and("match", /\/events\/.+\.jpg$/);
  });
});
