# API

The full reference. The [README](../README.md) has the quick start and a summary; this file has every case.

- [`Visito.get(callback)`](#visitogetcallback)
- [`Visito.getSync()`](#visitogetsync)
- [Inside a frame](#inside-a-frame)
- [`Visito.start(options)`](#visitostartoptions)
- [Options](#options)
- [The reading](#the-reading)
- [How the ids behave](#how-the-ids-behave)
- [Automation marks](#automation-marks)
- [What 1.x keeps](#what-1x-keeps)
- [Waiting for consent](#waiting-for-consent)
- [Match visitors on your server](#match-visitors-on-your-server)
- [The deep entry: `visitojs/deep`](#the-deep-entry-visitojsdeep)

## `Visito.get(callback)`

Calls `callback` once for each call, when the reading is done. The reads that need the document start when the page has parsed, or 10 seconds after script start if it is still parsing, and the reading is done when they have answered. On a repeat visit served from the 24-hour cache, and for any call made once the reading is done, it calls back on the next turn. The callback runs from a timer, after `get` has returned.

The work has limits. The reads after script start may keep the page busy for 4 seconds in total: once they have, no further read starts, though one already running is not cut short. A read that waits on the browser gets 1 second to answer. Whatever is still missing 30 seconds after script start is named as timed out, and the callback runs.

The 10-second start, the 1-second wait, the 30-second limit and the callback run on the window's `setTimeout`, and keep its exceptions. A browser may run timers late in a background tab, and then these times stretch: Firefox for Android delays them to at least 15 minutes. Where `setTimeout` is missing or throws, nothing waits: the reads that need the document start at once, those that wait on the browser fail at once, and the callback can run before `get` returns. Where the page has replaced it with a function that never runs what it is given, `get` never calls back.

The callback receives one of three things:

- **`null`** inside a frame, outside a browser, in an engine without `Object.keys` or `Date.now`, or when the reads at script start fail as a whole.
- **A complete reading**, with `flags.partial` empty.
- **A partial reading** when a read or the hash failed, or ran out of time: the 4-second budget, the 1-second wait or the 30-second limit. `flags.partial` names what is missing. When a missing value is part of an id, or the hash failed, `id` and `idStrict` are `null`. The stored id is still there, where the browser keeps one.

`getSync()` and every callback receive the same live object. It keeps changing until the reading is done, and a change you make to it is what later callers see. Copy it before you change it.

## `Visito.getSync()`

Returns the reading as it stands right now, or `null` in the same cases as `get`. The stored id is there from the start. The fingerprint ids arrive when the reading is done, or at script start on a repeat visit served from the cache.

## Inside a frame

In any frame, same-origin or cross-origin, VisitoJS reads nothing from the device and stores nothing: `getSync()` returns `null` and `get` calls back with `null`. A site that needs the ids inside its own frame reads them in the top page and passes them down, for example with `postMessage`, naming the frame's origin as the target instead of `*`.

## `Visito.start(options)`

Only in the deferred build; see [Waiting for consent](#waiting-for-consent). Starts the session once and returns nothing. `options.store` absent or `true` stores as the core build does; `start({ store: false })` reads the device but no cookie and no storage. Later calls are ignored, whatever their options. Never throws.

## Options

Set them before the script loads, or, with the deferred build, at any point before `start()`:

```html
<script>window.VisitoConfig = { did: 'my_visitor_id' }</script>
```

| Option | Default | Meaning |
|---|---|---|
| `did` | `_visito` | Name of the cookie and localStorage entry that hold the stored id |

## The reading

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Version of the id definition. Ids are comparable only within one version |
| `did` | string or null | The stored id; null when the browser keeps neither a cookie nor localStorage |
| `didNew` | boolean | True when the stored id was created on this page view |
| `didSrc` | string | Where it was found: `c` cookie, `l` localStorage, `cl` both, empty when new |
| `id` | string or null | 64 hex characters; null until every part is read, and when a part failed |
| `idStrict` | string or null | 64 hex characters; `id` plus the version fields |
| `model` | string or null | Device model, where the browser reports one |
| `os`, `osVer` | string, string or null | `android`, `ios`, `windows`, `mac`, `linux` or `other`, and its version |
| `app`, `appVer` | string, string or null | Browser or app family (`chrome`, `safari`, `firefox`, `facebook`, `instagram`, ...) and its version |
| `engineVer` | number or null | Chrome or Firefox major version |
| `flags.partial` | string[] | Reads that failed or timed out |
| `flags.auto` | string[] | Signs of automation that were observed; see [Automation marks](#automation-marks) |
| `flags.private` | boolean or null | `true`: this session's storage is not kept, as in a private window or an app's in-memory web view (the page cannot tell those apart). `false`: the browser showed that storage is kept. `null`: unknown. Asked only in WebKit and Gecko browsers, and in the core only on a view whose stored id is new; so always `null` in Chrome, Edge and other Blink browsers, on a returning view, and with `start({ store: false })`. A normal Firefox window gives `null`, not `false`, because Firefox is bringing the file system the check uses to private windows. A page script can fake it: a hint for analytics, not a security control. See [SIGNALS.md](SIGNALS.md#xprivate-and-flagsprivate) |
| `flags.weak` | boolean | True when the browser names no device model, so more devices share the id. On Brave's desktop builds the id is then built from the language and the text size alone: every Brave desktop with the same two shares one `id`, and the stored id is what tells them apart |
| `c` | object | The raw values behind the ids; see [SIGNALS.md](SIGNALS.md) |
| `ms`, `t` | number, object | Milliseconds of work, in total and per step |

## How the ids behave

- Two phones of one model with the same settings get the same `id`. The stored id separates them, while it survives.
- No uniqueness or accuracy figure has been measured on enough devices to state one.
- Brave, Safari and Firefox randomise or clamp some values on purpose. Those are left out, so the id rests on fewer values. On Brave for desktop only the language and the text size are left: every Brave desktop with the same two shares one `id`, and `flags.weak` is true.
- Where browsers report different values, such as a model in one and none in another, the ids differ. On an iPhone measured in one session, Safari, Chrome and Instagram's in-app browser gave three ids under the 0.1.0 rules; whether Safari and Chrome now share one is not measured ([DECISIONS.md](DECISIONS.md#the-rules-replayed-on-the-session), one session on three devices).
- The fingerprint id was the same in normal and private windows of Chrome, Brave and Safari on the phones measured; it has not been measured in every browser.
- The automation marks are easy to patch around. An empty `flags.auto` means none was observed, nothing more; see [Automation marks](#automation-marks).
- On WebKit and Gecko, on a view whose stored id is new, the private-window check opens the origin's private file system and writes nothing to it; Firefox 155 then reported about 480 KB of storage usage for the origin ([DECISIONS.md](DECISIONS.md#the-in-memory-session-check-behind-flagsprivate)).

## Automation marks

`flags.auto` lists what the script observed at script start. Each mark names one observation. None of them enters an id.

| Mark | What was observed |
|---|---|
| `webdriver` | `navigator.webdriver` is `true` |
| `global` | The window holds one of 8 global names that automation tools set, each found in the tool's own source |
| `no-languages` | `navigator.languages` is an empty list |
| `headless` | The user agent contains `HeadlessChrome`, `PhantomJS` or `SlimerJS`, in any letter case |
| `platform` | `navigator.platform` does not fit the OS in the user agent (checked for Android, iOS, Windows and macOS) |
| `no-touch` | The user agent says Android or iOS, and `navigator.maxTouchPoints` is 0 |
| `no-brands` | The client-hint brands, `navigator.userAgentData.brands`, are an empty list. This is what a user agent replaced through the debugging protocol leaves |
| `not-android` | The user agent says Android, the engine is Blink, and the engine's features say it is not running on Android |

Checks that misfire inside Android in-app browsers are left out. Any client-side check can be patched around, and every one of these is easy to patch, so an empty list means none of these was observed, not that a person is there; a tool that sets its values with care leaves no mark. `no-brands` and `not-android` rest on two visits of one automated scanner ([DECISIONS.md](DECISIONS.md)). Weigh the marks on your server with what else you know.

These eight are the core's whole list for 1.x. No separate automation entry ships in 1.0: the candidates measured for one fired for real people running ordinary browser extensions, so they stay in the lab build, where they are still being measured ([DECISIONS.md](DECISIONS.md#automation-marks-none-added-in-10)).

## What 1.x keeps

This is part of the support policy in [RELEASING.md](../RELEASING.md#support-policy). `test/types/consumer.ts` pins the type of every field named here and fails when one narrows, widens or disappears.

Every field in [the reading](#the-reading) keeps its name, type and meaning for all of 1.x: `v`, `did`, `didNew`, `didSrc`, `id`, `idStrict`, `model`, `os`, `osVer`, `app`, `appVer`, `engineVer`, `flags.partial`, `flags.auto`, `flags.private`, `flags.weak`, `c`, `ms` and `t`. `get` calls back with such a reading or with `null` in the cases listed under [`Visito.get`](#visitogetcallback), and `getSync` returns one or `null`.

A value in `c` is a string, a number or a boolean. Keys starting with `hw.` or `p.` are the parts of `id`. Keys starting with `x.` are inputs and hints and are never hashed. Keys starting with `r.` are rendering values, read only by the lab build and the deep entry. There are five status strings and no others: `!na` (the browser does not have the value; hashed like any value), `!err` (the read threw), `!to` (it timed out or has not run), `!ex` (left out on purpose in this browser) and `!noise` (an alteration check fired; lab build and deep entry only). `flags.partial` lists the keys of `c` that are `!err` or `!to`, and the eight automation marks keep their names and what they observe.

`id` and `idStrict` are SHA-256 over the text given in [SIGNALS.md](SIGNALS.md#how-an-id-is-computed), so your server can recompute them from `c` and the version fields. One `v` always means one recipe.

A minor release may add `x.` hints to `c`, keys to the lab build, and fields to the reading, which will be listed here. Read `c` by the keys you know and ignore the rest.

Only a new `v` changes which keys are parts of an id, how a part is derived from what the browser gives, which browsers leave a part out, how the parser turns a user agent it already handles into `app`, `appVer`, `osVer` and `engineVer` (parts of `idStrict`), and the recipe. Ids of different `v` do not compare, and `match` compares such readings by stored id only. The support policy says how a new `v` can ship within 1.x.

Only 2.0 changes the name or type of a field, the meaning of a status, the stored id's cookie and storage names and format, or the calls `get`, `getSync`, `start` and `match`.

Not kept: the step names and numbers in `ms` and `t`, the experimental `visitojs/deep` reading, and the lab build. `model`, `osVer` and `appVer` change when the browser reports something else.

## Waiting for consent

The deferred build, `visito.defer.min.js` or `visitojs/defer`, loads without reading or storing anything. It is the same library with one more call, `start()`, and until the page calls it nothing happens: no read of the browser, not even of `window`, no cookie, no storage, no timer, no listener, no element. VisitoJS collects no consent and does not tell you whether you need it. Using this build does not by itself make a site meet any law; it only lets your page decide when reading begins ([LEGAL.md](LEGAL.md)).

```html
<script src="https://cdn.jsdelivr.net/npm/visitojs@1.0.0/dist/visito.defer.min.js"
        integrity="sha384-<the SHA-384 of that file>"
        crossorigin="anonymous"></script>
<script>
  Visito.get(function (visitor) { if (visitor) sendToServer(visitor) })  // runs once start() has run
  banner.onAccept(function () {                                          // a click: let it paint first
    requestAnimationFrame(function () { setTimeout(function () { Visito.start() }, 0) })
  })
  if (banner.accepted()) Visito.start()                                    // agreed on an earlier visit
</script>
```

`banner` stands for your consent tool, and `sendToServer` for your own code. The integrity value is the file's SHA-384, `openssl dgst -sha384 -binary visito.defer.min.js | openssl base64 -A`, taken from the published package. `start()` does its first stage before it returns (the user agent, the cookie and localStorage read and written back, the cache), so called straight from a click handler it adds that work to the click's response; `requestAnimationFrame` then `setTimeout` runs it after the next paint.

This wiring needs the script tag above it, without `async` or `defer`, so that `Visito` exists when the calls run. Loaded with `async`, `defer` or a tag manager, make the calls from the script's `onload` and start from both places: whichever comes last finds the other ready, and where both start, the second `start()` is ignored. Define the handler before the tag, since an `async` script can run before the markup after it:

```html
<script>
  var agreed = banner.accepted()
  function visitoLoaded() {
    Visito.get(function (visitor) { if (visitor) sendToServer(visitor) })
    if (agreed) Visito.start()
  }
  banner.onAccept(function () {
    agreed = true
    requestAnimationFrame(function () { setTimeout(function () { if (window.Visito) Visito.start() }, 0) })
  })
</script>
<script async src="<as above>" integrity="<as above>" crossorigin="anonymous" onload="visitoLoaded()"></script>
```

With a consent tool that implements the IAB TCF v2 API: purpose 1 is storing or accessing information on a device, and the TCF policies list actively reading device characteristics to tell devices apart as Special Feature 2, which needs its own opt-in, `specialFeatureOptins` in the CMP API:

```js
__tcfapi('addEventListener', 2, function (tcData, success) {
  if (success && (tcData.gdprApplies === false || (tcData.purpose && tcData.purpose.consents[1] &&
      tcData.specialFeatureOptins && tcData.specialFeatureOptins[2]))) Visito.start()
})
```

The listener is called at once with the current state, which covers consent given on an earlier visit, and again on every change; the second `start()` is ignored. An unknown `gdprApplies` (`undefined`) starts nothing. Which purposes and features your use of the ids needs is your decision, with your own advice ([LEGAL.md](LEGAL.md)).

As a module:

```js
import { start, get } from 'visitojs/defer'

get((visitor) => visitor && sendToServer(visitor))
banner.onAccept(() => requestAnimationFrame(() => setTimeout(() => start(), 0)))
```

How it behaves:

- **Before `start()`** `getSync()` returns `null`, and `get(callback)` waits. A page that never calls `start()` never gets a callback.
- **`start()`** runs the core build's session from that moment: the stored id is read and written then, the cache is read then (so a returning visitor has both ids straight after `start()`), and the 10-second, 1-second, 4-second and 30-second limits under [`Visito.get`](#visitogetcallback) count from `start()`, which is "script start" for this build. `VisitoConfig` is read then too. Ids, cache and stored id are the core build's, so the two builds can be mixed on one site.
- **Late is fine.** Called while the document parses, the reads that need it wait for it; called after it has parsed, or long after `load`, they run on the next turn. Nothing is lost by starting late.
- **The first call decides.** A second `start()` is ignored, whatever its options, so repeated events from a consent tool are harmless. A page that started with `store: false` cannot switch to storing in the same page view.
- **`start({ store: false })`** reads the device but does not read or write the cookie, localStorage or sessionStorage, and does not ask the private-window check, which opens the origin's file system. `did` is `null`, `didNew` `false`, `didSrc` empty and `flags.private` `null`. `id` and `idStrict` are the ones the stored mode gives on the same browser. Nothing is cached, so every view reads afresh and the ids arrive when the page has parsed.
- **Only an absent `store` or `store: true` stores.** Any other value (`false`, `0`, `'no'`, a getter that throws), or options that are not an object, store nothing. Call `start` from your own function, as above: handed straight to an event API, it receives whatever that API passes.
- In a frame it reads nothing and stores nothing, as the core build: `get` calls back with `null`.

Load one build per page: both define `Visito`. The deferred build's size, next to the core's, is in the [README's table of entries](../README.md#entries). To withdraw consent, remove what was stored as [LEGAL.md](LEGAL.md#when-consent-is-withdrawn) shows. The core build can also be loaded only after consent, by adding its script tag then; the deferred build is for pages that want to call `get` early, bundle the library, or use `store: false`.

## Match visitors on your server

When the stored id is missing, `match` compares a reading with the ones you saw before:

```js
import { match } from 'visitojs/match'

const verdict = match(reading, earlierReadings)
// { result: 'same' | 'likely' | 'unknown' | 'different', rule: '...', index: 0 }
```

An equal stored id is `same`. Without one, a device is `likely` only when nothing contradicts and both readings name the same model. Two candidates that fit equally well are `unknown`, never a guess.

Give each reading `did`, `os`, `osVer`, `app`, `appVer`, `c` and, if you keep it, `v`. Values are compared by their text, so `'8'` from a store equals `8`. Versions are compared only on the fields both sides have, so `17` and `17.0.1` do not contradict.

A candidate whose `v` differs from the reading's neither fits nor contradicts: its parts may mean something else in the other version, and when nothing else decides the answer is `unknown`, rule `other id version`; the stored id still decides across versions. The stored id needs no parts: a candidate with an equal `did` is `same`, rule `stored id`, with or without `c` and whatever its `v`. A `did` counts only when it is a non-empty string on both sides, so `true` against `true` or `5` against `5` is no stored id.

`match` never throws on anything `JSON.parse` returns: a version that is not a string or a number counts as missing, a candidate without a `c` object is not compared part by part, and a reading without one gives `unknown`, rule `nothing to compare`, unless its stored id decides.

## The deep entry: `visitojs/deep`

> **Experimental.** `visitojs/deep` returns a second id from one canvas drawing (shapes, gradients and a scaled image, no text) and an offline audio render, meant to help tell desktop computers apart where the core `id` cannot. Whether it does is not known yet: it was measured on one PC only, so nothing here shows that two computers get different deep ids. It may give one id to many machines of one model, browser and graphics driver, and several ids to one machine. Its values are not frozen, and `DEEP_VERSION` may change in a minor release. Treat the deep id as one more signal to weigh on your server, never as proof that two visits are or are not the same computer.

It is a separate file with its own global. The core build reads no canvas or audio and does not change when you add it; "under 8 KB" is the core alone, and the deep entry adds its own 6,402 bytes gzipped ([README, Entries](../README.md#entries)).

```html
<script src="https://cdn.jsdelivr.net/npm/visitojs@1.0.0/dist/deep.min.js"></script>
<script>
  // a content blocker may keep the file from loading
  if (window.VisitoDeep) VisitoDeep.get(function (deep) {
    // send deep.v, deep.id, deep.flags and deep.c to your server, beside visitor.did and visitor.id
  })
</script>
```

The deep entry ships from 1.0.0 on; `0.1.0` has no `dist/deep.min.js`. Add `integrity` and `crossorigin` as for the core, with the SHA-384 of the published `dist/deep.min.js`.

```js
import { get } from 'visitojs/deep'
```

`get(callback)` starts the reads on its first call, never when the file loads. It waits for `load` (or 3 seconds, if `load` never fires), an idle moment and a visible page, then draws and reads in short steps, one task each, then renders 5,120 audio samples offline. It calls back once per call, after `get` has returned, with the same object for every caller, or with `null` inside a frame or outside a browser. A watchdog answers 30 seconds after the first call. The answer and the watchdog both run on the page's own timers: on a page that has broken both `setTimeout` and `MessageChannel` the answer can come before `get` returns, and on a page whose `setTimeout` silently drops what it is given it may not come at all. A page opened in a background tab and not shown within those 30 seconds gets every part `!to`. It stores nothing, sends nothing, and never touches `id`, `idStrict` or the core reading.

```json
{
  "v": 1,
  "id": "dc46a2e51e869285...",
  "c": { "r.audio": "f4a05a170fb56b91", "r.cg": "d617dfc6bae236cc", "r.cchk": "ok", "r.achk": "ok", "x.rule": "", "r.ct": "!ex" },
  "flags": { "partial": [], "noise": [], "excluded": [], "weak": false },
  "ms": 31.2,
  "t": { "canvas:pattern": 1.1, "audio": 2.3 }
}
```

| Field | Meaning |
|---|---|
| `v` | `DEEP_VERSION`. Compare deep ids only within one version |
| `id` | SHA-256 of `r.audio` and `r.cg`, 64 hex characters, or `null`. Your server can recompute it from `c` ([SIGNALS.md](SIGNALS.md#how-the-deep-id-is-computed)) |
| `c` | `r.cg` (the drawing) and `r.audio` (the render): 16 hex digits or a status. `r.ct` is always `!ex`: the text scene is not read ([DECISIONS.md](DECISIONS.md#the-text-scene-leaves-the-deep-id-13-november-2026)). `r.cchk` and `r.achk` name the check that decided each read; `x.rule` names the rule that left parts out; `x.id` is `!err` when a hash failed its self-test |
| `flags.noise` | Parts whose alteration check fired: the browser or an extension returned something other than what was drawn or rendered. No id |
| `flags.partial` | Parts that failed or ran out of time. No id |
| `flags.excluded` | Parts this browser's rule leaves out |
| `flags.weak` | An id was built, but `r.audio` or `r.cg` is missing in this browser |
| `ms`, `t` | Milliseconds the page was kept busy, in total and per step |

Where it reads, chosen from the browser's features, never its user agent:

| Browser | Reads | Why |
|---|---|---|
| Chrome, Edge, Opera, Vivaldi and other Blink browsers on desktop | `r.cg` and `r.audio` | Measured in Chromium, Chrome and Edge; Opera and Vivaldi not measured |
| Firefox on desktop | `r.cg` and `r.audio` | Its default protection left these reads alone in Playwright's Firefox build; its stronger settings are caught as noise |
| Safari and every other WebKit browser, so every iOS browser | No (`webkit`) | Private windows add noise that cannot be told apart in time, readback is withheld from scripts it lists, and no Mac has measured it |
| Android, any browser | No (`android`) | Desktops only; the drawing differed between two browsers on one phone |
| Brave | No (`brave`) | It alters canvas and audio per session and per site by default |
| An engine it cannot name | No (`other`) | |

The checks catch: Firefox's canvas randomisation and `resistFingerprinting`, set by preference in Playwright's Firefox 155 build; Brave's default canvas and audio alteration, in the installed Brave 1.99; a `SecurityError` from `getImageData`, injected by the unit tests and the fault matrix (no browser's own readback block was run); alterations of the pixels or samples in the shapes browsers document, injected the same way; and a page that broke what the digest or the hash uses, through their own known-answer tests (no id then). They do not catch everything: an alteration that spares every known pixel and treats both drawings of a scene alike gives a value, and so does one made to the drawing calls rather than the readback ([SIGNALS.md](SIGNALS.md#the-deep-entry)). Under `resistFingerprinting`, which Tor Browser and Mullvad Browser turn on, Firefox prints "Blocked ... from extracting canvas data" in the console on every call. On your server, the same `did` seen with different deep ids under one `v` means the deep id is not stable for that browser.

What was measured, on one PC (Windows 11, AMD Ryzen 7 5700X, NVIDIA RTX 2070 SUPER) on 13 November 2026, in Playwright's Chromium 153 and Firefox 155 and in the installed Chrome 157, Edge 157 and Brave 1.99, is in [DECISIONS.md](DECISIONS.md#the-deep-entry-13-november-2026). In short:

- **The same there:** one deep id over 20 reloads, 20 new contexts in two launches, five page locales, forced colours, a dark scheme, and 15 display-scale, text-size and page-zoom settings (in Firefox 19), each set in a new profile as a person sets them; in Chromium 153 with and without the GPU, in Chrome 157 and Edge 157, and in Firefox 155. Firefox ran in normal windows and with Playwright's every-window-private preference; a release Firefox private window was not measured. Four pixel ratios set through Playwright do not move it. Chromium's interface language does not move it, headless or headed: Arabic, Japanese, Chinese (simplified), Korean, Thai and German gave the base deep id in both.
- **Known to change on one machine:** with the GPU on or off, and with the GPU backend: five different deep ids in Chromium on this PC. After Chromium loses its GPU process a third time in a session it draws in software until it restarts, and its deep id changes with it. Firefox and Chromium give different deep ids. Chrome 157 and Edge 157 gave the same deep id as Playwright's Chromium 153 with the GPU. The deep id has no text in it: the text scene moved with display scale, text size and zoom in Firefox, with a Japanese, Chinese, Korean or Thai display language in a headed Chromium, and with the device scale and the way the browser was started in Chromium on Linux, while the drawing and the audio did not, so it was taken out ([DECISIONS.md](DECISIONS.md#the-text-scene-leaves-the-deep-id-13-november-2026)).
- **Cost**, desktop lab timings, not laptop or phone timings. This PC, headed, date 2026-11-13 (`lab/deep-cost.mjs --headed`, this build): in Firefox 155, the first page of a session took 9 and 10 ms of page time in total in two sessions, in steps of at most 4 ms, and later pages 10 to 11 ms (new contexts, median) and 5.5 ms (reloads). In Chromium 153, which drew on the GPU headed, the first page of a session took 228 and 227 ms in two launches, 168 and 165 ms of it in the first geometry canvas, a single browser call the entry cannot split; later pages 13 ms (median, steps of at most 4 ms) and reloads 9 to 10 ms; at 4x CPU slowdown, later pages 42 ms in steps of at most 15 ms. The headless timings from before the text scene was taken out are in [DECISIONS.md](DECISIONS.md#the-deep-entry-13-november-2026). Not measured on a laptop or a phone.
- **Size:** `dist/deep.min.js` is 6,402 bytes gzipped (5,729 with Brotli), under its own budget of 7,232.
- **Unknown until real machines are measured:** how well it tells computers apart, how long a deep id lasts across browser, driver and OS updates, and its cost on a low-end laptop.

Device identification is regulated; the deep entry renders and reads canvas and audio only when your page calls it, and that call is the moment your legal basis must already exist ([LEGAL.md](LEGAL.md)).
