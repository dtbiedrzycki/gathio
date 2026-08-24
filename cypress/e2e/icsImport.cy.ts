function icsMultipartBody(contents: string, boundary: string) {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="icsImportControl"; filename="event.ics"\r\n` +
    `Content-Type: text/calendar\r\n\r\n` +
    `${contents}\r\n` +
    `--${boundary}--\r\n`
  );
}

// Includes a VTIMEZONE block ahead of the VEVENT, since a parser that
// naively assumes the first parsed component is the event (rather than
// filtering for VEVENT) would otherwise import the timezone as the event.
const icsWithTimezone = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "CALSCALE:GREGORIAN",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:test-uid-123",
  "DTSTAMP:20260101T000000Z",
  "DTSTART:20260101T100000Z",
  "DTEND:20260101T110000Z",
  "SUMMARY:Imported Test Event",
  "LOCATION:Somewhere Nice",
  "DESCRIPTION:An imported event",
  'ORGANIZER;CN="Jane Doe":MAILTO:jane@example.com',
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("ICS calendar import", () => {
  it("creates an event from an uploaded .ics file, skipping past a leading VTIMEZONE block", () => {
    const boundary = "----cypressIcsImportBoundary";
    cy.request({
      method: "POST",
      url: "/import/event",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: icsMultipartBody(icsWithTimezone, boundary),
    }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property("eventID");
      expect(response.body).to.have.property("editToken");

      cy.visit(`/${response.body.eventID}`);
      cy.get("body").should("contain.text", "Imported Test Event");
      cy.get("body").should("contain.text", "Somewhere Nice");
    });
  });

  it("rejects an .ics file with no VEVENT", () => {
    const icsWithoutEvent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const boundary = "----cypressIcsImportBoundary";

    cy.request({
      method: "POST",
      url: "/import/event",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: icsMultipartBody(icsWithoutEvent, boundary),
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(400);
    });
  });
});
