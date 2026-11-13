// The libraries the comparison runs, each called with its default options as its documentation shows.
// The published builds are fetched by lab/compare/package.mjs and checked against these pins; none of their code is in this repository.
// Integrity values are the registry's dist.integrity for each version, read with npm view on 2026-11-13.
// What the notes say about a package was read in that package's tarball at the pinned version, with file and line.
//
// The page gives every call these helpers: __stamp(...outputs) notes when outputs first exist, __span(output, ms) records a
// duration the call measured itself, __answer(values) records the first answer, __fail(error) records a throw or a rejection,
// and __components(object) keeps the values an id was built from.
//
// cacheKeys: localStorage entries where a library keeps computed values between visits, removed before each recomputed reload.
// requests: what the package documents or codes about each request it can send, matched to a recorded URL by prefix.
// documented: a call pattern the library's documentation gives that differs from calling it once when the script ends.
import { readFileSync } from 'node:fs'

const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const LIBRARIES = [
  {
    key: 'visitojs',
    name: 'VisitoJS',
    package: own.name,
    version: own.version,
    local: true,
    file: 'dist/visito.min.js',
    type: 'classic',
    outputs: ['id', 'idStrict', 'did'],
    cacheKeys: ['_visito_c'],
    cacheNote: 'where the product build keeps the values it reads after its first stage for 24 hours, src/cache.ts',
    noRequests: 'makes no network request and loads no remote code (README.md)',
    notes: [
      `VisitoJS ${own.version} gives no id while a part of it failed or timed out: it answers with the stored id did alone and names the part in flags.partial (docs/SIGNALS.md, "When a read fails"; README.md, "Visito.get" and "The reading"), so a fault on a read an id is built from can leave a cell at "did only".`,
    ],
    // the stored id exists when the script ends; the fingerprint ids may wait for the parsed document
    call: `var early = Visito.getSync()
if (early && early.did) __stamp('did')
if (early && early.id) __stamp('id', 'idStrict')
Visito.get(function (r) {
  if (r && r.did) __stamp('did')
  if (r && r.id) __stamp('id', 'idStrict')
  __components(r && r.c)
  __answer(r ? { id: r.id, idStrict: r.idStrict, did: r.did } : null)
})`,
  },
  {
    key: 'fingerprintjs',
    name: 'FingerprintJS',
    package: '@fingerprintjs/fingerprintjs',
    version: '5.3.0',
    integrity: 'sha512-goxeuSCF/LR8E/lcsCh/YTjhlFW7AOhj4A9RQ5GHpBOKwkX/OG3z8mY5ADR1xGVRB5bSEJB66WNh5eBwehx2nQ==',
    // the minified browser script, global FingerprintJS
    file: 'package/dist/fp.min.js',
    type: 'classic',
    outputs: ['fingerprint'],
    cacheKeys: [],
    notes: [
      'FingerprintJS 5.3.0: its readme.md:83-101 says this open-source build computes the id in the browser alone, and that Fingerprint Identification, a commercial closed-source product, combines client-side collection with server-side processing and differs from it.',
      'Its readme.md:43-50 loads the agent at application startup and calls get() when the id is needed, and load() waits for an idle period before it starts reading (requestIdleCallback, or 50 ms where that is missing: dist/fp.js:3195-3198, dist/fp.d.ts:528-533), so the time to first id from the end of the script download includes that wait; a second timing row measures the documented pattern.',
    ],
    requests: [
      {
        match: 'https://m1.openfpcdn.io/fingerprintjs/',
        request: 'GET https://m1.openfpcdn.io/fingerprintjs/v5.3.0/npm-monitoring',
        rate: '1 in 1,000 calls to load(), and never in the copy on its own CDN',
        off: '`FingerprintJS.load({ monitoring: false })`',
        carries: 'no body; the URL holds the library version, and the browser adds its usual headers; the package describes it as an unpersonalized request to collect installation statistics',
        where: 'dist/fp.js:3230-3248 and 3252-3256, option documented in dist/fp.d.ts:539-543, package 5.3.0',
      },
    ],
    call: `FingerprintJS.load().then(function (agent) { return agent.get() }).then(function (r) {
  if (r && r.visitorId) __stamp('fingerprint')
  __components(r && r.components ? __values(r.components) : null)
  __answer({ fingerprint: r ? r.visitorId : null })
}, __fail)`,
    documented: {
      label: 'get() on an agent from load() at script end, called 1 s after the load event',
      method: 'For FingerprintJS, whose readme.md:43-50 (5.3.0) loads the agent at startup and calls get() when the id is needed, a second row times that pattern in its own runs: load() when the script ends, then get() 1 s after the page\'s load event, timed from the get() call to its result.',
      call: `var agent = FingerprintJS.load()
addEventListener('load', function () {
  setTimeout(function () {
    agent.then(function (a) {
      var start = performance.now()
      return a.get().then(function (r) {
        if (r && r.visitorId) __span('fingerprint', performance.now() - start)
        __answer({ fingerprint: r ? r.visitorId : null })
      })
    }).then(null, __fail)
  }, 1000)
})`,
    },
  },
  {
    key: 'thumbmarkjs',
    name: 'ThumbmarkJS',
    package: '@thumbmarkjs/thumbmarkjs',
    version: '1.12.0',
    integrity: 'sha512-qGIKlSKhsH7CtazU8dhowBDNo1l1DeAr30K785nCtFdzSWam/sybyjiPmmKu/jUjkuUJ8kr8VyRXiWQxQm/81w==',
    // the package's unpkg entry, a UMD script with the global ThumbmarkJS
    file: 'package/dist/thumbmark.umd.js',
    type: 'classic',
    outputs: ['fingerprint'],
    // its localStorage cache holds API responses, used only with api_key or simple_request (src/utils/cache.ts, src/functions/api.ts:164)
    cacheKeys: [],
    notes: [
      'ThumbmarkJS 1.12.0: its README.md:34-38 says the ThumbmarkJS API, a paid service with a free tier, combines these client-side signals with server-side analysis and goes further than this open-source library.',
    ],
    requests: [
      {
        match: 'https://experimental.thumbmarkjs.com/',
        request: 'GET https://experimental.thumbmarkjs.com/experimental.min.js',
        rate: 'at most 1 in 10,000 runs, and at most once per browser session',
        off: '`new ThumbmarkJS.Thumbmark({ logging: false })`',
        carries: 'no body; the response is a script the library evaluates, whose result goes into the logged sample and not into the id (README.md:97-99, src/utils/experimental.ts:13 and 145-165)',
        where: 'README.md:85 and 93-107 ("Sampled logging"), sampling test in src/functions/index.ts:84, package 1.12.0',
      },
      {
        match: 'https://api.thumbmarkjs.com/log',
        request: 'POST https://api.thumbmarkjs.com/log',
        rate: 'at most 1 in 10,000 runs, and at most once per browser session',
        off: '`new ThumbmarkJS.Thumbmark({ logging: false })`',
        carries: 'JSON with the thumbmark, every component value, the evaluated script\'s result, the library version, the options passed, the page path and any errors (src/utils/log.ts:25-41)',
        where: 'README.md:85 and 93-107 ("Sampled logging"), sampling test in src/functions/index.ts:84, package 1.12.0',
      },
    ],
    call: `new ThumbmarkJS.Thumbmark().get().then(function (r) {
  if (r && r.thumbmark) __stamp('fingerprint')
  __components(r && r.components)
  __answer({ fingerprint: r ? r.thumbmark : null })
}, __fail)`,
  },
  {
    key: 'get-browser-fingerprint',
    name: 'get-browser-fingerprint',
    package: 'get-browser-fingerprint',
    version: '5.2.4',
    integrity: 'sha512-xNqilNCPnD0WqAX9ZH1qIQtUICmLd01mnx4hUxL+TXd2HKa90Q09gEETFlOnu1BCVtpZjP0AZt02R8R85JqxPA==',
    // the package's main: an ES module with a default export, shipped unminified and unbundled
    file: 'package/src/index.js',
    type: 'module',
    unminified: true,
    outputs: ['fingerprint'],
    cacheKeys: [],
    notes: [
      'get-browser-fingerprint 5.2.4 ships its main, src/index.js (package.json:12), unminified and unbundled; a site\'s bundler would minify it, and the bytes section also gives its size minified by this harness.',
    ],
    noRequests: 'documents no request, and src/index.js in 5.2.4 calls none of fetch, XMLHttpRequest, sendBeacon, WebSocket or import()',
    call: `getBrowserFingerprint().then(function (r) {
  if (r && r.fingerprint) __stamp('fingerprint')
  var c = {}
  if (r) for (var k in r) if (k !== 'fingerprint' && k !== 'elapsedMs') c[k] = r[k]
  __components(c)
  __answer({ fingerprint: r ? r.fingerprint : null })
}, __fail)`,
    importName: 'getBrowserFingerprint',
  },
]
