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
