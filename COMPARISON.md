# Comparison with other open-source libraries

Measured on 2026-11-13 with `lab/compare.mjs`, two runs in each engine. This file is in the repository only; the npm package does not ship it.

The libraries are the open-source builds their npm packages ship, at these versions, each called with its default options. FingerprintJS and ThumbmarkJS also sell services that add server-side processing, and none of those took part. FingerprintJS's readme says its commercial product differs from this build; ThumbmarkJS's says its paid API goes further than this library.

| Library | Version | File measured |
|---|---|---|
| VisitoJS | 1.0.0 | `dist/visito.min.js` (the core) |
| FingerprintJS | 5.3.0 | `dist/fp.min.js` |
| ThumbmarkJS | 1.12.0 | `dist/thumbmark.umd.js` |
| get-browser-fingerprint | 5.2.4 | `src/index.js` |

## Results

Where the three engines agree, a cell gives one value. Otherwise it reads Chromium / Firefox / WebKit. VisitoJS returns two fingerprint ids and a stored id; the cells give `id`, and a note gives the others where they matter.

| Check | VisitoJS | FingerprintJS | ThumbmarkJS | get-browser-fingerprint |
|---|---|---|---|---|
| Gzipped size of the file the package ships, bytes | 7,460 | 16,418 | 11,567 | 4,558 (3,704 after minifying with terser) |
| Requests on visits with default options, per run | none in 115 / 110 / 111 | 1 in 136 visits in each Chromium run, a GET to its monitoring host; none in 131 / 132 | none in 115 / 110 / 111 | none in 115 / 110 / 111 |
| Requests on one visit with `Math.random()` returning 0, so that a sampled request is due | none | 1: a GET to its monitoring host | 2: a GET for a script it then runs, and a POST of the reading | none |
| Fault visits where an error reached the page, of 19 | 0 | 0 | 3 | 0 |
| Fault visits where the call threw, rejected or never answered within 15 s, of 19 | 0 | 2 / 0 / 0 | 1 | 6 / 5 / 5 |
| Fault visits answered with a fingerprint id, of 19 | 17 / 18 / 18 | 17 / 19 / 19 | 17 | 13 / 14 / 14 |
| 20 reloads with nothing cached, phone and desktop profiles | 1 id in each | 1 id in each | 1 id in each, except 2 ids in 20 in the Chromium phone profile | 1 id in each |
| User-agent version raised by one | same | same | changed | changed / changed, but a new context alone also changed it / same |
| Rotation, phone profile | same | same | same | changed / changed, but a new context alone also changed it / changed |
| Cookies and storage cleared | same | same | same | same |

VisitoJS loses the size row to get-browser-fingerprint, and the row of fault visits answered with a fingerprint id to FingerprintJS in Firefox and WebKit. The second is by design: when a read that an id is built from fails, VisitoJS gives no fingerprint id and names the read in `flags.partial`, and it still returned its stored id in all 19 fault visits in every engine.

Notes on the rows:

- The sampled requests are documented by each library. FingerprintJS: 1 in 1,000 calls to `load()`, turned off with `monitoring: false`, no body (`dist/fp.js:3230-3248` and `3252-3256` in 5.3.0). It also happened on one ordinary visit in each Chromium run. ThumbmarkJS: at most 1 in 10,000 runs and once per browser session, turned off with `logging: false`; the POST carries the thumbmark, every component value, the evaluated script's result, the options and the page path (`README.md:85` and `93-107`, `src/utils/log.ts:25-41` in 1.12.0).
- 13 of the 19 faults come from VisitoJS's own fault matrix, which VisitoJS was built to pass. 4 were added on reads the other libraries depend on. VisitoJS's core reads less than the others, so its code reached 5 or 6 of the 17 broken properties, against 9 to 13 for the others; a fault that is not reached says nothing about how the code would handle it.
- With the user-agent version raised, VisitoJS's `idStrict` changes, as it is meant to. After cookies and storage are cleared, VisitoJS's stored id is a new one; the others keep no stored id.

## Not measured yet

Whether an id stays the same across the browsers of one device, in a real private window, or on a real phone; how well any of these ids tells devices apart; and time to first id. The run records timings, but other work was running on the PC, so none is published.

## Method

One Windows 11 Pro PC (AMD Ryzen 7 5700X 8-Core Processor, NVIDIA GeForce RTX 2070 SUPER), with Playwright 1.63.0's own builds of Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6, headless, under Node 24.19.0. These are not the browsers people install: WebKit on Windows is not Safari, and the phone profile is a desktop engine with a phone's user agent, a 393x852 viewport, a device scale of 2.75, touch, locale `fr-FR` and time zone `Europe/Paris` (Firefox has no mobile emulation, so there it gets the user agent, viewport, touch, locale and time zone only). Every hardware value is this PC's. The desktop profile uses the browser's own user agent.

The harness fetches each other library with `npm pack` at the pinned version and checks it against the integrity value in `lab/compare/libraries.mjs`; none of their code is in this repository. It serves a blank page from a local server, aborts and records every request to any other address, and closes every WebSocket.

Samples, per engine and per run: 20 reloads with each library's cached values removed before each, in each profile; one visit after cookies and storage are cleared; one visit for each condition (the user-agent version raised by one, rotation in the phone profile), compared with a visit just before it, in the same context where the engine allows it and otherwise in a new one, beside a second-context control; 19 fault visits in the phone profile, 2 of them baselines and 17 with a fault installed before any page script runs; one visit with `Math.random()` returning 0. Chromium also emulates the client hints that match each user agent.

To reproduce:

```sh
npm ci --ignore-scripts && npm run build
npx playwright install chromium firefox webkit
node lab/compare.mjs chromium --run 1
node lab/compare.mjs chromium --run 2
node lab/compare.mjs firefox --run 1
node lab/compare.mjs firefox --run 2
node lab/compare.mjs webkit --run 1
node lab/compare.mjs webkit --run 2
node lab/compare/table.mjs lab/report/raw/compare-*.json > table.md
```

`table.md` then holds every cell above, per engine and per run, the fault-by-fault table, the full method and what each library's package says about the requests it can send.
