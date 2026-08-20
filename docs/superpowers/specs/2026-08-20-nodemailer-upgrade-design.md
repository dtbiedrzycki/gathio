# Nodemailer Major Version Upgrade — Design

## Context

`nodemailer@6.9.13` (`package.json:54`) is used in exactly one file,
`src/lib/email.ts`, inside the `EmailService` class's `"nodemailer"` branch
(one of several transport options alongside SendGrid/Mailgun/none, selected
by `general.mail_service` in config):

```ts
// src/lib/email.ts:91-121 (nodemailer branch of the transport switch)
case "nodemailer": {
  if (config.nodemailer?.smtp_url) {
    this.nodemailerTransporter = nodemailer.createTransport(config.nodemailer?.smtp_url, ...);
  } else {
    // host/port/auth object form
    this.nodemailerTransporter = nodemailer.createTransport(nodemailerConfig);
  }
}
// ...
await this.nodemailerTransporter.sendMail({ ... });  // src/lib/email.ts:200
```

`feat/security-deps-update`'s Task 7 investigated bumping this and found the
high-severity findings have no same-major fix:

- **Message-level `raw` option bypasses `disableFileAccess`/`disableUrlAccess`**
  (arbitrary file read + full-response SSRF via a delivered message) —
  patched only at `>=9.0.1`.
- **`addressparser` recursive-call DoS** — patched only at `>=7.0.11`.
- Several moderate findings (CRLF injection variants, improper TLS cert
  validation during OAuth2 token fetch, SMTP command injection via
  `envelope.size`) are patched at various floors across the 7.x-9.x line.

That task correctly deferred rather than force a major bump without
reviewing what changed. This spec is that review.

## Goals

- Land on nodemailer `>=9.0.1` (the floor that actually closes the
  highest-severity finding) unless investigation finds a compelling reason
  to stop at an intermediate major.
- Confirm `nodemailer.createTransport(url | options)` and
  `.sendMail({...})` — the only two APIs `src/lib/email.ts` calls — are
  either unchanged or migrated correctly across 6→7→8→9.
- Preserve both `createTransport` call shapes currently in use (the
  connection-URL string form and the host/port/auth object form), since
  `config/config.toml` supports both (`config.nodemailer.smtp_url` vs.
  discrete `smtp_server`/`smtp_port`/`smtp_username`/`smtp_password`).

## Non-goals

- Adopting new nodemailer features unrelated to this fix (OAuth2 flows,
  new transport types, etc.) — this is a security-driven version bump, not
  a feature upgrade.
- Changing `EmailService`'s overall transport-selection architecture
  (sendgrid/mailgun/nodemailer/none switch) — out of scope, untouched.

## Open questions (resolve via `superpowers:brainstorming` before planning)

1. **Read nodemailer's actual changelog/migration notes for 6→7, 7→8, and
   8→9** before assuming API stability — the original plan's Global
   Constraints flagged that "nodemailer's major versions have changed
   transport config shapes before," which is exactly the risk this spec
   exists to retire. Confirm concretely, don't assume compatibility.
2. **Does this app's config ever rely on `disableFileAccess`/
   `disableUrlAccess`?** Check `src/lib/config.ts`'s `GathioConfig`/
   `defaultConfig` and `config/config.example.toml` for any nodemailer
   transport option beyond `smtp_url`/`smtp_server`/`smtp_port`/
   `smtp_username`/`smtp_password`. If those flags aren't set anywhere,
   the vulnerable `raw` option path may be reachable at its _default_
   (unset) value — worth confirming exactly what "bypasses
   disableFileAccess/disableUrlAccess" means when those options were never
   enabled in the first place, since that changes how urgent this is
   relative to the other three items in the roadmap.
3. **`SMTPTransport` type import** (`src/lib/email.ts:7`,
   `nodemailer/lib/smtp-transport/index.js`) — confirm this internal path
   still exists at the target version, or find its replacement export.

## Testing

- No existing Cypress coverage sends real email (mail service is
  `"none"` in the dev/test config per this session's investigation) — a
  full send-path e2e test isn't expected to newly exist here, but do
  check whether `EmailService` has any way to be exercised in CI (a
  fake/test transport, a mocked SMTP server) before assuming "build passes"
  is sufficient verification for a major bump.
- At minimum: manual verification against a real or local test SMTP
  endpoint (e.g. Mailhog/MailDev in `docker-compose.yml` if one exists, or
  a throwaway one added for this task) sending one message through both
  `createTransport` call shapes (`smtp_url` string and the discrete-fields
  object form).
