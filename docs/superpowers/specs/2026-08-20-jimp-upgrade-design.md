# Jimp Major Version Upgrade — Design

## Context

`jimp@0.16.13` (pinned in `package.json:43`) is used to resize user-uploaded
banner images at four call sites: `src/routes/event.ts:153` and `:387`,
`src/routes/group.ts:57` and `:183`. All four follow the same pattern:

```ts
const img = await Jimp.read(req.file.buffer);
img.resize(920, Jimp.AUTO) // resize
  ...
  "Jimp",
```

`jimp@0.16.13` internally pins `file-type@16.5.4` (via
`@jimp/core>load-bmfont>file-type`), five majors behind the patched floor
(`>=21.3.1`) for a moderate-severity infinite-loop DoS on malformed ASF
input, and pulls `min-document` (low-severity prototype pollution) via a
separate internal chain. `feat/security-deps-update` ruled these out of
scope rather than overriding `file-type`/`min-document` directly, because
forcing a 5-major jump on a dependency deep inside jimp's own internals
risks breaking image-type detection with no visibility into jimp's
internal assumptions about that library's API.

This is the most reachable finding deferred from that branch: these four
call sites process untrusted, user-uploaded bytes directly.

**No existing Cypress coverage for this path** — `grep -rl "banner\|Banner"
cypress/e2e/` finds only an unrelated string match in
`customQuestions.cy.ts`. Adding e2e coverage for banner upload/resize is
part of this work, not optional — it's the main way to catch a jimp API
regression before merge.

## Goals

- Replace `jimp@0.16.13` with a version (or, if warranted, a different
  library) whose `file-type` and any prototype-pollution-vulnerable
  internals are patched.
- Preserve current behavior at all four call sites: read an uploaded image
  buffer, resize to 920px wide (auto height), write out as a JPEG (per the
  `"Jimp"` log tag and surrounding code — confirm exact output format/path
  handling at each site before changing anything).
- Add Cypress coverage exercising at least one banner upload end-to-end
  (event and/or group creation with an image attached), since none exists
  today and this is exactly the path being changed.

## Non-goals

- Redesigning the image-processing pipeline (crop, format conversion,
  multiple sizes, etc.) — out of scope. This is a dependency-version fix
  that must not change user-visible resize behavior.
- Switching to a different image library (e.g. `sharp`) is a real option
  (see Open Questions) but should only be taken if the jimp-upgrade path
  turns out to be a bigger lift than a library swap — don't default to it.

## Open questions (resolve via `superpowers:brainstorming` before planning)

1. **Target jimp version and API surface.** jimp has had major API changes
   since 0.16.x (ESM-first packaging, restructured plugin system in
   later majors). Check the current latest jimp release and whether
   `Jimp.read()` / `.resize(w, Jimp.AUTO)` / the write-out call at each site
   still exist with the same signatures, or need rewriting. This needs
   real investigation against jimp's actual current docs/changelog, not
   assumption.
2. **Is a full library swap (e.g. to `sharp`) actually simpler?** `sharp` is
   a native (libvips-backed) image library, actively maintained, no
   equivalent `file-type`/`min-document` exposure. Four call sites with a
   narrow API surface (read buffer → resize → write) make a swap plausible,
   but it adds a native-binary dependency (build/deploy implications on
   whatever platforms this app ships to — check `Dockerfile`/`docker-compose.yml`
   for constraints) that a same-library major bump avoids. Decide during
   brainstorming, not now.
3. **Exact output format/quality at each of the 4 call sites** — read the
   full surrounding code at each site (not just the `resize` line shown
   above) before finalizing either approach, to confirm nothing else
   (quality settings, format-specific options) depends on jimp-0.16-specific
   behavior.

## Testing

- New Cypress spec (or addition to an existing event/group spec) that
  uploads an image during event or group creation/edit and asserts the
  banner renders afterward.
- Manual verification: upload a banner locally, confirm visual output is
  unchanged (same resize dimensions, no quality regression) before and
  after the dependency change.
