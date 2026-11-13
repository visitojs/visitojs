# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A change to what an id is built from raises `ID_VERSION` and is called out, because ids from different versions cannot be compared.

## [Unreleased]

## [1.0.0] - 2026-11-13

### Changed

- Breaking: every `id` and `idStrict` changes once, because the id definition is now version 3 (`v: 3`) and 0.1.0 built version 2.
- The stored id (`did`) does not change, and its cookie and localStorage entry keep their name and format.
- Ids stored before the upgrade are version 2: label them `v: 2`, never compare them with version-3 ids, and let the stored id carry visitors across; `match` compares readings of different versions by stored id only.
- On a browser without CSS `env()`, the text scale is `!na` instead of the page's own line height, so the text size no longer follows the site.
- A text-size read that fails now leaves no id and is named in `flags.partial`, instead of letting another value stand in.
- Brave's desktop builds leave the screen out, so their id is the language and the text size alone, `flags.weak` is true, and Brave desktops with the same two share an `id`.
- Huawei's browser is identified by the phone's model instead of "HarmonyOS", and has no model when an "HMSCore" token stands in its place.
- Opera on iOS is labelled `opera`, which changes its `idStrict`.
- A page that breaks `String.prototype.split` is no longer taken for Brave.
- The Safari 17 screen rule covers every WebKit browser at that level, not Safari alone, and the engine is told by new feature tests; both changed after 0.1.0 without raising the version, and count as version 3.
- A normal Firefox window now gives `flags.private` as `null` instead of `false`, because Firefox is bringing the file system the check uses to private windows.
- The private-window check is new code written from the File System and Storage standards; it reads only the error's name and skips the file system when `localStorage` cannot be read.
- An Electron app is no longer marked `headless`.
- The `global` mark looks for the 8 names found in each automation tool's own source, and no longer for six names that no tool sets.
- `x.ch.brands` lists the client-hint brands sorted and reads at most 32 of them.
- `match` compares values by their text, so `'8'` from a store equals `8`.
- `match` decides `same` on an equal stored id with or without `c`, and counts a stored id only when it is a non-empty string on both sides.
- `match` compares a candidate of another `v` by stored id only (rule `other id version`), and `Seen` has an optional `v`.
- `match` compares versions only on the fields both sides have, and skips a malformed candidate instead of throwing.
- The core build is 7,460 bytes gzipped, down from 8,096 in 0.1.0; the size work itself changed no id.
- The lab build's canvas, audio and Math reads are new code with a known-answer check in every read, so their lab values differ from 0.1.0's.
- The README describes what `get()` does when timers are late or broken and what happens inside a frame, and `docs/SIGNALS.md` matches the code.
- The README is shorter and starts with the quick start; the full API reference, consent wiring, the matcher's rules and the deep entry moved to `docs/API.md`, which the package ships.

### Added

- `visitojs/defer` (`dist/visito.defer.min.js`, 7,568 bytes gzipped) reads and stores nothing until the page calls `start()`, and `start({ store: false })` reads the device without touching any storage.
- `visitojs/deep` (`dist/deep.min.js`, 6,402 bytes gzipped) is an experimental entry that builds a separate id from one canvas drawing of shapes, with no text, and an offline audio render, only when called, and never changes `id` or `idStrict`.
- Type declarations for both entries, and a type test that pins every field of the reading.
- The lab build records ten automation mark candidates as `x.bot.*` hints; none ships as a mark in 1.0.
- `lab/compare.mjs` runs VisitoJS and pinned published builds of three other open-source libraries through the same checks, and `lab/compare/table.mjs` writes the table with its method.
- `lab/engines.mjs`, `lab/equivalence.mjs`, `lab/defer.mjs` and the deep entry's harnesses.
- A demo page in `demo/`, published by `pages.yml` once the repository is public.

### Fixed

- A page that replaced a built-in such as `Array.prototype.sort` after the script started could put an error on the page and stop the callback.
- A page that broke both clocks or both schedulers could make the library throw or finish a reading early.
- With `clearTimeout` broken after start, the private-window check left an unhandled rejection and `get()` waited 30 seconds.
- The user-agent parser threw, or gave a wrong model or engine version, on a page that broke `parseInt` or `Math.min`.
- A client-hint brand list with an infinite `length` could hold the page.
- With `String.prototype.slice` broken before start, the stored id was overwritten with `----`; a valid new id is written now.

### Removed

- `CREDITS.md`, `third_party/licenses/` and the credit comments are gone, because no code from another project is left: what 0.1.0 had adapted was written again from specifications, vendor documentation and our own measurements (`docs/DECISIONS.md`).

### Internal and CI

- Building and testing need Node 24; installing the package does not.
- CI runs the unit tests on Windows too, skips browser jobs for documentation-only changes, and reports one `CI result` check.
- The old-engines check runs Chrome 53, 59, 63, 68 and 80 on every change that can affect the builds, and on every release, with or without Docker.
- A weekly workflow checks the engine feature tests in the newest stable and pre-release Chrome, Edge, Firefox and WebKit.
- A release runs all of CI on the tagged commit and publishes to npm from a separate approved job that holds no other credential.
- Every workflow action is pinned to a commit, and Dependabot waits seven days before proposing an update.
- A repository variable can send CI to a self-hosted runner.

## [0.1.0] - 2026-11-12

First release.

### Added

- Stored id in a first-party cookie and in localStorage, read at script start.
- `id` (id version 2): phone model, memory size, language and text-size setting; screen size and core count where the browser names no model.
- `idStrict`: the parts of `id` plus OS version, app family, app version and engine version.
- Flags: `partial`, `auto`, `private`, `weak`.
- User-agent parser that separates model, OS and app family from their versions, including the in-app browsers of Facebook, Instagram, Messenger, TikTok, Snapchat and WhatsApp, and the frozen OS token of Safari 26 and newer. Where a user agent hides the model and the OS version, both come from client hints.
- Per-browser exclusions for values a browser randomises: memory and cores in Brave, screen in Safari 17 and newer, screen and cores in Firefox 143 and newer.
- A 24-hour cache of complete readings.
- `visitojs/match`: a matcher for servers that returns `same`, `likely`, `unknown` or `different`.
- Builds: a global script, an ES module, type declarations, and a lab build for test pages.
- Lab harnesses: fault matrix, stability, speed, old engines, a phone test page.
