# Signals

Every value the library reads, where it comes from, and what it is used for. A reading lists the values in `c`, by key. The other reads follow in [Read for flags and storage](#read-for-flags-and-storage): the frame check, the user agent, the storage name, cookie and storage, `location.protocol`, the random source, the clocks, and the inputs to `flags.auto`.

A value is what the browser gave, or one of five statuses:

| Status | Meaning |
|---|---|
| `!na` | The browser does not have this value. A stable answer, hashed like any other |
| `!err` | The read threw. Listed in `flags.partial`; no id is built when an id part has it (see [When a read fails](#when-a-read-fails)) |
| `!to` | The read timed out, or has not run yet. Same rule as `!err` |
| `!ex` | Excluded on purpose: this browser randomises the value |
| `!noise` | A check showed the browser or an extension altered the result, or the browser refused to give it (lab build and the deep entry, canvas and audio only) |

Keys starting with `hw.` and `p.` are the parts of the id. Keys starting with `x.` are inputs and hints. Keys starting with `r.` are rendering values, which only the lab build and the optional deep entry read ([The deep entry](#the-deep-entry)).

## Product build

| Key | Source | Use |
|---|---|---|
| `hw.model` | User agent; an in-app browser's own suffix; client hints when the user agent is reduced. Among the Android tokens, `wv`, `U`, `Mobile`, `Tablet`, `rv:...`, a locale and `HarmonyOS` are skipped, and `K` means the model is hidden | Part of `id` |
| `hw.mem` | `navigator.deviceMemory`, in three buckets: 2, 4, 8 | Part of `id`. Excluded in Brave |
| `p.lang` | `navigator.language` | Part of `id` |
| `p.txt` | Derived from the `x.txt.*` values below | Part of `id` |
| `hw.scr` | `x.scr`, only when there is no model | Part of `id`. Excluded in every WebKit browser at the Safari 17 level or later, Safari or not, in Firefox 143 and newer, and in Brave's desktop builds (Brave that is not an Android build) |
| `hw.cores` | `x.cores`, only when there is no model | Part of `id`. Excluded in Brave and Firefox 143 and newer |
| `x.scr` | `screen.width` and `screen.height` in CSS pixels, the longer first, as `852x393`. Each side goes through `Number()`; a side that is not a finite number above zero gives `!na`. Read only when there is no model | Input to `hw.scr` |
| `x.cores` | `navigator.hardwareConcurrency`. Read only when there is no model | Input to `hw.cores` |
| `x.txt.env` | Computed line height of a hidden node styled `line-height: normal`, then `calc(env(preferred-text-scale, 1) * 100px)`, rounded to two decimals, divided by 100. An engine without `env()` (Chrome before 69, Firefox before 65, Safari before 11.1) drops the second declaration and keeps `normal`, which is no number: `!na`, never the page's own line height | Input to `p.txt` |
| `x.txt.fs` | Computed size of a hidden monospace node with `font-size: 100px`, rounded to two decimals | Input to `p.txt` |
| `x.txt.w` | Width of ten monospace letters at that size, rounded to 0.1 px | Hint |
| `x.txt.apple` | Computed size of `font: -apple-system-body`, rounded to two decimals. Measured on WebKit only, `!na` elsewhere; on WebKit a size that is not a number is `!err` | Input to `p.txt` |
| `x.ch.model`, `x.ch.pv` | Client hints `model` and `platformVersion`. Asked only when the user agent hides the model. No API or a refusal gives `x.ch.model = !na`; no answer in 1000 ms gives `!to` | Input to `hw.model`, and to the reading's `osVer` when the user agent hides that too |
| `x.ch.brands`, `x.ch.mobile` | Client-hint brand names, sorted and joined with commas, and the mobile bit, from the same call. The entry the specification has browsers add on purpose is left out: a brand with one of `( ) - . / : ; = ? _`, or one that reads `NotABrand` once its spaces are removed. An entry that is not an object or has no string brand is skipped. Written, with `x.ch.pv`, only when the call answers | Hints |
| `x.engine`, `x.android` | Feature tests at script start, never `navigator.userAgent`: names on `window`, `navigator` and a few prototypes, looked up with `in`, and `CSS.supports()` conditions; no element is built. An engine needs 3 of its 5 tests; see [Engine detection](#engine-detection). `x.engine` is `blink`, `webkit`, `gecko` or `other` | Choose the exclusions, whether `x.txt.apple` is measured and whether the private-window check runs; `not-android` mark |
| `x.private` | Whether `navigator.storage.getDirectory()` opens or is refused, and the refusal's error name. Asked only on the WebKit and Gecko engines as the feature checks tell them, other WebKit browsers on iOS included; in the product build only when the stored id was created on this view or no storage keeps one, while the lab build asks on every view. No answer in 1000 ms gives `!to`. See [`x.private` and `flags.private`](#xprivate-and-flagsprivate) | `flags.private` |
| `x.id` | Present only as `!err`, when building the ids failed on a page that replaced a built-in they need (`Math`, `String`, `RegExp`, `Object.keys`, sorting), before or after the script started | `flags.partial` |

Three more sets of the same kind of tests, run at the same time, tell WebKit at the Safari 17 level or later, Gecko at the Firefox 143 level or later, and Brave, for the exclusions. Those three answers have no key in `c`; their only trace there is `!ex` in the parts they exclude.

`p.txt` is the first of these that applies:

1. `x.txt.apple`, when it is a number. It is a size in pixels.
2. `x.txt.apple` itself, when it is `!err` or `!to`: no id.
3. `x.txt.env` itself, when it is `!err` or `!to`: no id.
4. `x.txt.env`, when it is a number other than 1.
5. `x.txt.fs` rounded to a whole pixel, divided by 100, when it is a number: 114.6 gives 1.15.
6. Otherwise `!to` when `x.txt.fs` is `!to`, else `!err`: every engine computes a fixed 100px font, so no number there is a failed probe, and no id is built.

`!na` in `x.txt.apple` (every engine but WebKit) or in `x.txt.env` (an engine without `env()`, such as Chrome before 69) is skipped, and the next source decides. A failed read is never skipped. Until id version 3 it was: a failed `x.txt.env` let `x.txt.fs` decide, which in Chrome gives 1 whatever the setting, and the id was built without `flags.partial` saying so.

`flags.partial` names every key in `c` whose value is `!err` or `!to`, sorted. The list is built with language operators only, so it is always complete, and the sort runs inside a `try`, so it never throws. On a page that has broken `Array.prototype.sort` it comes in the order the values were read instead; the ids need sorting too, so such a page also gets `x.id: '!err'` and no id. A reading whose `flags.partial` is not empty is never written to the cache.

### Engine detection

Run once at script start (`src/env.ts`). It reads nothing from `navigator.userAgent`, `appVersion`, `platform`, `vendor` or client hints, builds no element and waits for nothing. Each test is one of two kinds:

- **A dotted path**, such as `ShadowRoot.prototype.getSelection`: every name but the last is read as a property starting from `window`, and the last is looked up with `in`, so its getter never runs.
- **A CSS condition**, such as `(-webkit-app-region:drag)`: passed to `CSS.supports()`, and it counts only when that returns exactly `true` and the same call refuses `(:)`, a declaration without a property, which can never be valid. A replacement that answers true to everything therefore counts for nothing, as if `CSS.supports` were broken.

A leading `!` negates a test. Each test runs in its own `try`, and an exception counts as not passing.

| Set | Tests | Rule |
|---|---|---|
| Blink | `InputDeviceCapabilities`, `BeforeInstallPromptEvent`, `performance.memory`, `ShadowRoot.prototype.getSelection`, `(-webkit-app-region:drag)` | An engine whose set passes 3 or more of its 5 tests is chosen. `x.engine` is that engine when exactly one is chosen, else `other` |
| WebKit | `GestureEvent`, `HTMLMediaElement.prototype.getStartDate`, `SVGFEGaussianBlurElement.prototype.edgeMode`, `(-webkit-nbsp-mode:space)`, `(-webkit-hyphenate-limit-after:auto)` | |
| Gecko | `scrollMaxX`, `Event.prototype.explicitOriginalTarget`, `getDefaultComputedStyle`, `HTMLCanvasElement.prototype.mozPrintCallback`, `TimeEvent` | |
| Android, mobile | `onorientationchange`, `HTMLInputElement.prototype.capture` | Blink and Gecko only; false for WebKit and `other`. `x.android` is true when both pass, or when one passes and the build is not a desktop one |
| Android, desktop | `navigator.registerProtocolHandler`, `HTMLMediaElement.prototype.setSinkId`, and `isSecureContext` being `false` | A desktop build has `setSinkId`, which Android lacks, together with `registerProtocolHandler` or on an insecure page, where that one is withheld |
| Safari 17 | `RegExp.prototype.unicodeSets`, `CSSContainerRule.prototype.containerName`, `(contain-intrinsic-size:1px)`, `(hyphens:auto)`, `URL.canParse` | WebKit and 3 of 5: the screen is excluded. This is every WebKit browser at that level, not Safari alone: on iOS and iPadOS 17 and later Chrome, Firefox, Edge and in-app browsers too, and on macOS the other browsers built on WebKit and apps' embedded web views |
| Firefox 143 | `selector(::details-content)`, `selector(::before::marker)`, `!CompositionEvent.prototype.locale` | Gecko and 2 of 3: screen and cores are excluded |
| Brave | `navigator.brave.isBrave` | Present, in any engine: memory and cores are excluded, and the screen too where the build is not Android. Reading `navigator.brave` runs that getter once; `isBrave` is never called |

No engine set and no version set has more than two tests behind one object or function, counting `CSS.supports` as one. So a page that deletes or replaces one of them, `window.CSS` and `CSS.supports` included, changes no engine and keeps the Safari 17 answer. A `CSS.supports` that answers true to everything raises no version: Firefox before 143 stays below 143, and Safari 16 with a `URL.canParse` polyfill below 17. Two outcomes do change, and both are asserted by the unit tests and the fault matrix:

- **Firefox 143 and later, on a page that breaks `CSS.supports` or replaces it with one that answers true to everything, is treated as an older Firefox on that page**: two of its three tests are CSS conditions and Firefox 143 shipped nothing else a script can test by existence, so the screen and cores stay in the id there.
- **A page that breaks `navigator` loses Brave**: Brave's own API is the only evidence of Brave there is, so memory, cores and, on desktop, the screen stay in the id there.

A page that defines a global named `onorientationchange` makes desktop Firefox on an http: page report `x.android` true, because Firefox withholds both desktop features there. No mark reads `x.android` in Gecko.

When the whole function fails (a page that replaced `String.prototype.split`), the answer is `other` with nothing excluded. That holds too when the replacement returns an object or an empty list instead of throwing: a dotted test whose last name is not a string counts as not passing, so nothing is looked up under the name `undefined`, which every window has.

### `x.private` and `flags.private`

`flags.private` true means this session's storage is not kept: a private window, or an app's in-memory web view. The page cannot tell those two apart, and for a site they mean the same thing: the stored id will not outlive the session. False means the browser showed that storage is kept. Null means unknown. It is a hint for analytics, not a security control: a page script can replace the API it reads.

What is read, in this order (`src/private.ts`):

1. The engine, from feature detection. Only WebKit and Gecko are checked; in every other engine nothing is read and the flag stays null.
2. `localStorage.length`, a read. If it throws or `localStorage` is null, the user has blocked storage for the site, which makes the file system refuse too (in Gecko with the same name a private window gets); the answer is `!na` and the file system is not asked. In the private sessions measured (WebKit 26.6's ephemeral context, Firefox 155 private browsing) `localStorage` is readable, so the guard costs no true answer there.
3. `navigator.storage` and its `getDirectory`. If either is missing the answer is `!na`. Browsers expose `navigator.storage` only on secure pages, so an `http:` page stops here.
4. One call to `navigator.storage.getDirectory()`, with a 1,000 ms limit (`!to`). The returned directory is not used: nothing is created in it, read from it or removed. A synchronous throw, a value that is not a promise, or a refusal whose name cannot be read gives `!err`.

| Engine | Outcome | `x.private` |
|---|---|---|
| WebKit | Opens | `false` |
| WebKit | Refused, name `UnknownError` | `true` |
| Gecko | Refused, name `SecurityError` | `true` |
| Gecko | Opens | `!na`: Mozilla is bringing the file system to private windows, after which an open one proves nothing |
| Either | Refused with any other name | `!na` |
| Either | `localStorage` throws or is null | `!na`, before the file system is asked |

Only the error's `name` is read, never its message. The check writes nothing to cookies or storage itself, and it never calls `navigator.storage.persist()`, so no prompt can appear.

Whether `getDirectory()` leaves anything on disk in Safari is not established. In the lab (see `DECISIONS.md`), Firefox 155 created a file-system metadata database for the origin on the first call in a normal window, and `navigator.storage.estimate()` usage rose from 0 to 491,520 bytes; the Windows build of WebKit 26.6 showed no new file in its profile and no change in usage. Chromium creates file-system files too, but the check never runs there.

## Read for flags and storage

These are read on every view, a view served from the cache included, each where its use applies: sessionStorage only when localStorage is unavailable, the random source only for a new stored id. None of them has a key of its own in `c`, but several decide what it holds; each row's Use says how. In the deferred build none of them, and nothing else in this document, is read before the page calls `start()`; "script start" is then the call to `start()`.

| Read | Use |
|---|---|
| `window.top` against `window.self` | In any frame, or when the comparison throws, `getSync()` returns null, `get()` calls back with null, and nothing else is read or stored. The same holds where `Object.keys` or `Date.now` is missing |
| `navigator.userAgent` | `model`, `os`, `osVer`, `app`, `appVer`, `engineVer`; `hw.model`, and whether the client hints are asked for it; the cache's user-agent hash; the OS that the `platform`, `no-touch` and `not-android` marks check, and the `headless` mark |
| `window.VisitoConfig.did` | Storage name, when it matches `^[A-Za-z0-9_-]{1,32}$`. The deferred build reads it at `start()`, so a page can set it at any point before |
| `document.cookie`, `localStorage`, `sessionStorage` | The stored id and the cache (see [What is stored in the browser](#what-is-stored-in-the-browser)). In the product build, a stored id that was already there means no private-window check, so no `x.private` in `c`. On a view served from the cache, `x.txt.*` and, with a reduced user agent, `x.ch.*` come from it. With the deferred build's `start({ store: false })` none of the three is read or written, the private-window check is never asked (so `x.private` is never in `c` and `flags.private` is null), and no view is served from the cache |
| `location.protocol` | `Secure` on the cookie. Read with `store: false` too, though no cookie is written |
| `crypto.getRandomValues` (`msCrypto.getRandomValues` where `window.crypto` is missing); `Math.random` when that fails | A new stored id. With `store: false` the id is made once and dropped, since nothing can keep it |
| `performance.now()`, `Date.now()` | `ms`, `t`; the cache's save time and age, which decide whether a view is served from it; the running budget: once the reads after script start have kept the page busy for 4,000 ms in all, each read not yet started is recorded as `!to`. In the lab build the batch of property and media reads (`x.scr`, `x.cores`, `x.tzo`, `x.langs` to `x.mem`, and the media queries) records nothing when it is skipped this way: the keys only it reads are missing from `c` and from `flags.partial`, not `!to`. The text read always runs first; with a reduced user agent, a client-hint call skipped this way leaves `hw.model` at `!to` and no id |

`flags.auto` comes from the reads in the table below. A read that throws gives no mark. Marks are never hashed and never cached.

| Mark | Read |
|---|---|
| `webdriver` | `navigator.webdriver` is `true` |
| `global` | One of these names is on `window`: `callPhantom`, `_phantom` (PhantomJS), `__nightmare` (Nightmare), `_Selenium_IDE_Recorder` (Selenium IDE), `__webdriver_evaluate`, `__webdriver_script_fn` (Selenium's Firefox and Internet Explorer drivers), `domAutomationController` (Chromium with `--dom-automation`), `$chrome_asyncScriptInfo` (ChromeDriver to 126). Their tools set `__webdriver_evaluate`, `__webdriver_script_fn` and `$chrome_asyncScriptInfo` on `document`, where this check does not look; `docs/DECISIONS.md` has the source of each |
| `no-languages` | `navigator.languages` is an empty array |
| `headless` | `navigator.userAgent` contains HeadlessChrome, PhantomJS or SlimerJS, in any case |
| `platform` | `navigator.platform` is a non-empty string that does not fit the OS parsed from the user agent: Android needs `Linux`, `Android`, `arm` or `aarch`; iOS needs `iPhone`, `iPad`, `iPod` or `MacIntel`; Windows `Win`; macOS `Mac`. Other systems never mark |
| `no-touch` | The parsed OS is Android or iOS and `navigator.maxTouchPoints` is 0 |
| `no-brands` | `navigator.userAgentData.brands` is an empty array. No mark where the API is missing |
| `not-android` | The parsed OS is Android, `x.engine` is `blink` and `x.android` is false |

## Lab build only

These are candidates that no id uses. The lab build reads them so that a test page can keep collecting evidence. It also reads, on every view while the running budget lasts, `x.scr` and `x.cores` whether or not there is a model, the client hints, and on WebKit and Gecko the private-window check. It never reads or writes the cache. The product build does not contain the code.

`x.langs`, `x.touch` and `x.plat` exist only in the lab build's `c`. The product build reads the same properties for `flags.auto` and keeps only the marks.

| Key | Source |
|---|---|
| `x.langs` | `navigator.languages`, joined with commas |
| `x.tzo` | `new Date().getTimezoneOffset()`, in minutes |
| `x.touch` | `navigator.maxTouchPoints`, 0 or more |
| `x.dpr` | `devicePixelRatio`, rounded to two decimals |
| `x.avail` | `screen.availWidth` and `screen.availHeight`, by the rule of `x.scr` |
| `x.depth` | `screen.colorDepth` |
| `x.plat` | `navigator.platform` |
| `x.cookie` | `navigator.cookieEnabled` |
| `x.mem` | `navigator.deviceMemory`, as reported |
| `x.gamut`, `x.hdr`, `x.contrast`, `x.forced`, `x.inverted`, `x.motion`, `x.transp`, `x.scheme` | Media queries: each tries a fixed list of values in order (`MEDIA` in `src/reads.ts`) and takes the first that matches, else its default. The default also where `matchMedia` is missing |
| `x.tz`, `x.loc`, `x.cal`, `x.num`, `x.hc` | `Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()`: `timeZone`, `locale`, `calendar`, `numberingSystem`, `hourCycle`. The `hour` option puts `hourCycle` in the answer |
| `x.ev.blink`, `x.ev.webkit`, `x.ev.gecko`, `x.ev.android`, `x.ev.safari17`, `x.ev.firefox143`, `x.ev.brave` | The result of every engine-detection test, in the order of the table above, as `1` (passes) and `0`. `x.ev.android` is the two mobile tests, then `registerProtocolHandler` and `setSinkId`, then `1` on an insecure page. A current browser should read `11111` for its own engine and `00000` for the other two; a count slipping to 4 shows a feature drifting before it can change an answer. These are read in the lab stage, after load, while `x.engine` and `x.android` are decided at script start: a page script that adds or removes a tested name in between makes the two disagree in one reading |
| `x.bot.<mark>` | Ten automation mark candidates, none of which ships: `true`, `false` or `!na`. See [Automation hints](#automation-hints-lab-build-only-xbot) |
| `r.math` | Digest of the results of a fixed list of 28 `Math` calls |
| `r.cg` | Digest of the pixels of a canvas drawing with no text, after the noise checks |
| `r.ct` | Digest of the pixels of a canvas drawing of text in the generic font families, after the same checks |
| `r.cchk` | Which canvas check decided: `ok`, `pattern`, `geometry-patch`, `text-patch`, `geometry`, `text` or `blocked` |
| `r.cgcpu` | The `r.cg` drawing again, on a canvas created with `willReadFrequently: true` |
| `r.ctcpu` | The `r.ct` drawing again, on a canvas created with `willReadFrequently: true` |
| `r.audio` | Digest of the exact samples of a short offline audio render, after a known-answer check |
| `r.achk` | Which audio check decided: `ok`, `pattern`, `copy`, `silent` or `nan` |
| `r.arms` | Root mean square of the samples behind `r.audio`, to 9 significant digits |

The rendering reads are described exactly below.

## Rendering reads, exactly

The three reads are in `src/render.ts`. Each one stands alone (no dependence on the lab stage), never throws, and attaches nothing to the page. Every value is 16 hex digits from the library's 64-bit digest (`short()` in `src/hash.ts`), or a status. Each read always gives the check that decided it, `r.cchk` for the canvas and `r.achk` for audio. The lab build calls them with diagnostics on, which adds `r.cgcpu`, `r.ctcpu` and `r.arms`. None of these five is part of any id.

### `r.math`

These 28 calls, in this order, each in its own `try`: `cos(π/2)`, `sin(π)`, `tan(1.5707963267948966)`, `sin(8.9e307)`, `cos(-7.5e17)`, `tan(3e8)`, `exp(1)`, `exp(-708.3)`, `expm1(1e-10)`, `log1p(1e-10)`, `log(7)`, `log10(7)`, `log2(10)`, `pow(1.0000001, 1e8)`, `pow(0.93, 7777.7)`, `sinh(0.0042)`, `cosh(10)`, `tanh(0.5)`, `asinh(0.5)`, `acosh(1e10)`, `atanh(0.97)`, `cbrt(3)`, `atan2(0.5, -0.7)`, `atan(2.5)`, `asin(0.3)`, `acos(0.3)`, `hypot(1, 1e-9)`, `hypot(3e-200, 4e-200)`. π and π/2 are written as literals, not read from `Math.PI`. Each numeric result is written with `String()`; a missing function is `!na` in its slot, and one that throws or returns something other than a number is `!err`. The slots are joined with commas and the digest is taken of `r.math:` plus that text. When no slot holds a number, the value is `!na` if every function was missing and `!err` otherwise, so a page that replaced `Math` does not produce something that looks like a value. If the digest itself fails, the value is `!err`.

### `r.cg` and `r.ct`

No canvas is read more than once. Chromium with a GPU draws text differently on a canvas after that canvas has been read back once (measured, `docs/DECISIONS.md`), so a second read of one canvas cannot tell noise from that change. Each scene is drawn on two canvases instead, and each canvas is read once.

Every read carries known cells, checked in the bytes of that same read before anything is hashed. A cell is one opaque pixel at whole coordinates, drawn with `fillRect`, and every channel lies between 20 and 237, with `L(n) = 20 + 7 · (n mod 32)`. Pattern cell (x, y) is `rgb(L(5x + 1), L(5y + 2), L(3x + 7y + 5))`: 256 colours, one per pixel, each at least 35 from every neighbour in red or green. Strip cell (x, y) of drawing d (0 or 1) takes colour `(x + 4y + 8d) mod 16` of 16 others, colour c being `rgb(L(5k + 11), L(11k + 3), L(29k + 21))` with `k = 16 + c`: each at least 28 from every neighbour in some channel. The pattern and the strips share no colour, and the two strips of a scene differ at every cell.

1. A 16 by 16 canvas is filled with the pattern's 256 cells and read back with `getImageData`. A protection that spares canvases of few colours cannot spare it, since it holds as many colours as it has pixels. Any byte that differs from those colours at full opacity: both keys are `!noise`, `r.cchk` is `pattern`.
2. Each scene canvas is its scene plus a strip of two rows above it: 200 by 62 for the geometry, 236 by 70 for the text. The scene is drawn moved down two rows (`translate(0, 2)` between `save` and `restore`), then the strip of that drawing is filled in, with the context back in its initial state, then the canvas is read once. The first drawing of a scene takes strip 0, the second strip 1. If the strip did not come back exactly as drawn, both keys are `!noise` and `r.cchk` is `geometry-patch` or `text-patch`; this is checked before the two drawings of a scene are compared.
3. The geometry scene, 200 by 60, in this order: a five-stop linear gradient across the canvas; a circle filled with a radial gradient from opaque to 0.2 alpha around a non-integer centre; two arcs and a cubic Bezier curve stroked 2.5 wide with round joins and caps; a self-intersecting five-pointed star at `globalAlpha` 0.6; a rounded rectangle built from `arc` and `lineTo` with a coloured shadow, `shadowBlur` 6 and `shadowOffsetX` 3; a thin rectangle rotated 0.37 radians and scaled 1.3 by 0.7; a translucent triangle and a translucent quadrilateral overlapping it in `soft-light` mode, drawn only when the context accepts that mode; a 4 by 4 four-colour canvas scaled to 29 by 29 at a non-integer position with smoothing on; a diagonal dashed line, dash `[5, 2.5]`, offset 1.25. No text. The scene is drawn again on a second canvas; the two are read once each and must be equal byte for byte below their strips, else `!noise` with `r.cchk` `geometry`. Because the strips differ, an alteration whose choice of pixels follows from a canvas's whole contents lands on different pixels in the two drawings, and they no longer match.
4. The text scene, 236 by 68, with `textBaseline` `top`: `Hamburgefonstiv 0123 fi ffl AV To.` in `15.5px serif` at (4.2, 3.3); `Ty Wo Pa LT 47/89 (Qj) 1,056.3%` in `13px sans-serif`, filled with a two-colour linear gradient and rotated 0.05 radians about (4.6, 22.4); a line in `14px sans-serif` at (4.1, 48.7) of `e` with a combining acute accent, a precomposed `é`, Greek `Ωμέγα`, Arabic `مرحبا` and `∑√∞`; `Wq@&%` stroked in `18px monospace`, line width 0.6, at (150.4, 46.5). Generic families only, no emoji, no Han, Kana, Hangul or Cyrillic. Every canvas the read creates gets the content attribute `lang="en"`, set with `setAttribute` and read back with `getAttribute`, before its context is made: a detached canvas has no language of its own, and Chromium then picks the fallback for the Greek, Arabic and symbol glyphs from its interface language. Headless, that moved `r.ct` between interface languages, and the attribute pins it (measured in Chromium 153 and in Chrome and Edge 157 only, `docs/DECISIONS.md`; whether it pins it in Chrome before 157 is not measured). In a headed Chromium 153 it does not: Japanese, Chinese (simplified), Korean and Thai each give `r.ct` a value of its own, the same with and without the attribute, while German, French, Russian, Arabic, Persian and Hindi give the English one. The `lang` property is never used, so a page that replaced it changes nothing. If the attribute does not read back as `en`, the canvas read is `!err` (`r.cchk` `!err`): the text would be drawn in a language the page chose. The strings are built from character codes, so the bundle is ASCII and the page's encoding cannot change them. The scene is drawn again on a second canvas; the two must be equal below their strips, else `!noise` with `r.cchk` `text`.
5. `r.cg` is the digest of `r.cg:200x60:` plus the pixels of the first geometry canvas below its strip (the 200 by 60 scene), one character per byte; `r.ct` the same with `r.ct:236x68:` and the 236 by 68 text scene. The strip is checked, not hashed.
6. With diagnostics, `r.cgcpu` and `r.ctcpu` draw steps 3 and 4 once more each, each with strip 0, on canvases created with `{ willReadFrequently: true }`, after the checks have passed, with the prefixes `r.cgcpu:200x60:` and `r.ctcpu:236x68:`. A strip that comes back altered there makes only that key `!noise`; `r.cg`, `r.ct` and `r.cchk` stand.

Every canvas is set to 0 by 0 after it has been read, which frees its bitmap. No document or a throwing `createElement`: `!err`. No 2D context: `!na`. A `SecurityError` from `getImageData` on our own canvas, which only a browser that refuses readback throws: `!noise`, `r.cchk` `blocked`. Any other exception: `!err`. The two keys always share one status.

What the checks cannot see: an alteration that changes neither the pattern nor any cell of a strip, only scene pixels, and gives both drawings of a scene the same change. The two drawings then match, and the altered value is reported as a value. These shapes are of that kind: one that alters only pixels with a neighbour of nearly the same colour (flat and smoothly shaded areas), since no known cell has such a neighbour; one keyed by position that spares the pattern and the top two rows of every read; one keyed by colour that leaves every cell colour alone; one whose choice of pixels ignores the top two rows, so the differing strips do not move it; and one that recognises and reproduces the known cells. `docs/DECISIONS.md` lists them with what was measured. Colour-keyed noise as WebKit's source implements it (an offset chosen from the colour, none on a pixel whose neighbours share its colour) reaches every cell, since no cell looks like its neighbours, and passes only if every cell colour draws a zero offset; that is from the source and an emulation in the fault matrix, not from Safari. The audio read has the equivalent limit, named below.

Under Firefox's `privacy.resistFingerprinting` (on by default in some Firefox-based browsers), reading a canvas outside a user-input handler gets placeholder data, which the pattern check reports as `!noise`, Firefox writes "Blocked ... from extracting canvas data because no user input was detected" to the console, and its source (`dom/canvas/CanvasUtils.cpp`) still raises the canvas permission prompt with the doorhanger hidden, which leaves an icon in the address bar. The canvas read stops at the pattern, so this happens once per page view of the lab build.

The read is also available as a sequence of steps (`canvasSteps()`): the pattern, the two geometry drawings, one step per text row that only measures that row's string in its font with `measureText` (a font's first use in a page is the slow part of the text scene; the measurement itself is not used), the two text drawings, the two digests, and with diagnostics each extra drawing and its digest: fifteen steps in all. The lab stage runs each step as a task of its own, so the page gets a turn between any two, and records each step's time in `t` as `canvas:<step>`.

### `r.audio`

An `OfflineAudioContext` (or `webkitOfflineAudioContext`) of 2 channels, 5,120 frames, 44,100 Hz, built with factory methods only. Channel 0: a sawtooth oscillator at 6,000 Hz detuned 7 cents, a wave shaper with a 257-point curve `x(1.95 - 1.365x²)` for x from -1 to 1 (peak about 0.9, computed with multiplications only) and `4x` oversampling, a peaking biquad at 3,100 Hz, Q 2.2, gain 9 dB, a compressor (threshold -38, knee 24, ratio 9, attack 0.002, release 0.2) and a gain of 0.8 whose `channelCount` is 1 and `channelCountMode` `explicit`, so one channel reaches the merger in every engine (`docs/DECISIONS.md` has the older WebKit merger this is for). Channel 1: a buffer of 256 known values played once from time 0. Value k (from 0) is `m · 2^-(23 + e)` with `e = 1 + floor(126k / 256)` and the odd significand `m = 8388609 + 2 · (40503k mod 4194304)`, negative for even k. Every binary exponent from 2^-1 to 2^-126 is used, each value is exact in single precision with its lowest significand bit set, and none is subnormal. Both channels meet in a two-input channel merger.

The time limit starts at the call (1,000 ms by default; the third argument changes it). The render settles once, on the `complete` event or the promise, whichever comes first, or at the time limit. Then, in this order: channel 1 must equal the known values in frames 0 to 255 and zero after (else `!noise`, `pattern`); channel 0 must hold no NaN or infinity (else `!err`, `nan`) and must not be all zero (else `!err`, `silent`); `copyFromChannel`, where it exists, must give the same samples as `getChannelData` (else `!noise`, `copy`). The value is the digest of `r.audio:5120@44100:` plus the 20,480 bytes of channel 0's single-precision samples in little-endian order, so a server can recompute it from the numbers. `r.arms` is the square root of the mean of the squared samples, to 9 significant digits, or `!err` if that calculation fails. No context: `!na`. Construction, graph or start throws, or the promise rejects: `!err`. No answer in time: `!to`. There is no retry.

## Automation hints, lab build only (`x.bot.*`)

Automation mark candidates beyond the core's eight `flags.auto` marks. Only the lab build reads them (`src/marks.ts`, `src/botlab.ts`, imported by `src/labstage.ts` alone); the product and deferred builds contain none of them, and none ships in 1.0 (`docs/DECISIONS.md`, "Automation marks: none added in 1.0"). They are hints for collecting evidence: never hashed, never in an id, never in `flags.auto`, and with no gate by browser or version. The lab stage records each after load as `x.bot.<mark>`: `true`, `false`, or `!na` when it could not be looked for (a missing or throwing read, or nothing to look at). `!na` here is not a failed read, so it does not enter `flags.partial`; only a lab stage that never ran gives `!to` there. No candidate writes to the reading or to any element, stores, sends, sets a timer or calls a getter it found.

`own-value`, `frame-window`, `frame-srcdoc`, `plain-getter` and `runtime-constructible` first check that `Object.getOwnPropertyDescriptor` answers as the language defines it (a descriptor with `value` 1 for an own data property, `undefined` for a missing one); a replaced function that passes is used, one that does not gives `!na`. `plugins-type` checks `Object.getPrototypeOf` the same way.

| Key | Reads | `true` when |
|---|---|---|
| `x.bot.own-value` | `Object.getOwnPropertyDescriptor(navigator, name)` for `language languages webdriver hardwareConcurrency deviceMemory maxTouchPoints vendor`, and `(screen, name)` for `width height availWidth availHeight colorDepth` | Any of them is defined on the instance. Not looked at: `userAgent`, `appVersion`, `platform`, `plugins` and `mimeTypes` |
| `x.bot.frame-window` | `document.createElement('iframe')`, then `'contentWindow' in` it, `contentWindow`, and `Object.getOwnPropertyDescriptor(frame, 'contentWindow')`. The element is never inserted and nothing is written to it | `contentWindow` is not null, or the element carries its own `contentWindow`. No `contentWindow`: `!na` |
| `x.bot.frame-srcdoc` | A second fresh `iframe`, `'srcdoc' in` it, and `Object.getOwnPropertyDescriptor(frame, 'srcdoc')`. The attribute itself is never read or written, so no Trusted Types sink is reached | The element carries its own `srcdoc`. No `srcdoc`: `!na` |
| `x.bot.no-webdriver` | `CSS.supports('(accent-color:red)')` and `CSS.supports('(:)')`, then `'webdriver' in navigator` | Accent colour is accepted (Chrome 93 and later, which always define `webdriver`), the never-valid condition is refused, and `navigator` has no `webdriver`. Otherwise `!na` |
| `x.bot.app-version` | `navigator.userAgent`, `navigator.appVersion` | The user agent starts `Mozilla/5.0 (` and `'Mozilla/' + appVersion` is not the user agent. Another start, or a value that is not a string: `!na` |
| `x.bot.plain-getter` | `Object.getOwnPropertyDescriptor(Navigator.prototype, name)` for `userAgent appVersion platform language languages webdriver hardwareConcurrency deviceMemory maxTouchPoints plugins vendor`, `(Screen.prototype, name)` for the five screen names, and for an accessor `Object.getOwnPropertyDescriptor(get, 'prototype')` | Any of them is a data property, or its getter has an own `prototype` |
| `x.bot.plugins-type` | `window.PluginArray`, `navigator.plugins`, `Object.getPrototypeOf` of the list and of its entry 0, `list.length`, `window.Plugin` | The list is not a `PluginArray`, or its entry 0 is not a `Plugin`. An empty list: `false`. No `PluginArray` constructor: `!na` |
| `x.bot.ua-version` | The `Chrome/<major>` token of `navigator.userAgent`, and `CSS.supports` for `(aspect-ratio:1)` 88, `selector(:has(a))` 105, `(text-wrap:balance)` 114, `(field-sizing:content)` 123, `(interpolate-size:allow-keywords)` 129, `(text-box:normal)` 133, `(reading-flow:normal)` 137, `(scroll-target-group:auto)` 140 (Chrome versions from MDN's compatibility data) | A condition from more than two versions after the claimed major is accepted, or one from more than two versions before it is refused. No `Chrome/` token, or `(:)` accepted: `!na` |
| `x.bot.no-platform-hint` | `navigator.userAgentData.platform` | It is the empty string. No `userAgentData`: `!na` |
| `x.bot.runtime-constructible` | `window.chrome.runtime.sendMessage`, and its own `prototype` descriptor | `sendMessage` is a function with an own `prototype`. No `sendMessage` function: `!na` |

`lab/marks.mjs` counts these in browsers started without a driver, with test extensions, and driven, and `verdict()` in `lab/mark-truth.mjs` says whether one could ship; `CONTRIBUTING.md` has the rule.

## The deep entry

`visitojs/deep` (`dist/deep.min.js`, global `VisitoDeep`) is an optional, experimental entry that returns an id of its own from the geometry scene and the audio read above. It does not draw, measure or hash the text scene, and gives no canvas a language: the text value split one machine (`docs/DECISIONS.md`, "The text scene leaves the deep id"). It is separate from the core build: it never reads or changes `id`, `idStrict` or the core reading, stores nothing and sends nothing. It reads only when `get(callback)` is called, after `load` (or 3 s after the call when `load` never fires), at an idle moment (an idle callback with a 2 s timeout, capped at 2.5 s, or a 200 ms timer where there is none) and while the page is visible. The canvas read runs in four steps, one task each: the pattern, the two geometry drawings and the geometry digest, as in steps 1 to 3 and 5 above, the canvases without a `lang` attribute; then the audio read; the steps share a page-busy budget of 1,000 ms, after which the rest are `!to`, the audio render has its own limit of 1,000 ms, and a watchdog answers 30 s after the first call. The answer and the watchdog both go through the page's own `setTimeout` (the answer falls back to a `MessageChannel` message): a page where both of those throw can be answered before `get` returns, and a page whose `setTimeout` silently drops what it is given may never be answered. A page that stays hidden for 30 s after the call gets every part `!to`, with nothing in the reading to say it was hidden. Diagnostics are off: no `r.cgcpu`, `r.ctcpu` or `r.arms`.

| Key | What it is |
|---|---|
| `r.cg` | The geometry scene, exactly as above, or a status |
| `r.ct` | Always `!ex`: the text scene is not read. It stays in the reading and in the hashed text so that version 1 ids keep their recipe |
| `r.audio` | The offline render, exactly as above, or a status |
| `r.cchk` | Hint, never hashed: the canvas check that decided, `ok`, `pattern`, `geometry-patch`, `geometry` or `blocked`, or the status of a read that reached none |
| `r.achk` | Hint, never hashed: the audio check that decided, `ok`, `pattern`, `copy`, `silent` or `nan`, or a status |
| `x.rule` | Hint, never hashed: the rule that left parts out, `''` when it left out none |
| `x.id` | Present only as `!err`, when a hash failed or failed its known-answer test (see below) |

The rule comes from the engine detection above, features only, never the user agent; the first one that matches wins:

| `x.rule` | When | What is read |
|---|---|---|
| `other` | The engine is unknown or the window was tampered with (two engines at once, a broken `String.prototype.split`) | Nothing |
| `webkit` | Any WebKit, so every iOS browser too | Nothing |
| `android` | An Android build of Blink or Gecko | Nothing |
| `brave` | `navigator.brave.isBrave` exists | Nothing |
| `''` | Blink and Gecko desktop: Chrome, Edge, Opera, Vivaldi, Firefox | `r.cg` and `r.audio` |

Under the first four rules every part and both checks are `!ex`, and no canvas or audio context is created. Under `''` the canvas check rests on the pattern, the geometry strips and the two geometry drawings, and a fired canvas check makes `r.cg` `!noise`. Until 13 November 2026 a `gecko` rule left `r.ct` out in Firefox alone; it is gone, since no engine reads the text now. `r.math` is not read. The reasons for each rule are in `docs/DECISIONS.md`, "The deep entry".

`flags.partial` lists the parts that are `!err` or `!to`, `flags.noise` those that are `!noise`, `flags.excluded` those that are `!ex`, each in the order `r.audio`, `r.cg`; `r.ct` is never listed. `flags.weak` is true when an id was built and `r.audio` or `r.cg` is `!ex` or `!na`.

### How the deep id is computed

1. The id is built only when `flags.partial` and `flags.noise` are empty and at least one part holds a value (16 hex digits). Otherwise it is null: a part that failed or showed noise would give an id that differs from the next clean one, and an id built from statuses alone would be shared by every browser without the APIs.
2. Write the two parts as `key=value` lines in the order `r.audio`, `r.cg` (sorted by key), the value as JavaScript's `String(value)`, then the fixed line `r.ct=!ex`, joined with a line feed.
3. The deep id is the SHA-256, in hex, of `visito-deep:` + the deep version + a line feed + those lines.

For example, with deep version 1 and the values Playwright's Chromium 153 gave on the PC in `docs/DECISIONS.md` with software rendering:

```
visito-deep:1
r.audio=f4a05a170fb56b91
r.cg=854eef72b056a878
r.ct=!ex
```

gives the deep id `d14ff25b48642273be4f7f99c69c4926a33ead44b09715c4d6ab8a326618575b`. A unit test (`test/deepseal.test.mjs`) recomputes this example with `node:crypto`, and the browser harnesses recompute every reading's id the same way, independently of the library's own SHA-256 (`lab/deep-schema.mjs`).

Before hashing, the library checks what made the parts and what makes the id against known answers. The digest the reads use is run, after the reads, over a fixed 4,136-byte clamped array from byte 12 (the canvas path, over two chunks) and then over 5,120 fixed samples written out as bytes (the audio path), the first digest being the second one's prefix; the answer must be `5d644d10f895d8f6`. SHA-256 must give the FIPS 180-4 answer for `abc`, and `short()` its own. A page that replaced what these call so that they answer wrongly without throwing (`String.fromCharCode` returning nothing or appending randomness, `Function.prototype.apply` ignoring its arguments, a truncated `subarray`, a `DataView.setFloat32` that writes nothing, a `charCodeAt` that returns -1) gets every part that held a value `!err`, `x.id` `!err` and no id, rather than one constant id for every machine or a new id on every visit. A page that makes the hash throw instead keeps its values, with `x.id` `!err` and no id. A tamper that answers correctly during the self-test and wrongly during the reads, or the other way round, is not caught. The deep id is never cached or stored; it is computed again on every page view that calls `get`.

`DEEP_VERSION` is independent of the core's id version. It is raised when a scene, the audio graph or a constant changes, when the digest or the set of parts changes, or when the rule table changes its answer for a real browser. Version 1 is the first that ships: the `gecko` rule was added, and the text scene taken out of every engine, before any release. That last change moved Chromium's deep id and left Firefox's as it was, since Firefox already hashed `r.ct=!ex`. It is not raised for hints, scheduling or budgets. Deep ids compare only within one version.

What no check sees is the same as for the geometry scene and the audio read above: the shapes listed under `r.cg`, and for audio an alteration of channel 0 only that `copyFromChannel` returns too. That includes alterations of the drawing calls rather than the readback (`arc`, `fillRect`, a gradient and the like): they never touch the known cells, and when they are the same within a session the pair check passes too, so an extension that shifts a shape once per session gives a new deep id per session. Text drawing and the canvas `lang` attribute cannot reach the deep id: the entry calls neither. Such alterations are reported as values with the check `ok`, and give a deep id. On a server, the same stored id seen with different deep ids under one `v` means the deep id is not stable for that browser.

## How an id is computed

1. Take the parts: every key in `c` that starts with `hw.` or `p.`.
2. Write them as `key=value` lines, sorted by key, joined with a line feed. The value is JavaScript's `String(value)`: `8`, `1.15`, `true`. A carriage return or line feed inside a value becomes a space. A server in another language has to write numbers the same way.
3. `id` is the SHA-256, in hex, of `visito:` + the id version + a line feed + those lines.

For example, with id version 3:

```
visito:3
hw.mem=8
hw.model=Pixel 10
p.lang=en-US
p.txt=1.15
```

`idStrict` is computed the same way after adding four lines: `v.app`, `v.appVer`, `v.engine` and `v.os`, taken from the reading's `app`, `appVer`, `engineVer` and `osVer`, with `!na` for a missing one.

A reading's `c` already holds the final parts, with `!ex` where one was excluded, so a server recomputes an id with these three steps and nothing else. The rule that fills the parts in is `seal()` in `src/reading.ts`.

## When a read fails

- `flags.partial` lists every key in `c` that is `!err` or `!to`, whatever its prefix.
- `id` and `idStrict` are null when an `hw.` or `p.` part is `!err` or `!to`, or when `x.id` is `!err`.
- An `x.` key that is `!err` or `!to` does not stop the id by itself. It stops it where it reaches a part: where there is no model, `x.scr` and `x.cores` are copied into `hw.scr` and `hw.cores` unless excluded; with a reduced user agent, a client-hint call that times out or throws leaves `hw.model` at `!to`; a failed `x.txt.fs` makes `p.txt` `!err` or `!to` when neither `x.txt.apple` nor `x.txt.env` decides it.
- A failed `x.txt.apple` becomes `p.txt` itself, so no id is built. A failed `x.txt.env` does too, except on WebKit, where the system text style decides when it is a number and the scale is not looked at, so the id stays. A failed `x.private` or `x.txt.w` leaves both ids in place.
- A reading with any key in `flags.partial` is not cached.

## What is stored in the browser

| Where | Name | Content | Lifetime |
|---|---|---|---|
| Cookie, `Path=/; SameSite=Lax`, `Secure` on https | `_visito`, or the name in `VisitoConfig.did` | The stored id, a random UUID | 400 days |
| localStorage | the same name | The same id | Until cleared |
| localStorage, or sessionStorage when `window.localStorage` is missing or throws when read | the name + `_c` | The cache, product build only: the id version, a 16-character hash of the user agent, the time it was saved, and the values `x.txt.env`, `x.txt.fs`, `x.txt.w`, `x.txt.apple` and, with a reduced user agent, `x.ch.*` | Used for 24 hours from the view that saved it, and kept until a later complete reading replaces it or the browser clears it |

An existing cookie is never rewritten. sessionStorage never holds the stored id.

The deferred build writes these only from `start()` on, under the same names and in the same format, so the product build and the deferred build share both the stored id and the cache. With `start({ store: false })` it writes none of them and reads none of them.

Neither build writes to the console. Firefox can, in private browsing, where its fingerprinting protection is on by default (`privacy.fingerprintingProtection.pbmode`) and pages see only base-system and language-pack fonts: when layout looks up an installed font outside those, it warns "Request for font "…" blocked at visibility level 2 (requires 3)". On Linux, fontconfig lists such fonts for the generic families, so the warning comes for the default font, attributed to `about:blank`, and for the text-size read's `monospace` node, attributed to the library's file. `lab/defer.mjs` checks that the same nodes as plain markup, with no library, are warned about the same fonts. Normal windows see all installed fonts and get no warning (`toolkit/components/resistfingerprinting/FontVisibilityProvider.cpp` and `FindGenericFamilies` in `gfx/thebes/gfxFcPlatformFontList.cpp`, searchfox.org/firefox-main, read 13 November 2026).

A view uses the cache when its id version is this build's, its user-agent hash is this browser's, it was saved in the last 24 hours, and every value in it is a string, a number or a boolean. That view skips the text-size, client-hint and private-window reads, builds both ids at script start, and does not rewrite the cache. The stored id, `hw.mem`, `p.lang`, the user agent and the marks are read again on every view, and `x.scr` and `x.cores` too where there is no model. `x.private` is never cached, so `flags.private` is null on a cached view.
