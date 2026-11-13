// Checks that a real engine is classified as itself, from the reading alone: the engine, Android, and the exclusions that follow.
// The answers come from the browser's own version (lab/engine-truth.mjs), so a rewrite of the detection is held to them.
// Usage: node lab/engines.mjs [chromium|firefox|webkit] [--channel <name>] [--executable <path>] [--evidence]
//   (DIST=<folder> runs it on other builds, to prove it fails on a broken one)
// --evidence is the weekly drift run (.github/workflows/browser-drift.yml): it also checks every engine test the lab build records against
// the table in lab/engine-truth.mjs, and the private-window canary. Without it the run is the pull-request check it always was.
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as playwright from 'playwright'
import { PHONE } from './phone.mjs'
import { problems } from './schema.mjs'
import { KNOWN, exitCode, expected, judge, report, storage, tally } from './engine-truth.mjs'
import { askDirectory, askPersist, launchOptions, openContext, overBidi, readOnce, startWithin, within } from './engine-read.mjs'

const options = launchOptions(process.argv.slice(2))
const engineName = options.engine
// Mozilla's builds over WebDriver BiDi: their private-window canary is printed as UNVERIFIED, never counted (storage() in lab/engine-truth.mjs)
const bidi = overBidi(options)
// refuse a bad engine name or a KNOWN entry that applies nowhere before a browser starts
tally([], KNOWN, engineName)
const dist = process.env.DIST ? pathToFileURL(process.env.DIST.replace(/\/?$/, '/')) : new URL('../dist/', import.meta.url)
const BUILDS = { product: '/visito.min.js', lab: '/visito.lab.min.js' }
const FILES = { '/visito.min.js': readFileSync(new URL('visito.min.js', dist)), '/visito.lab.min.js': readFileSync(new URL('visito.lab.min.js', dist)) }
const page = (file) => `<!doctype html><meta charset="utf-8"><title>engines</title><body><script src="${file}"></script>`

// two synthetic phone user agents on a desktop viewport, so the reading has no model and stays weak; every engine gets both, so an answer taken from the user agent fails
const DECOYS = {
  'firefox-ua': 'Mozilla/5.0 (Android 15; Mobile; rv:146.0) Gecko/146.0 Firefox/146.0',
  'safari-ua': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
}
// Firefox has no mobile emulation in Playwright
const phone = engineName === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE
const PROFILES = [
  { name: 'desktop', options: {}, weak: true },
  { name: 'phone', options: phone, weak: false },
  ...Object.keys(DECOYS).map((name) => ({ name, options: { userAgent: DECOYS[name] }, weak: true })),
]
// a rewrite that stops calling back must fail with a named check, not hang the job
const WAIT = 10000
// the page's own timer cannot fire while its main thread is blocked, so loading the page and asking it for the reading run under a Node-side limit, as does closing it
const LIMIT = WAIT + 2000
// for starting the private browser: Playwright's own limit is 180 s, longer than a drift step should spend on one launch
const START = 60000

// the user agent the last page request carried, for the record when the page never answers
let requested = null
const server = http.createServer((request, response) => {
  if (FILES[request.url]) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[request.url])
  // a page with no library on it, where the canary asks getDirectory() itself
  if (request.url === '/blank') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>blank</title>')
  const build = request.url.slice(1)
  if (!BUILDS[build]) return response.writeHead(404).end()
  requested = request.headers['user-agent'] || null
  response.writeHead(200, { 'content-type': 'text/html' }).end(page(BUILDS[build]))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await playwright[engineName].launch(options.launch)
const version = browser.version()
const label = `${options.label} ${version}`
const checks = []
const readings = []
const notes = []

/**
 * One reading in a fresh context, and, when asked, how getDirectory() and, in Firefox, storage.persist() settle there in a page without the library.
 * A browser that refuses a context's options (a WebDriver BiDi Firefox may), or never opens it, fails that reading by name instead of ending the run.
 */
async function visit(target, contextOptions, build, name, askStorage) {
  const { context, error } = await openContext(target, contextOptions, LIMIT)
  if (!context) return { reading: null, userAgent: null, error, directory: undefined, persist: undefined }
  const got = await readOnce(context, url + build, { wait: WAIT, limit: LIMIT })
  const directory = askStorage ? await askDirectory(context, url + 'blank', LIMIT) : undefined
  // what shows a Firefox session is private, and its control in a normal window
  const persist = askStorage && engineName === 'firefox' ? await askPersist(context, url + 'blank', LIMIT) : undefined
  if (!(await within(context.close(), LIMIT))) notes.push(`${build} ${name}: the context did not close within ${LIMIT / 1000} s`)
  return { ...got, directory, persist }
}

try {
  for (const profile of PROFILES) {
    for (const build of Object.keys(BUILDS)) {
      // a fresh context per reading: the product build would otherwise answer from its cache
      requested = null
      // the canary's control, in the drift run only: a normal window's own answer
      const askStorage = options.evidence && build === 'lab' && profile.name === 'desktop' && engineName !== 'chromium'
      const { reading, error, userAgent, directory, persist } = await visit(browser, profile.options, build, profile.name, askStorage)
      // the user agent the page reported, or the one its request carried when it never answered
      readings.push({ build, profile: profile.name, userAgent: userAgent || requested, error, reading })
      const schema = reading ? problems(reading) : undefined
      checks.push(...judge({ engine: engineName, version, build, profile: profile.name, weak: profile.weak, reading, error, schema, evidence: options.evidence }))
      if (options.evidence && build === 'lab') checks.push(...storage({ engine: engineName, version, profile: profile.name, reading, error, directory, persist, bidi }))
    }
  }
} finally {
  if (!(await within(browser.close(), LIMIT))) notes.push(`the browser did not close within ${LIMIT / 1000} s`)
}

// the private-window canary: Firefox with the preference behind "Always use private browsing mode", where every window is private.
// The day getDirectory() opens there, the library's Gecko answer stops being evidence (docs/DECISIONS.md, "The in-memory-session check").
// It counts only where storage.persist() shows the session is private, and only in Playwright's own Firefox. A browser that will not start
// in this mode is one failing check; every other check of this browser is still printed, and the raw report still written
if (options.evidence && engineName === 'firefox') {
  const launch = { ...options.launch, timeout: START, firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } }
  const { browser: privately, error: refused } = await startWithin(() => playwright.firefox.launch(launch), START)
  if (!privately) checks.push(...storage({ engine: engineName, version, profile: 'private', launch: refused, bidi }))
  else {
    try {
      const { reading, error, userAgent, directory, persist } = await visit(privately, {}, 'lab', 'private', true)
      readings.push({ build: 'lab', profile: 'private', userAgent, error, reading, directory, persist })
      checks.push(...storage({ engine: engineName, version, profile: 'private', reading, error, directory, persist, bidi }))
    } finally {
      if (!(await within(privately.close(), LIMIT))) notes.push(`the private browser did not close within ${LIMIT / 1000} s`)
    }
  }
}
server.close()

const result = tally(checks, KNOWN, engineName)
writeFileSync(
  new URL(`./report/raw/engines-${options.tag}.json`, import.meta.url),
  JSON.stringify({ engine: engineName, channel: options.channel, executable: options.executable, version, expected: expected(engineName, version), checks, stale: result.stale, partly: result.partly, readings }, null, 1),
)

if (options.executable) console.log(`NOTE  ${label} runs ${options.executable}`)
for (const c of checks) for (const line of report(c, label)) console.log(line)
for (const note of notes) console.log(`NOTE  ${label} ${note}`)
for (const entry of result.stale) console.log(`STALE the known failure "${entry.id}" no longer fails: remove it from KNOWN in lab/engine-truth.mjs`)
for (const { entry, passing } of result.partly) console.log(`STALE the known failure "${entry.id}" is partly stale, these checks pass: ${passing.join(', ')}; narrow it in lab/engine-truth.mjs to what still fails`)
const stale = result.stale.length + result.partly.length
// printed with what was seen and wanted, counted neither as a pass nor as a failure
const unverified = checks.filter((check) => check.state === 'UNVERIFIED').length
console.log(`\n${label}: ${checks.length - result.failed - result.known - unverified} of ${checks.length} engine checks pass` + (result.known ? `, ${result.known} KNOWN FAILURES tolerated` : '') + (unverified ? `, ${unverified} UNVERIFIED (not evidence)` : '') + (stale ? `, ${stale} stale tolerances` : ''))
process.exit(exitCode(result))
