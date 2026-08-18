# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (Node >= 22, see `.nvmrc`).

```bash
pnpm install
cp config/config.example.toml config/config.toml   # required before first run; config.toml is gitignored
pnpm build          # tsc -> dist/
pnpm start          # node dist/start.js (needs a build first)
pnpm dev            # nodemon: rebuild + restart on changes in src/
pnpm lint           # eslint + prettier --check
pnpm lint:fix       # eslint --fix + prettier --write
```

Requires a running MongoDB at the `database.mongodb_url` from `config/config.toml`
(`docker-compose.yml` provides a `mongo` service; `gathio-dev` runs the app on port 3001 with `src/`,
`views/`, and `locales/` bind-mounted).

### Tests

Tests are Cypress e2e only — there is no unit test runner.

```bash
pnpm test           # headless: builds, starts with CYPRESS=true, runs all specs in Chrome
pnpm test:dev       # opens the Cypress UI against a dev server
```

Run a single spec (server must already be running with `CYPRESS=true`):

```bash
pnpm exec cypress run --e2e --browser chrome --spec cypress/e2e/event.cy.ts
```

`CYPRESS=true` enables a test-only escape hatch: `getConfigMiddleware` (`src/lib/middleware.ts`)
deep-merges a `cypressConfigOverride` cookie over the TOML config, so specs can flip instance
settings (e.g. `creator_email_addresses`) per test.

CI (`.github/workflows/ci.yaml`) runs lint, build, then the Cypress suite against a `mongo:latest` service.

## Architecture

Express + Handlebars server-rendered app, TypeScript ESM (`"type": "module"`, `moduleResolution: NodeNext`)
compiled to `dist/`. **Relative imports must carry a `.js` extension** even in `.ts` files.

### Startup

`src/start.ts` connects Mongoose and listens; `src/app.ts` builds the app: i18next (fs backend +
`accept-language`/cookie detection), the Handlebars instance and helpers, `EmailService`, then mounts
routers in order — `static`, `frontend`, `activitypub`, `event`, `group`, `magicLink`, and finally the
legacy `src/routes.js`, which also registers the catch-all 404.

### Route layering (important)

Routes are mid-migration. `src/routes.js` is the untyped legacy router still holding deletion, image
deletion, comments/replies, attendee provisioning, subscriptions, token verification, and the nightly
`node-schedule` job that deletes events older than `general.delete_after_days`. Newer, typed handlers
live in `src/routes/*.ts`. Prefer adding to the typed routers; when touching legacy code, moving the
handler over is usually the right call.

`src/routes/frontend.ts` renders pages; `event.ts`/`group.ts` are the JSON-ish mutation API used by the
browser modules in `public/js/modules/`; `activitypub.ts` serves actors, webfinger, nodeinfo, followers,
and inboxes.

### Auth model

There are no user accounts. Authorization is per-object **edit tokens**: creating an event or group
returns a token, and the host's URL is `/{eventID}?e={editToken}`. Handlers compare the submitted token
against `event.editToken` / `eventGroup.editToken`. Attendees get a separate `removalPassword` for
self-removal. Optionally, `general.creator_email_addresses` restricts event creation to an allowlist,
enforced by emailed **magic links** (`src/models/MagicLink.ts`, `src/routes/magicLink.ts`, and the
`checkMagicLink` middleware).

### Data

Mongoose 5 models in `src/models/`: `Event` (with embedded attendees, comments/replies, followers,
ActivityPub message log, and custom questions), `EventGroup` (holds `events` refs and email
subscribers), `MagicLink`, `Log`. Event/group IDs come from a nanoid alphabet in
`src/util/generator.ts` that deliberately excludes `-` for ActivityPub compatibility. Uploaded banner
images are resized with Jimp and written to `public/events/{eventID}.jpg` (gitignored).

### Federation

Each **event is itself an ActivityPub Actor** — the design rationale and the full inbox/outbox behavior
are documented in `FEDERATION.md`; read it before changing anything under `src/activitypub.ts`,
`src/lib/activitypub/`, or `src/routes/activitypub.ts`. HTTP signatures, key generation, and broadcast
helpers live in `src/activitypub.ts` and `src/lib/activitypub.ts`. `general.is_federated = false` must
404 these routes (`send404IfNotFederated`). Note that `express.json` is registered with a wildcard type
so `application/*+json` (ld+json, activitypub+json) parses.

### Config

TOML at `config/config.toml`, loaded and defaulted by `src/lib/config.ts`; string values may interpolate
`${GATHIO_*}` env vars. Never read the config directly in a request handler — use `getConfigMiddleware`
(puts it on `res.locals.config`) and `frontendConfig(res)` for template data, so Cypress overrides apply.
Adding a setting means touching `GathioConfig`, `defaultConfig`, `config.example.toml`, and usually
`frontendConfig`/`FrontendConfig`.

### Views and i18n

Handlebars templates in `views/` (layouts `main`/`email`, partials in `views/partials/`, email templates
paired as `*Html`/`*Text` under `views/emails/`). `views/` is excluded from Prettier. Translations are
flat key/value JSON in `locales/` (`en`, `ja`, `de`, `nn`), reached via i18next `t` helpers registered in
`src/helpers.ts` — add new strings to `locales/en.json` at minimum. Frontend JS is plain
jQuery/Bootstrap served from `public/js/` (vendored files there are lint- and Prettier-ignored); the
app's own scripts are in `public/js/modules/`.

### Email

`EmailService` (`src/lib/email.ts`) wraps nodemailer / SendGrid / Mailgun / none, chosen by
`general.mail_service`, and renders the paired Handlebars templates. It is attached to every request as
`req.emailService` (see `src/index.d.ts` for the Express type augmentation).

## Committing

Commits made by Claude Code from inside the sandboxed `toolbx` container are SSH-signed
with a container-specific key, so the machine that produced a commit can be identified
later. Use this invocation:

```bash
git -c gpg.format=ssh \
    -c user.signingkey=~/.ssh/<signing_key> \
    commit -S -m "<subject>

<body>

Commit-Machine: toolbx"
```

The signature is the proof of origin; the `Commit-Machine` trailer makes `git log`
readable without running verification. Signed-with-this-key means the container; the
maintainer's own commits carry their GPG signature instead.

Keep `Commit-Machine` in the same paragraph as any `Co-Authored-By` line — git parses only
the final paragraph as trailers, so a blank line between them silently drops
`Commit-Machine` from the trailer block. Check with
`git log -1 --format='%(trailers:key=Commit-Machine,valueonly)'`.

Do not move these settings into `.git/config` — this directory is also used from outside
the container, and repo-local signing config would re-sign the maintainer's commits with
the container key. (The sandbox blocks `git config` writes anyway: `.git/config.lock` is
bind-mounted from `/dev/null`.)

Verification uses `.gitsigners` in the repo root, which maps each trusted signing key to
the machine it belongs to:

```bash
git -c gpg.ssh.allowedSignersFile=$PWD/.gitsigners log --format='%h %G? %GS' -5
```

`G` = good trusted signature, `U` = good signature from an untrusted key, `N` = unsigned.
Set `gpg.ssh.allowedSignersFile` once (outside the sandbox) to skip the `-c` flag.

The signing key is passphrase-less so it can sign unattended: the sandbox denies AF_UNIX
sockets outright, so no ssh-agent or gpg-agent is reachable. It is safe because it is
**signing-only and never uploaded anywhere** — Forgejo cannot scope an SSH key to signing
only, so uploading it would turn it into a push credential.
