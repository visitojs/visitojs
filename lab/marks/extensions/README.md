# Test extensions for `lab/marks.mjs`

Small unpacked extensions that do, in a page, what a category of extension people install does. `lab/marks.mjs` loads each into
Playwright's Chromium builds on clean launches (`--load-extension`; branded Chrome no longer loads unpacked extensions from the
command line) and counts every automation mark with it, on the plain page and behind the innocent patches. A mark that fires with
one of them fires for a person, so it does not ship (R24). Each candidate is read from the lab build (`x.bot.*`); no mark beyond the core ships in 1.0.

Each was written from the Chrome extension documentation (content scripts, `world`, `run_at`, `all_frames`) and from what the
category does as seen from a page. None was copied from, or modelled on the source of, any published extension.

| Folder | Category | What it does in the page |
|---|---|---|
| `ua-switcher` | User-agent switcher | In the page's main world at document start, in all frames: replaces `userAgent`, `appVersion` and `platform` with getters on `Navigator.prototype` and on the `navigator` instance. Its target is set per run: Edge on Windows (inside the gate a mark would ship behind), Chrome on macOS and Firefox on Windows (outside it), each with the `appVersion` and `platform` that browser reports; Edge on Windows with the user agent alone replaced, as simpler switchers do; and Edge on Windows as a full profile, which also replaces `vendor` (`edge-windows-full-profile`) |
| `language-switcher` | Language switcher | Main world, document start, all frames: defines `language` and `languages` as getters on the `navigator` instance, giving the languages the person picked (`de-DE`, `de`, `en-US`, `en`) |
| `hardware-spoofer` | Hardware and screen spoofer | Main world, document start, all frames: defines `hardwareConcurrency` and `deviceMemory` as getters on the `navigator` instance and the screen size, available size and colour depth on the `screen` instance, giving common values |
| `plugin-emulator` | Plug-in emulator (an old plug-in format re-implemented in script) | Main world, document start, all frames: defines `navigator.plugins` and `navigator.mimeTypes` as own data properties holding its own array-like objects (the native entries, then one of its own) and replaces `window.PluginArray` and `window.MimeTypeArray` with its own constructors. Run with the browser's native plug-in list present and with it empty (the "download PDF files" preference) |
| `privacy` | Anti-fingerprinting extension | Main world, document start, all frames: replaces the `hardwareConcurrency` and `deviceMemory` getters on `Navigator.prototype` with ordinary functions that give common values, and wraps the `Screen.prototype` size and colour-depth getters in proxies that return the browser's own values |
| `password-manager` | Password manager | A content script in the isolated world only: watches the document for password fields and marks the root element once it has looked. It changes nothing in the page's main world |

Manifest V3 with `"world": "MAIN"` needs Chrome 111 (MDN compatibility data, `webextensions.manifest.content_scripts.world`).
For older builds the harness writes a Manifest V2 copy whose isolated-world content script inserts the same code as an inline
script element at document start, which runs it in the page's main world.
