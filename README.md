<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/visitojs/visitojs/main/.github/brand/logo-dark-624.png">
    <img src="https://raw.githubusercontent.com/visitojs/visitojs/main/.github/brand/logo-light-624.png" alt="VisitoJS" width="312">
  </picture>
</h1>

<p align="center">
  <strong>Device identification for the browser, in one small script that makes no network requests.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/visitojs"><img src="https://img.shields.io/npm/v/visitojs.svg" alt="npm version"></a>
  <a href="#entries"><img src="https://img.shields.io/badge/gzip-7.5%20kB-0B6E5C" alt="7,460 bytes gzipped"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/visitojs.svg" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/visitojs"><img src="https://img.shields.io/npm/types/visitojs.svg" alt="TypeScript types included"></a>
  <a href="https://www.jsdelivr.com/package/npm/visitojs"><img src="https://img.shields.io/jsdelivr/npm/hm/visitojs.svg" alt="jsDelivr hits per month"></a>
</p>

- **A stored id** (`did`), kept in a first-party cookie and in localStorage, ready the moment the script runs.
- **A fingerprint id** (`id`) built from the device and its settings, with no version numbers in it. It stays the same across the browsers of one device where those browsers report the same values.
- **Flags** that tell your server how firm each reading is: a failed read, a browser that names no device model, a private window where the browser reveals it, signs of automation.
- **No network requests**, no dependencies, ES5 back to Chrome 53. The core is 7,460 bytes gzipped.

## Quick start

From the CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/visitojs@1.0.0/dist/visito.min.js"
        integrity="sha384-tRACvKo0CYtFU1/Ku84LiHwYALdV9Qxc7ZWmqGw8lkqfKUqlnkj/ROePV2J2ZgZZ"
        crossorigin="anonymous"></script>
<script>
  Visito.get(function (visitor) {
    if (!visitor) return       // null inside a frame, and in the cases in docs/API.md
    console.log(visitor.did)   // stored id
    console.log(visitor.id)    // fingerprint id
  })
</script>
```

From npm:

```sh
npm install visitojs
```

```js
import { get } from 'visitojs'

get((visitor) => {
  // send visitor.v, visitor.did, visitor.id, visitor.idStrict and visitor.flags to your server
})
```

## What you get

```json
{
  "v": 3,
  "did": "3f1c9a52-7d0e-4b6a-9c1e-2a5b8d4f6e10",
  "didNew": false,
  "id": "a46245e0...",
  "idStrict": "110d1171...",
  "model": "Pixel 10",
  "os": "android",
  "osVer": "17",
  "app": "chrome",
  "appVer": "157.0.0.0",
  "flags": { "partial": [], "auto": [], "private": null, "weak": false }
}
```

Abridged: a reading also has `didSrc`, `engineVer`, `c` (the raw values behind the ids), `ms` and `t`. Every field is in [docs/API.md](docs/API.md#the-reading).

- **`did`** is the stored id. It lasts until the visitor or the browser clears the site's storage.
- **`id`** is the fingerprint id. A browser or app update alone does not change it.
- **`idStrict`** adds the OS and app versions. Use it to tell similar devices apart inside a short window.
- **`flags`** let your server tell a firm id from a weak or incomplete one.

## Demo

The [live demo](https://visitojs.github.io/visitojs/) shows the ids of your own device. Reload it, open it in a private window, open it in another browser, and compare. The page sends nothing anywhere.

## How it works

At script start VisitoJS reads its stored id and parses the user agent into model, OS, app and versions. When the page has parsed, it reads the text-size setting and, where the user agent hides the phone model, asks the browser's client hints for it; on devices that name no model, screen size and core count stand in. It hashes those parts with SHA-256 into `id`, and adds the version fields for `idStrict`. Browsers that hide or randomise values on purpose, such as Brave, Safari and Firefox, have those values left out of the id, and `flags.weak` tells your server when an id rests on fewer values. Devices of one model with the same settings share an `id`, which is why the stored id comes first and the fingerprint id is there for when it is missing. VisitoJS runs in the top page; inside a frame it returns `null`. Every read is wrapped, so it does not throw into your page and still calls back when a browser API is missing or broken. A 24-hour cache makes both ids available at script start on the next visit. [docs/SIGNALS.md](docs/SIGNALS.md) lists every value read, and [docs/DECISIONS.md](docs/DECISIONS.md) the evidence behind each choice.

## Entries

| Import | Browser file | Gzipped bytes | What it is |
|---|---|---:|---|
| `visitojs` | `dist/visito.min.js`, global `Visito` | 7,460 | The core: stored id, `id`, `idStrict`, flags. Reads no canvas, WebGL or audio |
| `visitojs/defer` | `dist/visito.defer.min.js`, global `Visito` | 7,568 | The core with one more call, `start()`. Nothing is read or stored before it. See [Waiting for consent](docs/API.md#waiting-for-consent) |
| `visitojs/match` | none: `dist/match.js` is an ES module for your server | 1,783 | Compares a reading with earlier ones when the stored id is missing. See [Match visitors on your server](docs/API.md#match-visitors-on-your-server) |
| `visitojs/deep` | `dist/deep.min.js`, global `VisitoDeep` | 6,402 | **Experimental.** A separate id from one canvas drawing of shapes, with no text, and an offline audio render, read only when your page calls it. See [the deep entry](docs/API.md#the-deep-entry-visitojsdeep) |

Bytes are gzip at Node's default level, on the build of this release. `test/bundle.test.mjs` holds the core and the deferred build at or under 8,192 bytes, and the deferred build within 134 bytes of the core. Load the core or the deferred build, not both: each defines `Visito`. The `.esm.js` files are the same code as unminified ES modules, for your bundler.

## API

| Call | What it does |
|---|---|
| `get(callback)` | Calls back once with the reading when it is done, or with `null` inside a frame, outside a browser, or in the other cases in docs/API.md. The callback runs from a timer, after `get` returns |
| `getSync()` | Returns the reading as it stands now, or `null`. The stored id is there from the start; the fingerprint ids when the reading is done |
| `start(options)` | Deferred build only. Starts the reading once; `{ store: false }` reads the device but no cookie and no storage |
| `match(reading, earlier)` | From `visitojs/match`. Returns `same`, `likely`, `unknown` or `different`, with the rule that decided and the index of the candidate |

The reads after script start may keep the page busy for 4 seconds in total, a read that waits on the browser gets 1 second, and whatever is still missing after 30 seconds is named as timed out. A partial reading names its missing reads in `flags.partial`, and has `id` and `idStrict` set to `null` when a missing read is part of them.

| Flag | Meaning |
|---|---|
| `flags.partial` | Reads that failed or timed out |
| `flags.weak` | The browser names no device model, so more devices share the id |
| `flags.private` | `true` when this session's storage is not kept, as in a private window; `false` when the browser showed it is kept; `null` when unknown, always in Chrome and other Blink browsers |
| `flags.auto` | Signs of automation that were observed: up to eight named marks, none of which enters an id |

The one option, `window.VisitoConfig = { did: 'name' }`, sets the name of the cookie and localStorage entry (default `_visito`). [docs/API.md](docs/API.md) covers timers, frames, every field, the automation marks, consent wiring, the matcher's rules, the deep entry and what 1.x keeps.

## Privacy and consent

VisitoJS stores one id in a first-party cookie and in localStorage, and a 24-hour cache of a few values in localStorage or sessionStorage. It sends nothing anywhere; your page decides what leaves the browser. The deferred build loads without reading or storing anything and starts when your page calls `start()`, for example once the visitor has given consent. [docs/LEGAL.md](docs/LEGAL.md) lists every stored item, how to remove them, and the texts on device identification to read first.

## Browser support

The output is ES5, from a source compiled against `lib: ["ES5", "DOM"]`, and `es-check es5` checks every build. Chrome 53 is the floor: a release ships only after the core, deferred, lab and deep builds run in Chrome 53, 59, 63, 68 and 80 and give the ids Node recomputes ([RELEASING.md](RELEASING.md)). The ES5 check holds the code to what Safari, Firefox and Android WebViews of the same age parse. CI runs the browser harnesses in Playwright's Chromium, Firefox and WebKit. VisitoJS parses the user agents of in-app browsers such as Facebook's and Instagram's.

## Compared with other libraries

The core was run beside the published builds of three other open-source libraries, through the same checks with default options, in Chromium, Firefox and WebKit. VisitoJS made no network request in any run, let no error reach the page in any of 19 fault visits and answered every one of them, and kept the same `id` across reloads, a user-agent version bump, a rotation and cleared storage. At 7,460 bytes gzipped it is less than half the size of the largest library compared (16,418). [COMPARISON.md](https://github.com/visitojs/visitojs/blob/main/COMPARISON.md) has every row, the versions, the date, the sample and the command that reproduces it.

## Upgrading from 0.1.0

Every `id` and `idStrict` changes once: the id definition is now version 3 (`v: 3`), and 0.1.0 built version 2. The stored id does not change, so a returning visitor keeps it. Label ids stored before the upgrade `v: 2`, never compare ids of different versions, and give `match` those readings with `v: 2`: it then compares them by stored id only. [CHANGELOG.md](CHANGELOG.md) and [docs/DECISIONS.md](docs/DECISIONS.md#what-changed-from-version-2) list what changed.

## FAQ

**Does it make network requests?**
No. No entry makes a request, loads remote code or sends telemetry. What leaves the browser is what your own code sends.

**Does it work without cookies, or in a private window?**
Yes. The fingerprint ids need no storage; where the browser keeps neither a cookie nor localStorage, only `did` is `null`. In a private window the stored id is new and lasts as long as the window. On the phones measured, Chrome, Brave and Safari gave the same fingerprint id in normal and private windows.

**Is the id unique?**
`id` is a device fingerprint: devices of one model with the same settings share it, and `flags.weak` marks the readings built from fewer values. The stored id tells such devices apart, so key visitors by `did` and use `id` when the stored id is missing.

**Does it identify the same device across browsers?**
Yes, where the browsers report the same values. On a Pixel 10, Chrome, its incognito window and the Instagram and Facebook in-app browsers gave one `id`; browsers that hide values, such as Brave, get their own ([docs/DECISIONS.md](docs/DECISIONS.md#the-rules-replayed-on-the-session)).

**Does it detect bots?**
It reports eight automation marks in `flags.auto`, each naming one observation, such as `navigator.webdriver` being `true` or a headless user agent. Your server weighs them with what else it knows about the visit ([docs/API.md](docs/API.md#automation-marks)).

**Is it legal to use?**
Device identification is regulated, and in the EU reading a device to identify it generally needs consent. Whether and how you may use it is your decision, under the law where your visitors are. [docs/LEGAL.md](docs/LEGAL.md) lists what to read; it is not legal advice.

**How big is it?**
The core is 7,460 bytes gzipped, and a test keeps it at or under 8,192. The deferred build is 7,568. The matcher runs on your server and adds nothing to the page. The experimental deep entry is a separate file.

**Does it work on old browsers and in WebViews?**
The code is ES5 and runs back to Chrome 53, checked in Chrome 53, 59, 63, 68 and 80 before each release. It recognises in-app browsers from their user agents; on the Android phone measured, Instagram's and Facebook's in-app browsers gave the same `id` as Chrome.

**How do I store and match ids on my server?**
Send `v`, `did`, `id`, `idStrict`, `flags`, `os`, `osVer`, `app`, `appVer` and `c`, and key visitors by `did`. When a visit arrives without a known `did`, `match` from `visitojs/match` compares it with earlier readings. Your server can recompute both ids from `c` ([docs/SIGNALS.md](docs/SIGNALS.md#how-an-id-is-computed)).

**What changes an id?**
`id` changes when a part it is built from changes: the device model, the memory bucket, the primary language, the text-size setting, or the screen and core count on devices that name no model. It also changes with a new id version, which a release calls out. `idStrict` also changes with every OS or app update. A failed read gives `null`, not a different id.

## Support

1.x gets security fixes and browser-drift fixes for 24 months from the release of 1.0.0, and for at least 12 months after 2.0.0 is released, whichever ends later. For all of 1.x the reading's shape, the id definition of each `v`, ES5 and the Chrome 53 floor, no network requests and the 8,192-byte limit of the core hold; `visitojs/deep` and the lab build may change in any release. The full policy is in [RELEASING.md](RELEASING.md#support-policy). Questions: [SUPPORT.md](SUPPORT.md). Security reports: [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm ci --ignore-scripts
npm test
```

## License

[MIT](LICENSE)
