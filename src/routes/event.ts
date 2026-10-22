import {
  Router,
  type Response,
  type Request,
  type NextFunction,
} from "express";
import multer from "multer";
import { Jimp } from "jimp";
import fs from "node:fs/promises";
import moment from "moment-timezone";
import {
  generateEditToken,
  generateEventID,
  generateRSAKeypair,
  hashString,
} from "../util/generator.js";
import { validateEventData } from "../util/validation.js";
import { addToLog } from "../helpers.js";
import Event, {
  getApprovedAttendeeCount,
  maxCustomQuestionAnswerLength,
  type ICustomQuestionAnswer,
  type IEvent,
} from "../models/Event.js";
import EventGroup from "../models/EventGroup.js";
import {
  broadcastCreateMessage,
  broadcastUpdateMessage,
  createActivityPubActor,
  createActivityPubEvent,
  createFeaturedPost,
  sendDirectMessage,
  updateActivityPubActor,
  updateActivityPubEvent,
} from "../activitypub.js";
import crypto from "node:crypto";
import ical, { type VEvent } from "node-ical";
import { markdownToSanitizedHTML } from "../util/markdown.js";
import { checkMagicLink, getConfigMiddleware } from "../lib/middleware.js";
import { frontendConfig, getConfig } from "../lib/config.js";
import { getCustomQuestionsForDisplay } from "../lib/event.js";
import { notifyHostOfNewAttendee } from "../lib/email.js";
import { parseInviteCsv } from "../lib/invite.js";
import { getMessage } from "../util/messages.js";
import i18next from "i18next";
moment.locale(i18next.language);
const config = getConfig();

// Room for a few names in one reply ("Laura & Bob"); the RSVP forms set the
// same limit as their maxlength
const MAX_ATTENDEE_NAME_LENGTH = 40;

const storage = multer.memoryStorage();
// Accept only JPEG, GIF or PNG images, up to 10MB
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (_, file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const mimetype = filetypes.test(file.mimetype);
    if (!mimetype) {
      return cb(new Error("Only JPEG, PNG and GIF images are allowed."));
    }
    cb(null, true);
  },
});
const icsUpload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (_, file, cb) {
    const filetype = "text/calendar";
    if (file.mimetype !== filetype) {
      return cb(new Error("Only ICS files are allowed."));
    }
    cb(null, true);
  },
});
const csvUpload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 },
  fileFilter: function (_, file, cb) {
    const allowedMimetypes = [
      "text/csv",
      "application/vnd.ms-excel",
      "text/plain",
    ];
    if (!allowedMimetypes.includes(file.mimetype)) {
      return cb(new Error("Only CSV files are allowed."));
    }
    cb(null, true);
  },
});

// Collect an attendee's answers to an event's custom questions from submitted
// form fields named `customQuestionAnswer-<questionID>`. Returns null if an
// answer wasn't one of its question's choices, which only happens if the host
// edited the choices while the attendee had the form open - or if the answer
// was tampered with.
const collectCustomQuestionAnswers = (
  event: Pick<IEvent, "customQuestions">,
  body: Record<string, unknown>,
): ICustomQuestionAnswer[] | null => {
  const answers: ICustomQuestionAnswer[] = [];
  for (const question of event.customQuestions || []) {
    const rawAnswer = body[`customQuestionAnswer-${question.id}`];
    const answer =
      typeof rawAnswer === "string"
        ? rawAnswer.trim().slice(0, maxCustomQuestionAnswerLength)
        : "";
    if (!answer) {
      continue;
    }
    if (
      question.type === "multipleChoice" &&
      !question.options.includes(answer)
    ) {
      return null;
    }
    answers.push({
      questionId: question.id,
      prompt: question.prompt,
      answer,
    });
  }
  return answers;
};

const router = Router();

router.use(getConfigMiddleware);

router.post(
  "/event",
  upload.single("imageUpload"),
  checkMagicLink,
  async (req: Request, res: Response) => {
    const { data: eventData, errors } = validateEventData(req.body);
    if (errors && errors.length > 0) {
      return res.status(400).json({ errors });
    }
    if (!eventData) {
      return res.status(400).json({
        errors: [
          {
            message: "No event data was provided.",
          },
        ],
      });
    }

    const eventID = generateEventID();
    const editToken = generateEditToken();
    let eventImageFilename: string | undefined;
    let isPartOfEventGroup = false;

    if (req.file?.buffer) {
      try {
        const img = await Jimp.read(req.file.buffer);
        img.resize({ w: 920 }); // resize
        const buffer = await img.getBuffer("image/jpeg", { quality: 80 }); // set JPEG quality
        await fs.writeFile("./public/events/" + eventID + ".jpg", buffer); // save
        eventImageFilename = eventID + ".jpg";
      } catch (err) {
        addToLog(
          "Jimp",
          "error",
          "Attempt to edit image failed with error: " + err,
        );
        eventImageFilename = undefined;
      }
    }

    const startUTC = moment.tz(eventData.eventStart, eventData.timezone);
    const endUTC = moment.tz(eventData.eventEnd, eventData.timezone);
    let eventGroup;
    if (eventData?.eventGroupBoolean) {
      try {
        eventGroup = await EventGroup.findOne({
          id: eventData.eventGroupID,
          editToken: eventData.eventGroupEditToken,
        });
        if (eventGroup) {
          isPartOfEventGroup = true;
        }
      } catch (err) {
        console.error(err);
        addToLog(
          "createEvent",
          "error",
          "Attempt to find event group failed with error: " + err,
        );
      }
    }

    // generate RSA keypair for ActivityPub
    const { publicKey, privateKey } = generateRSAKeypair();

    const event = new Event({
      id: eventID,
      type: "public", // This is for backwards compatibility
      name: eventData.eventName,
      location: eventData.eventLocation,
      start: startUTC,
      end: endUTC,
      timezone: eventData.timezone,
      description: eventData.eventDescription,
      image: eventImageFilename,
      creatorEmail: eventData.creatorEmail,
      url: eventData.eventURL,
      hostName: eventData.hostName,
      viewPassword: "", // Backwards compatibility
      editPassword: "", // Backwards compatibility
      editToken: editToken,
      showOnPublicList: eventData?.publicBoolean,
      eventGroup: isPartOfEventGroup ? eventGroup?._id : null,
      usersCanAttend: eventData.joinBoolean ? true : false,
      showUsersList: false, // Backwards compatibility
      usersCanComment: eventData.interactionBoolean ? true : false,
      maxAttendees: eventData.maxAttendees,
      firstLoad: true,
      activityPubActor: createActivityPubActor(
        eventID,
        res.locals.config?.general.domain,
        publicKey,
        markdownToSanitizedHTML(eventData.eventDescription),
        eventData.eventName,
        // Don't store location in ActivityPub data if approval is required
        eventData.approveRegistrationsBoolean && eventData.joinBoolean
          ? null
          : eventData.eventLocation,
        eventImageFilename,
        startUTC,
        endUTC,
        eventData.timezone,
      ),
      activityPubEvent: createActivityPubEvent(
        eventData.eventName,
        startUTC,
        endUTC,
        eventData.timezone,
        eventData.eventDescription,
        eventData.approveRegistrationsBoolean && eventData.joinBoolean
          ? null
          : eventData.eventLocation,
      ),
      activityPubMessages: [
        {
          id: `https://${res.locals.config?.general.domain}/${eventID}/m/featuredPost`,
          content: JSON.stringify(createFeaturedPost(eventID)),
        },
      ],
      publicKey,
      privateKey,
      approveRegistrations:
        eventData.approveRegistrationsBoolean && eventData.joinBoolean,
      customQuestions: eventData.customQuestions,
    });
    try {
      await event.save();
      addToLog("createEvent", "success", "Event " + eventID + "created");
      // Send email with edit link
      if (eventData.creatorEmail) {
        req.emailService.sendEmailFromTemplate({
          to: eventData.creatorEmail,
          subject: eventData.eventName,
          templateName: "createEvent",
          templateData: {
            eventID,
            editToken,
          },
        });
      }
      // If the event was added to a group, send an email to any group
      // subscribers
      if (event.eventGroup) {
        try {
          const eventGroup = await EventGroup.findOne({
            _id: event.eventGroup.toString(),
          });
          if (!eventGroup) {
            throw new Error("Event group not found for event " + eventID);
          }
          const subscribers = eventGroup?.subscribers?.reduce(
            (acc: string[], current) => {
              if (current.email && !acc.includes(current.email)) {
                return [current.email, ...acc];
              }
              return acc;
            },
            [] as string[],
          );
          subscribers?.forEach((emailAddress) => {
            req.emailService.sendEmailFromTemplate({
              to: emailAddress,
              subject: `New event in ${eventGroup.name}`,
              templateName: "eventGroupUpdated",
              templateData: {
                eventGroupName: eventGroup.name,
                eventName: event.name,
                eventID: event.id,
                eventGroupID: eventGroup.id,
                emailAddress: encodeURIComponent(emailAddress),
              },
            });
          });
        } catch (err) {
          console.error(err);
          addToLog(
            "createEvent",
            "error",
            "Attempt to send event group emails failed with error: " + err,
          );
        }
      }
      return res.json({
        eventID: eventID,
        editToken: editToken,
        url: `/${eventID}?e=${editToken}`,
      });
    } catch (err) {
      console.error(err);
      addToLog(
        "createEvent",
        "error",
        "Attempt to create event failed with error: " + err,
      );
      return res.status(500).json({
        errors: [
          {
            message: err,
          },
        ],
      });
    }
  },
);

router.put(
  "/event/:eventID",
  upload.single("imageUpload"),
  async (req: Request, res: Response) => {
    const { data: eventData, errors } = validateEventData(req.body);
    if (errors && errors.length > 0) {
      return res.status(400).json({ errors });
    }
    if (!eventData) {
      return res.status(400).json({
        errors: [
          {
            message: "No event data was provided.",
          },
        ],
      });
    }

    try {
      const submittedEditToken = req.body.editToken;
      const event = await Event.findOne({
        id: req.params.eventID,
      });
      if (!event) {
        return res.status(404).json({
          errors: [
            {
              message: "Event not found.",
            },
          ],
        });
      }
      if (event.editToken !== submittedEditToken) {
        // Token doesn't match
        addToLog(
          "editEvent",
          "error",
          `Attempt to edit event ${req.params.eventID} failed with error: token does not match`,
        );
        return res.status(403).json({
          errors: [
            {
              message: "Edit token is invalid.",
            },
          ],
        });
      }
      // Token matches
      // If there is a new image, upload that first
      const eventID = req.params.eventID;
      let eventImageFilename = event.image;
      if (req.file?.buffer) {
        try {
          const img = await Jimp.read(req.file.buffer);
          img.resize({ w: 920 }); // resize
          const buffer = await img.getBuffer("image/jpeg", { quality: 80 }); // set JPEG quality
          await fs.writeFile(`./public/events/${eventID}.jpg`, buffer); // save
        } catch (err) {
          addToLog(
            "Jimp",
            "error",
            "Attempt to edit image failed with error: " + err,
          );
        }

        eventImageFilename = eventID + ".jpg";
      }

      const startUTC = moment.tz(eventData.eventStart, eventData.timezone);
      const endUTC = moment.tz(eventData.eventEnd, eventData.timezone);

      let isPartOfEventGroup = false;
      let eventGroup;
      if (eventData.eventGroupBoolean) {
        eventGroup = await EventGroup.findOne({
          id: eventData.eventGroupID,
          editToken: eventData.eventGroupEditToken,
        });
        if (eventGroup) {
          isPartOfEventGroup = true;
        }
      }
      const updatedEvent = {
        name: eventData.eventName,
        location: eventData.eventLocation,
        start: startUTC.toDate(),
        end: endUTC.toDate(),
        timezone: eventData.timezone,
        description: eventData.eventDescription,
        url: eventData.eventURL,
        hostName: eventData.hostName,
        image: eventImageFilename,
        showOnPublicList: eventData.publicBoolean,
        usersCanAttend: eventData.joinBoolean,
        showUsersList: false, // Backwards compatibility
        usersCanComment: eventData.interactionBoolean,
        maxAttendees: eventData.maxAttendeesBoolean
          ? eventData.maxAttendees
          : undefined,
        eventGroup: isPartOfEventGroup ? eventGroup?._id : null,
        activityPubActor: event.activityPubActor
          ? updateActivityPubActor(
              JSON.parse(event.activityPubActor),
              eventData.eventDescription,
              eventData.eventName,
              // Don't store location in ActivityPub data if approval is required
              eventData.approveRegistrationsBoolean && eventData.joinBoolean
                ? null
                : eventData.eventLocation,
              eventImageFilename,
              startUTC,
              endUTC,
              eventData.timezone,
            )
          : undefined,
        activityPubEvent: event.activityPubEvent
          ? updateActivityPubEvent(
              JSON.parse(event.activityPubEvent),
              eventData.eventName,
              startUTC,
              endUTC,
              eventData.timezone,
              eventData.eventDescription,
              // Don't store location in ActivityPub data if approval is required
              eventData.approveRegistrationsBoolean && eventData.joinBoolean
                ? null
                : eventData.eventLocation,
            )
          : undefined,
        approveRegistrations:
          eventData.approveRegistrationsBoolean && eventData.joinBoolean,
        customQuestions: eventData.customQuestions,
      };
      let diffText = "<p>" + i18next.t("routes.event.difftext") + "</p><ul>";
      let displayDate;
      if (event.name !== updatedEvent.name) {
        diffText +=
          `<li>` +
          i18next.t("routes.event.namechanged", {
            eventname: updatedEvent.name,
          }) +
          `</li>`;
      }
      if (event.location !== updatedEvent.location) {
        diffText +=
          `<li>` +
          i18next.t("routes.event.locationchanged", {
            location: updatedEvent.location,
          }) +
          `</li>`;
      }
      if (event.start.toISOString() !== updatedEvent.start.toISOString()) {
        displayDate = moment
          .tz(updatedEvent.start, updatedEvent.timezone)
          .format(i18next.t("common.datetimeformat"));
        diffText +=
          `<li>` +
          i18next.t("routes.event.starttimechanged", {
            starttime: displayDate,
          }) +
          `</li>`;
      }
      if (event.end.toISOString() !== updatedEvent.end.toISOString()) {
        displayDate = moment
          .tz(updatedEvent.end, updatedEvent.timezone)
          .format(i18next.t("common.datetimeformat"));
        diffText +=
          `<li>` +
          i18next.t("routes.event.endtimechanged", {
            endtime: displayDate,
          }) +
          `</li>`;
      }
      if (event.timezone !== updatedEvent.timezone) {
        diffText +=
          `<li>` +
          i18next.t("routes.event.timezonechanged", {
            timezone: updatedEvent.timezone,
          }) +
          `</li>`;
      }
      if (event.description !== updatedEvent.description) {
        diffText +=
          `<li>` + i18next.t("routes.event.descriptionchanged") + `</li>`;
      }
      diffText += `</ul>`;
      const updatedEventObject = await Event.findOneAndUpdate(
        { id: req.params.eventID },
        updatedEvent,
        { new: true },
      );
      if (!updatedEventObject) {
        throw new Error("Event not found");
      }
      addToLog(
        "editEvent",
        "success",
        "Event " + req.params.eventID + " edited",
      );
      // send update to ActivityPub subscribers
      const attendees = updatedEventObject.attendees?.filter((el) => el.id);
      // broadcast an identical message to all followers, will show in home timeline
      const guidObject = crypto.randomBytes(16).toString("hex");
      const jsonObject = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `https://${res.locals.config?.general.domain}/${req.params.eventID}/m/${guidObject}`,
        name: `RSVP to ${event.name}`,
        type: "Note",
        cc: "https://www.w3.org/ns/activitystreams#Public",
        content: `${diffText} See here: <a href="https://${res.locals.config?.general.domain}/${req.params.eventID}">https://${res.locals.config?.general.domain}/${req.params.eventID}</a>`,
      };

      try {
        await broadcastCreateMessage(
          jsonObject,
          event.followers || [],
          eventID,
        );
      } catch (err) {
        return console.log("Error broadcasting create message:", err);
      }

      // also broadcast an Update profile message to all followers so that at least Mastodon servers will update the local profile information
      const jsonUpdateObject = JSON.parse(event.activityPubActor || "{}");

      try {
        await broadcastUpdateMessage(
          jsonUpdateObject,
          event.followers || [],
          eventID,
        );
      } catch (err) {
        return console.log("Error broadcasting update message:", err);
      }

      // also broadcast an Update/Event for any calendar apps that are consuming our Events
      const jsonEventObject = JSON.parse(event.activityPubEvent || "{}");

      try {
        await broadcastUpdateMessage(
          jsonEventObject,
          event.followers || [],
          eventID,
        );
      } catch (err) {
        return console.log("Error broadcasting event update message:", err);
      }

      // DM to attendees
      if (attendees?.length) {
        for (const attendee of attendees) {
          const jsonObject = {
            "@context": "https://www.w3.org/ns/activitystreams",
            name: `RSVP to ${event.name}`,
            type: "Note",
            content: `<span class="h-card"><a href="${attendee.id}" class="u-url mention">@<span>${attendee.name}</span></a></span> ${diffText} See here: <a href="https://${res.locals.config?.general.domain}/${req.params.eventID}">https://${res.locals.config?.general.domain}/${req.params.eventID}</a>`,
            tag: [
              {
                type: "Mention",
                href: attendee.id,
                name: attendee.name,
              },
            ],
          };
          // send direct message to user
          if (attendee.id) {
            try {
              await sendDirectMessage(jsonObject, attendee.id, eventID);
            } catch (err) {
              return console.log(`Error sending DM to ${attendee.id}:`, err);
            }
          }
        }
      }
      // Send update to all attendees
      const attendeeEmails = event.attendees
        ?.filter((o) => o.status === "attending" && o.email)
        .map((o) => o.email!);
      if (attendeeEmails?.length) {
        req.emailService.sendEmailFromTemplate({
          to: config.general.email,
          bcc: attendeeEmails,
          subject: i18next.t("routes.event.editedsubject", {
            eventname: event.name,
          }),
          templateName: "editEvent",
          templateData: {
            diffText,
            eventID: req.params.eventID,
          },
        });
      }
      res.sendStatus(200);
    } catch (err) {
      console.error(err);
      addToLog(
        "editEvent",
        "error",
        "Attempt to edit event " +
          req.params.eventID +
          " failed with error: " +
          err,
      );
      return res.status(500).json({
        errors: [
          {
            message: err,
          },
        ],
      });
    }
  },
);

router.post(
  "/event/:eventID/invite",
  csvUpload.single("csvUpload"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({
        errors: [{ message: "No CSV file was provided." }],
      });
    }

    const submittedEditToken = req.query.e || req.body.editToken;
    if (!submittedEditToken) {
      return res.status(401).json({ error: "Edit token required." });
    }

    try {
      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.status(404).json({
          errors: [{ message: "Event not found." }],
        });
      }

      if (event.editToken !== submittedEditToken) {
        addToLog(
          "inviteToEvent",
          "error",
          `Attempt to send invites for event ${req.params.eventID} failed with error: token does not match`,
        );
        return res.status(403).json({
          errors: [{ message: "Edit token is invalid." }],
        });
      }

      const parsed = parseInviteCsv(req.file.buffer);
      if (!parsed.ok) {
        return res.status(400).json({ errors: [{ message: parsed.error }] });
      }

      const subject = i18next.t("routes.invitetoeventsubject", {
        eventName: event.name,
      });
      const results = await Promise.all(
        parsed.valid.map((invite) =>
          req.emailService.sendEmailFromTemplate({
            to: invite.email,
            subject,
            templateName: "inviteToEvent",
            templateData: {
              name: invite.name,
              eventID: event.id,
              eventName: event.name,
            },
          }),
        ),
      );
      const sentCount = results.filter(Boolean).length;

      addToLog(
        "inviteToEvent",
        "success",
        `Sent ${sentCount} invite(s) for event ${req.params.eventID}, skipped ${parsed.skipped.length}`,
      );

      return res.json({
        sent: sentCount,
        skipped: parsed.skipped.length,
        skippedReasons: parsed.skipped.map((s) => `Row ${s.row}: ${s.reason}`),
      });
    } catch (e) {
      addToLog(
        "inviteToEvent",
        "error",
        `Attempt to send invites for event ${req.params.eventID} failed with error: ${e}`,
      );
      return res.status(500).json({
        errors: [{ message: "An unexpected error occurred." }],
      });
    }
  },
  // Catches multer errors (bad mimetype, file too large) from
  // csvUpload.single() above so they return this route's JSON error
  // contract instead of Express's default HTML error page.
  (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    return res.status(400).json({ errors: [{ message: err.message }] });
  },
);

router.post(
  "/import/event",
  icsUpload.single("icsImportControl"),
  checkMagicLink,
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res.status(400).json({
        errors: [
          {
            message: "No file was provided.",
          },
        ],
      });
    }

    const eventID = generateEventID();
    const editToken = generateEditToken();

    const iCalObject = ical.sync.parseICS(req.file.buffer.toString("utf8"));

    // node-ical also splits calendar-level properties (VERSION, PRODID, ...)
    // out into a trailing `vcalendar` entry, so pick the VEVENT explicitly
    // rather than assuming the first key.
    const importedEventData = Object.values(iCalObject).find(
      (component): component is VEvent => component?.type === "VEVENT",
    );

    if (!importedEventData) {
      return res.status(400).json({
        errors: [{ message: "No event was found in the provided file." }],
      });
    }

    // ICS properties with parameters (e.g. SUMMARY;LANGUAGE=de:...) come back
    // as { val, params } instead of a plain string.
    const unwrapValue = (
      value: { val: string } | string | undefined,
    ): string | undefined => (typeof value === "string" ? value : value?.val);

    const summary = unwrapValue(importedEventData.summary);

    let creatorEmail: string | undefined;
    if (req.body.creatorEmail) {
      creatorEmail = req.body.creatorEmail;
    } else if (importedEventData.organizer) {
      if (typeof importedEventData.organizer === "string") {
        creatorEmail = importedEventData.organizer.replace("MAILTO:", "");
      } else {
        creatorEmail = importedEventData.organizer.val.replace("MAILTO:", "");
      }
    }

    let hostName: string | undefined;
    if (importedEventData.organizer) {
      if (typeof importedEventData.organizer === "string") {
        hostName = importedEventData.organizer.replace(/["]+/g, "");
      } else {
        hostName = importedEventData.organizer.params.CN?.replace(/["]+/g, "");
      }
    }

    const event = new Event({
      id: eventID,
      type: "public",
      name: summary,
      location: unwrapValue(importedEventData.location),
      start: importedEventData.start,
      end: importedEventData.end,
      timezone: "Etc/UTC", // TODO: get timezone from ics file
      description: unwrapValue(importedEventData.description),
      image: "",
      creatorEmail,
      url: "",
      hostName,
      viewPassword: "",
      editPassword: "",
      editToken: editToken,
      usersCanAttend: false,
      showUsersList: false,
      usersCanComment: false,
      firstLoad: true,
    });
    try {
      await event.save();
      addToLog("createEvent", "success", `Event ${eventID} created`);
      // Send email with edit link
      if (creatorEmail) {
        req.emailService.sendEmailFromTemplate({
          to: creatorEmail,
          subject: summary || "",
          templateName: "createEvent",
          templateData: {
            eventID,
            editToken,
          },
        });
      }
      return res.json({
        eventID: eventID,
        editToken: editToken,
        url: `/${eventID}?e=${editToken}`,
      });
    } catch (err) {
      console.error(err);
      addToLog(
        "createEvent",
        "error",
        "Attempt to create event failed with error: " + err,
      );
      return res.status(500).json({
        errors: [
          {
            message: err,
          },
        ],
      });
    }
  },
);

// Remove self from event (attendee action)
router.delete(
  "/event/attendee/:eventID",
  async (req: Request, res: Response) => {
    const removalPassword = req.query.p;
    if (!removalPassword) {
      return res
        .status(400)
        .json({ error: "Please provide a removal password." });
    }
    try {
      const response = await Event.findOne({
        id: req.params.eventID,
        "attendees.removalPassword": removalPassword,
      });
      if (!response) {
        return res.status(404).json({
          error: "No attendee found with that removal password.",
        });
      }
      const attendee = response?.attendees?.find(
        (a) => a.removalPassword === removalPassword,
      );
      if (!attendee) {
        return res.status(404).json({
          error: "No attendee found with that removal password.",
        });
      }
      const attendeeEmail = attendee.email;
      const removalResponse = await Event.updateOne(
        { id: req.params.eventID },
        { $pull: { attendees: { removalPassword } } },
      );
      if (removalResponse.modifiedCount === 0) {
        return res.status(404).json({
          error: "No attendee found with that removal password.",
        });
      }
      addToLog(
        "unattendEvent",
        "success",
        `Attendee removed self from event ${req.params.eventID}`,
      );
      if (attendeeEmail) {
        await req.emailService.sendEmailFromTemplate({
          to: attendeeEmail,
          subject: i18next.t("routes.removeeventattendeesubject"),
          templateName: "unattendEvent",
          templateData: {
            eventID: req.params.eventID,
          },
        });
      }
      res.sendStatus(200);
    } catch (e) {
      addToLog(
        "removeEventAttendee",
        "error",
        `Attempt to remove attendee from event ${req.params.eventID} failed with error: ${e}`,
      );
      return res.status(500).json({
        error: "There has been an unexpected error. Please try again.",
      });
    }
  },
);

// One-click links from email are GET requests, which mail clients and
// security scanners (Microsoft Defender Safe Links, Gmail's link proxy,
// corporate mail gateways) routinely prefetch to scan for malware - a GET
// that mutates data would fire on that prefetch, before the recipient ever
// clicks anything. So the GET here only renders a confirmation page; the
// actual decline happens on the POST the page's own button submits.
router.get(
  "/event/:eventID/unattend/:removalPasswordHash",
  async (req: Request, res: Response) => {
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.redirect("/404");
    }
    const attendee = event.attendees?.find(
      (o) =>
        hashString(o.removalPassword || "") === req.params.removalPasswordHash,
    );
    if (!attendee) {
      return res.redirect(`/${req.params.eventID}`);
    }
    return res.render("eventRsvpConfirm", {
      ...frontendConfig(res),
      title: event.name,
      eventID: event.id,
      confirmTitle: i18next.t("views.rsvpconfirm.declinetitle"),
      confirmDescription: i18next.t("views.rsvpconfirm.declinedesc", {
        eventName: event.name,
      }),
      confirmButtonLabel: i18next.t("views.rsvpconfirm.declinebutton"),
      formAction: `/event/${event.id}/unattend/${req.params.removalPasswordHash}`,
    });
  },
);

router.post(
  "/event/:eventID/unattend/:removalPasswordHash",
  async (req: Request, res: Response) => {
    // Find the attendee by the unattendPasswordHash
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.redirect("/404");
    }
    const attendee = event.attendees?.find(
      (o) =>
        hashString(o.removalPassword || "") === req.params.removalPasswordHash,
    );
    if (!attendee) {
      return res.redirect(`/${req.params.eventID}`);
    }
    // Mark the attendee as declined rather than deleting their record
    attendee.status = "declined";
    event.markModified("attendees");
    await event.save();
    // Send email to the attendee
    if (attendee.email) {
      req.emailService.sendEmailFromTemplate({
        to: attendee.email,
        subject: i18next.t("routes.declineeventattendeesubject"),
        templateName: "declineEvent",
        templateData: {
          eventID: req.params.eventID,
          eventName: event.name,
          removalPassword: attendee.removalPassword,
        },
      });
    }
    addToLog(
      "declineEventAttendee",
      "success",
      `Attendee declined event ${req.params.eventID} via one-click link`,
    );
    return res.redirect(
      `/${req.params.eventID}?p=${encodeURIComponent(attendee.removalPassword || "")}&m=rsvpdeclined`,
    );
  },
);

// One-click full data erasure from an email, as opposed to the unattend
// link above which only declines. Removes the attendee record entirely.
// Same GET-renders-confirmation / POST-mutates split as the unattend
// route above, for the same reason (GET must stay safe to prefetch).
router.get(
  "/event/:eventID/erase/:removalPasswordHash",
  async (req: Request, res: Response) => {
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.redirect("/404");
    }
    const attendee = event.attendees?.find(
      (o) =>
        hashString(o.removalPassword || "") === req.params.removalPasswordHash,
    );
    if (!attendee) {
      return res.redirect(`/${req.params.eventID}`);
    }
    return res.render("eventRsvpConfirm", {
      ...frontendConfig(res),
      title: event.name,
      eventID: event.id,
      confirmTitle: i18next.t("views.rsvpconfirm.erasetitle"),
      confirmDescription: i18next.t("views.rsvpconfirm.erasedesc", {
        eventName: event.name,
      }),
      confirmButtonLabel: i18next.t("views.rsvpconfirm.erasebutton"),
      formAction: `/event/${event.id}/erase/${req.params.removalPasswordHash}`,
      // The confirm page's HTML <form> can only submit GET/POST, but
      // erasure is a deletion, so once JS is confirmed available (this is
      // a normal webpage the email link navigates to, not the email body
      // itself - mail clients strip <script> from email HTML, not from
      // pages their links point to) it uses axios.delete() for the
      // correct verb instead of a plain form POST.
      useAxiosDelete: true,
    });
  },
);

router.delete(
  "/event/:eventID/erase/:removalPasswordHash",
  async (req: Request, res: Response) => {
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }
    const attendee = event.attendees?.find(
      (o) =>
        hashString(o.removalPassword || "") === req.params.removalPasswordHash,
    );
    if (!attendee) {
      return res.status(404).json({ error: "Attendee not found." });
    }
    const attendeeEmail = attendee.email;
    await Event.updateOne(
      { id: req.params.eventID },
      { $pull: { attendees: { removalPassword: attendee.removalPassword } } },
    );
    if (attendeeEmail) {
      await req.emailService.sendEmailFromTemplate({
        to: attendeeEmail,
        subject: i18next.t("routes.removeeventattendeesubject"),
        templateName: "unattendEvent",
        templateData: {
          eventID: req.params.eventID,
        },
      });
    }
    addToLog(
      "eraseEventAttendee",
      "success",
      `Attendee erased self from event ${req.params.eventID} via one-click link`,
    );
    return res.sendStatus(200);
  },
);

// Re-sends an attendee's manage/decline/erase links by email, for anyone who
// lost the link (different browser, cleared storage, etc). Always responds
// with the same generic message regardless of whether the email matches an
// attendee, so this can't be used to test which emails are RSVPed - same
// anti-enumeration pattern as the magic-link create-event flow
// (src/routes/magicLink.ts).
router.post(
  "/event/:eventID/resend-link",
  async (req: Request, res: Response) => {
    const email = req.body.email;
    if (!email) {
      return res.status(400).json({ error: "Please provide an email." });
    }
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }
    const matches = event.attendees?.filter(
      (a) =>
        a.email?.toLowerCase() === email.toLowerCase() &&
        a.status !== "provisioned",
    );
    for (const attendee of matches || []) {
      if (!attendee.removalPassword) continue;
      req.emailService.sendEmailFromTemplate({
        to: email,
        subject: i18next.t("routes.resendremovallinksubject", {
          eventName: event.name,
        }),
        templateName: "resendRemovalLink",
        templateData: {
          eventID: req.params.eventID,
          eventName: event.name,
          removalPassword: attendee.removalPassword,
          removalPasswordHash: hashString(attendee.removalPassword),
        },
      });
    }
    addToLog(
      "resendRemovalLink",
      "success",
      `Resend-link requested for event ${req.params.eventID}`,
    );
    return res.json({
      message: i18next.t("routes.resendremovallinksent"),
    });
  },
);

// Finalize attendance (convert provisioned attendee to attending)
router.post("/event/:eventID/attendee", async (req: Request, res: Response) => {
  const {
    removalPassword,
    attendeeName: rawAttendeeName,
    attendeeEmail,
    attendeeNumber,
    attendeeVisible,
    attendeeStatus,
    fullForm,
  } = req.body;
  // Absent for the one-click toggle back to attending, which keeps the name
  const attendeeName =
    typeof rawAttendeeName === "string"
      ? rawAttendeeName.trim()
      : rawAttendeeName;

  const targetStatus: "attending" | "declined" =
    attendeeStatus === "declined" ? "declined" : "attending";

  if (!removalPassword) {
    return res.status(400).json({ error: "Removal password is required." });
  }
  if (
    typeof attendeeName === "string" &&
    attendeeName.length > MAX_ATTENDEE_NAME_LENGTH
  ) {
    return res.status(400).json({
      error: `Names can be up to ${MAX_ATTENDEE_NAME_LENGTH} characters.`,
    });
  }

  try {
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }

    const attendee = event.attendees?.find(
      (a) => a.removalPassword === removalPassword,
    );
    if (!attendee) {
      return res.status(404).json({ error: "Attendee not found." });
    }

    // Check if this is the host adding an attendee (via edit token)
    const editToken = req.query.e || req.body.editToken;
    const isHostAdding = editToken && editToken === event.editToken;

    if (targetStatus === "declined") {
      // Declining: name only, no capacity check, no approval, no custom
      // questions, no confirmation email (no email is ever collected).
      const name = attendeeName || attendee.name;
      if (!name) {
        return res.status(400).json({ error: "Name is required." });
      }
      attendee.status = "declined";
      attendee.name = name;

      event.markModified("attendees");
      await event.save();

      addToLog(
        "declineEventAttendee",
        "success",
        `Attendee declined event ${req.params.eventID}`,
      );

      if (isHostAdding) {
        return res.redirect(`/${req.params.eventID}?e=${editToken}`);
      }
      const declinedNoEmailFlag = attendee.email ? "" : "&noemail=1";
      return res.redirect(
        `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}&m=rsvpdeclined${declinedNoEmailFlag}`,
      );
    }

    // targetStatus === "attending" — covers both the original full-form
    // RSVP and a one-click "switch back to attending" toggle (which sends
    // only removalPassword + attendeeStatus, no other fields). Fields not
    // present in the request keep their existing value on the record.
    const effectiveNumber =
      attendeeNumber !== undefined
        ? parseInt(attendeeNumber, 10) || 1
        : attendee.number || 1;

    // Check capacity - for approval-required events, only count approved attendees
    if (event.maxAttendees !== null && event.maxAttendees !== undefined) {
      const freeSpots = event.maxAttendees - getApprovedAttendeeCount(event);
      if (effectiveNumber > freeSpots) {
        return res.status(403).json({ error: "Not enough spots available." });
      }
    }

    // Collect answers to the event's custom questions. This is a plain form
    // POST, so a bad answer redirects with a message rather than serving raw
    // JSON. Skipped entirely for a bare toggle (no question fields present in
    // the body) so a one-click "switch back to attending" doesn't wipe out
    // previously-submitted answers - collectCustomQuestionAnswers would
    // otherwise happily return [] for a body with none of the expected keys.
    // The real field name pattern, from collectCustomQuestionAnswers itself
    // (src/routes/event.ts:79), is `customQuestionAnswer-${question.id}`.
    const hasQuestionFields = Object.keys(req.body).some((key) =>
      key.startsWith("customQuestionAnswer-"),
    );
    let answers = attendee.answers || [];
    if (hasQuestionFields) {
      const collected = collectCustomQuestionAnswers(event, req.body);
      if (collected === null) {
        return res.redirect(`/${req.params.eventID}?m=badanswer`);
      }
      answers = collected;
    }

    // Update attendee
    attendee.status = "attending";
    attendee.name = attendeeName || attendee.name;
    attendee.email =
      attendeeEmail !== undefined ? attendeeEmail : attendee.email;
    attendee.number = effectiveNumber;
    attendee.visibility = fullForm
      ? attendeeVisible
        ? "public"
        : "private"
      : attendee.visibility || "public";
    attendee.answers = answers;

    // Auto-approve if host is adding, or if event doesn't require approval
    if (isHostAdding || !event.approveRegistrations) {
      attendee.approved = true;
    }

    // Mark subdocument as modified so Mongoose detects changes
    event.markModified("attendees");
    await event.save();

    addToLog(
      "addEventAttendee",
      "success",
      `Attendee added to event ${req.params.eventID}`,
    );

    // Send confirmation email to attendee
    if (attendeeEmail && attendee.approved) {
      try {
        await req.emailService.sendEmailFromTemplate({
          to: attendeeEmail,
          subject: i18next.t("routes.addeventattendeesubject", {
            eventName: event.name,
          }),
          templateName: "addEventAttendee",
          templateData: {
            eventID: req.params.eventID,
            removalPassword,
            removalPasswordHash: hashString(removalPassword),
            answers,
          },
        });
      } catch (e) {
        console.error("Error sending addEventAttendee email:", e);
      }
    } else if (attendeeEmail && !attendee.approved) {
      try {
        await req.emailService.sendEmailFromTemplate({
          to: attendeeEmail,
          subject: i18next.t("routes.attendeependingconfirmationsubject", {
            eventName: event.name,
          }),
          templateName: "attendeePendingConfirmation",
          templateData: {
            eventID: req.params.eventID,
            eventName: event.name,
            removalPassword,
          },
        });
      } catch (e) {
        console.error("Error sending attendeePendingConfirmation email:", e);
      }
    }

    // Notify the host of the new RSVP, unless they added the attendee
    // themselves, or this is just a one-click toggle back to attending
    // (no attendeeName present) rather than a genuinely new RSVP.
    if (!isHostAdding && attendeeName) {
      await notifyHostOfNewAttendee({
        emailService: req.emailService,
        event,
        attendeeName: attendee.name,
        answers,
        logProcess: "addEventAttendee",
      });
    }

    // Redirect appropriately based on who is adding the attendee
    const attendingNoEmailFlag = attendee.email ? "" : "&noemail=1";
    if (isHostAdding) {
      // Host added attendee - redirect back to edit view
      return res.redirect(`/${req.params.eventID}?e=${editToken}`);
    } else if (event.approveRegistrations) {
      // Approval required - show save link modal since location is hidden until approved
      return res.redirect(
        `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}&m=rsvppending${attendingNoEmailFlag}`,
      );
    } else {
      // No approval needed - just redirect with ?p
      return res.redirect(
        `/${req.params.eventID}?p=${encodeURIComponent(removalPassword)}&m=rsvpgoing${attendingNoEmailFlag}`,
      );
    }
  } catch (e) {
    addToLog(
      "addEventAttendee",
      "error",
      `Attempt to add attendee to event ${req.params.eventID} failed with error: ${e}`,
    );
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

// Approve an attendee (host action for approval-required events)
router.patch(
  "/event/:eventID/attendee/:attendeeID",
  async (req: Request, res: Response) => {
    const editToken = req.query.e || req.body.editToken;
    if (!editToken) {
      return res.status(401).json({ error: "Edit token required." });
    }
    try {
      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.status(404).json({ error: "Event not found." });
      }
      if (event.editToken !== editToken) {
        return res.status(403).json({ error: "Invalid edit token." });
      }
      const attendee = event.attendees?.find(
        (a) => a._id?.toString() === req.params.attendeeID,
      );
      if (!attendee) {
        return res.status(404).json({ error: "Attendee not found." });
      }
      // Update approval status
      if (req.body.approved !== undefined) {
        attendee.approved = req.body.approved;
      }
      await event.save();
      addToLog(
        "approveEventAttendee",
        "success",
        `Attendee ${req.params.attendeeID} approved in event ${req.params.eventID}`,
      );
      // Notify the attendee they've been approved
      if (req.body.approved) {
        if (attendee.email) {
          // Web attendee - send email
          await req.emailService.sendEmailFromTemplate({
            to: attendee.email,
            subject: i18next.t("routes.attendeeapprovedsubject", {
              eventName: event.name,
            }),
            templateName: "attendeeApproved",
            templateData: {
              eventID: req.params.eventID,
              eventName: event.name,
              removalPassword: attendee.removalPassword,
            },
          });
        } else if (attendee.id && attendee.id.startsWith("https://")) {
          // Fediverse attendee - send DM
          const fullAttendee = event.attendees?.find(
            (a) => a._id?.toString() === req.params.attendeeID,
          );
          const unattendLink = `https://${res.locals.config?.general.domain}/oneclickunattendevent/${req.params.eventID}/${fullAttendee?._id}`;
          const jsonObject = {
            "@context": "https://www.w3.org/ns/activitystreams",
            name: `Approved for ${event.name}`,
            type: "Note",
            content: `<span class="h-card"><a href="${attendee.id}" class="u-url mention">@<span>${attendee.name}</span></a></span> You've been approved to attend ${event.name}! You can view the event here: <a href="https://${res.locals.config?.general.domain}/${req.params.eventID}">https://${res.locals.config?.general.domain}/${req.params.eventID}</a>. To remove yourself from the RSVP list, click <a href="${unattendLink}">here</a>.`,
            tag: [
              {
                type: "Mention",
                href: attendee.id,
                name: attendee.name,
              },
            ],
          };
          if (attendee.id) {
            try {
              await sendDirectMessage(
                jsonObject,
                attendee.id,
                req.params.eventID,
              );
            } catch (err) {
              return console.log(
                `Error sending approval DM to ${attendee.id}:`,
                err,
              );
            }
          }
        }
      }
      // Redirect back to event page in edit mode
      return res.redirect(
        `/${req.params.eventID}?e=${event.editToken}&m=approved`,
      );
    } catch (e) {
      addToLog(
        "approveEventAttendee",
        "error",
        `Attempt to approve attendee in event ${req.params.eventID} failed with error: ${e}`,
      );
      return res.status(500).json({ error: "An unexpected error occurred." });
    }
  },
);

// Deny/remove an attendee (host action)
router.delete(
  "/event/:eventID/attendee/:attendeeID",
  async (req: Request, res: Response) => {
    const editToken = req.query.e || req.body.editToken;
    if (!editToken) {
      return res.status(401).json({ error: "Edit token required." });
    }
    try {
      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.status(404).json({ error: "Event not found." });
      }
      if (event.editToken !== editToken) {
        return res.status(403).json({ error: "Invalid edit token." });
      }
      const attendee = event.attendees?.find(
        (a) => a._id?.toString() === req.params.attendeeID,
      );
      if (!attendee) {
        return res.status(404).json({ error: "Attendee not found." });
      }
      // Remove the attendee
      event.attendees = event.attendees?.filter(
        (a) => a._id?.toString() !== req.params.attendeeID,
      );
      await event.save();
      addToLog(
        "denyEventAttendee",
        "success",
        `Attendee ${req.params.attendeeID} removed from event ${req.params.eventID}`,
      );
      // Redirect back to event page in edit mode
      return res.redirect(
        `/${req.params.eventID}?e=${event.editToken}&m=denied`,
      );
    } catch (e) {
      addToLog(
        "denyEventAttendee",
        "error",
        `Attempt to deny attendee in event ${req.params.eventID} failed with error: ${e}`,
      );
      return res.status(500).json({ error: "An unexpected error occurred." });
    }
  },
);

// Standalone form for answering an event's custom questions. Linked from the
// DM sent to fediverse attendees, who can't answer at RSVP time. The URL is
// keyed on a hash of the attendee's removal password (like the one-click
// unattend link) so only that attendee can answer.
const findAttendeeByRemovalPasswordHash = (
  event: IEvent,
  removalPasswordHash: string,
) =>
  event.attendees?.find(
    (a) =>
      a.removalPassword &&
      hashString(a.removalPassword) === removalPasswordHash &&
      a.status === "attending",
  );

router.get(
  "/event/:eventID/answers/:removalPasswordHash",
  async (req: Request, res: Response) => {
    const event = await Event.findOne({ id: req.params.eventID });
    if (!event) {
      return res.status(404).render("404", frontendConfig(res));
    }
    const attendee = findAttendeeByRemovalPasswordHash(
      event,
      req.params.removalPasswordHash,
    );
    if (!attendee || !event.customQuestions?.length) {
      return res.status(404).render("404", frontendConfig(res));
    }
    return res.render("eventAnswers", {
      ...frontendConfig(res),
      title: event.name,
      eventID: event.id,
      eventName: event.name,
      removalPasswordHash: req.params.removalPasswordHash,
      attendeeName: attendee.name,
      alreadyAnswered: !!attendee.answers?.length,
      message: getMessage(req.query.m as string),
      customQuestions: getCustomQuestionsForDisplay(event),
    });
  },
);

router.post(
  "/event/:eventID/answers/:removalPasswordHash",
  async (req: Request, res: Response) => {
    const formURL = `/event/${req.params.eventID}/answers/${req.params.removalPasswordHash}`;
    try {
      const event = await Event.findOne({ id: req.params.eventID });
      if (!event) {
        return res.status(404).render("404", frontendConfig(res));
      }
      const attendee = findAttendeeByRemovalPasswordHash(
        event,
        req.params.removalPasswordHash,
      );
      if (!attendee || !event.customQuestions?.length) {
        return res.status(404).render("404", frontendConfig(res));
      }
      // Answers are locked in once at least one has been given
      if (attendee.answers?.length) {
        return res.redirect(formURL);
      }
      const answers = collectCustomQuestionAnswers(event, req.body);
      if (answers === null) {
        return res.redirect(`${formURL}?m=badanswer`);
      }
      // Don't claim success for an all-blank submission
      if (!answers.length) {
        return res.redirect(`${formURL}?m=noanswers`);
      }
      attendee.answers = answers;
      event.markModified("attendees");
      await event.save();
      addToLog(
        "attendeeAnswers",
        "success",
        `Attendee answered custom questions for event ${req.params.eventID}`,
      );
      // Send the answers to the host
      if (event.creatorEmail) {
        try {
          const sent = await req.emailService.sendEmailFromTemplate({
            to: event.creatorEmail,
            subject: i18next.t("routes.attendeeansweredsubject", {
              eventName: event.name,
            }),
            templateName: "attendeeAnswered",
            templateData: {
              eventID: req.params.eventID,
              eventName: event.name,
              attendeeName: attendee.name,
              editToken: event.editToken,
              answers,
            },
          });
          if (!sent) {
            addToLog(
              "attendeeAnswers",
              "error",
              `Failed to send attendeeAnswered email for event ${req.params.eventID}`,
            );
          }
        } catch (e) {
          console.error("Error sending attendeeAnswered email:", e);
        }
      }
      return res.redirect(`/${req.params.eventID}?m=answers`);
    } catch (e) {
      addToLog(
        "attendeeAnswers",
        "error",
        `Attempt to save answers for event ${req.params.eventID} failed with error: ${e}`,
      );
      return res.status(500).json({ error: "An unexpected error occurred." });
    }
  },
);

export default router;
