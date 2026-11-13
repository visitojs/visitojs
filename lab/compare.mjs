// Runs VisitoJS and other published fingerprint libraries through the same checks, on the same visits, with default options.
// Usage: node lab/compare.mjs [chromium|firefox|webkit] [--gpu | --private] [--run <n>]
// Then:  node lab/compare/table.mjs lab/report/raw/compare-*.json > table.md
// The other libraries are fetched once with npm pack into lab/compare/cache/ (git-ignored) and checked against the integrity
// pinned in lab/compare/libraries.mjs; the run stops if a tarball differs, and it refuses a VisitoJS build older than src/.
// Nothing leaves the browser: every request to anything but the local server is aborted and recorded, and every WebSocket
// is recorded and closed. --run <n> keeps several runs of one engine apart, so the table can show what changed between them.
import http from 'node:http'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import * as playwright from 'playwright'
import { minify } from 'terser'
import { PHONE } from './phone.mjs'
import { launchFrom } from './launch.mjs'
import { LIBRARIES } from './compare/libraries.mjs'
import { FAULTS, faultScript } from './compare/faults.mjs'
import { fetchPackage } from './compare/package.mjs'
import { baseId, pruneComponents, hintsMatch, HINT_NAMES } from './compare/judge.mjs'
import { hintsFor, conditionContexts } from './compare/contexts.mjs'
import { sha256Of, checkBuild, HARNESS_FILES } from './compare/provenance.mjs'

const engineName = process.argv[2] || 'chromium'
if (!['chromium', 'firefox', 'webkit'].includes(engineName)) throw new Error(`unknown engine "${engineName}": use chromium, firefox or webkit`)
const launch = launchFrom(engineName, process.argv)
const runAt = process.argv.indexOf('--run')
const run = runAt > 0 ? Number(process.argv[runAt + 1]) : null
if (runAt > 0 && !(run >= 1)) throw new Error('--run takes a number from 1')
const RELOADS = 20
const TIMING_RUNS = 21
const ANSWER_WAIT_MS = 30000
const FAULT_WAIT_MS = 15000
// time after an answer for late errors and late requests; longer on the visit where a sampled request is due
const SETTLE_MS = 300
const FORCED_SETTLE_MS = 3000
const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const DESKTOP = { viewport: { width: 1280, height: 720 } }
// Firefox has no mobile emulation in Playwright
const PHONE_CONTEXT = engineName === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE

const git = (...args) => execFileSync('git', args, { cwd: rootPath, encoding: 'utf8' }).trim()
const head = git('rev-parse', '--short', 'HEAD')
const commit = head + (git('status', '--porcelain', '--', 'src', 'rollup.config.mjs', 'package.json', 'tsconfig.json') ? '+changes' : '')
const harness = { commit: head, dirty: !!git('status', '--porcelain', '--', ...HARNESS_FILES), files: HARNESS_FILES }

// the VisitoJS bundle must have been built from the sources in this checkout
function filesUnder(dir) {
  return readdirSync(join(rootPath, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))
}
const mtime = (path) => ({ path: path.replace(/\\/g, '/'), mtimeMs: statSync(join(rootPath, path)).mtimeMs })
for (const lib of LIBRARIES.filter((l) => l.local)) {
  checkBuild(existsSync(join(rootPath, lib.file)) ? mtime(lib.file) : null, [...filesUnder('src'), 'rollup.config.mjs', 'package.json', 'tsconfig.json'].map(mtime))
}

const terserVersion = JSON.parse(readFileSync(new URL('node_modules/terser/package.json', root), 'utf8')).version
const sizes = (bytes) => ({ raw: bytes.length, gzip: gzipSync(bytes).length, brotli: brotliCompressSync(bytes).length })
const libs = []
for (const lib of LIBRARIES) {
  const fetched = lib.local ? { bytes: readFileSync(new URL(lib.file, root)), integrity: null } : fetchPackage(lib, fileURLToPath(new URL('lab/compare/cache/', root)))
  const bytes = fetched.bytes
  let minified
  if (lib.unminified) {
    const out = await minify(bytes.toString('utf8'), { module: lib.type === 'module' })
    minified = { tool: `terser ${terserVersion}`, ...sizes(Buffer.from(out.code)) }
  }
  libs.push({ ...lib, integrity: fetched.integrity, commit: lib.local ? commit : undefined, sha256: sha256Of(bytes), source: bytes, bytes: sizes(bytes), minified })
}

// the page's own helpers: when each output first exists, durations the call measures itself, the first answer, a throw or
// rejection, the values behind an id, and errors that reach the page
const PRELUDE = `window.__h = { t0: performance.now(), stamps: {}, spans: {}, values: null, error: null, answers: 0, escaped: [] };
function __text(x) { try { return String(x && x.message ? x.message : x).slice(0, 200) } catch (e) { return 'unprintable' } }
function __stamp() { var now = performance.now(); for (var i = 0; i < arguments.length; i++) if (!(arguments[i] in __h.stamps)) __h.stamps[arguments[i]] = now }
function __span(name, ms) { if (!(name in __h.spans)) __h.spans[name] = ms }
function __values(components) { var out = {}; try { for (var k in components) out[k] = components[k] && typeof components[k] === 'object' && 'value' in components[k] ? components[k].value : components[k] } catch (e) {} return out }
function __components(x) { if ('components' in __h) return; try { __h.components = x === undefined || x === null ? null : JSON.stringify(x).slice(0, 200000) } catch (e) { __h.components = 'not serialisable' } }
function __answer(values) { __h.answers++; if (__h.answers === 1) { __h.values = values; __h.at = performance.now() } }
function __fail(error) { __h.answers++; if (__h.answers === 1) { __h.error = __text(error); __h.at = performance.now() } }
addEventListener('error', function (e) { __h.escaped.push('error: ' + __text(e.message)) });
addEventListener('unhandledrejection', function (e) { __h.escaped.push('rejection: ' + __text(e.reason)) });`

function page(lib, variant) {
  const call = variant === 'documented' ? lib.documented.call : lib.call
  const head = `<!doctype html><meta charset="utf-8"><title>compare</title><body>\n<script>${PRELUDE}</script>\n`
  if (lib.type === 'module') return head + `<script type="module">import ${lib.importName} from '/lib/${lib.key}.js'\ntry { ${call} } catch (e) { __fail(e) }</script>`
  return head + `<script src="/lib/${lib.key}.js"></script>\n<script>try { ${call} } catch (e) { __fail(e) }</script>`
}

const server = http.createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname
  if (path === '/blank') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>blank</title>')
  const lib = libs.find((l) => path === `/lib/${l.key}.js` || path === `/${l.key}` || (l.documented && path === `/${l.key}/documented`))
  if (!lib) return response.writeHead(404).end()
  if (path.startsWith('/lib/')) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(lib.source)
  response.writeHead(200, { 'content-type': 'text/html' }).end(page(lib, path.endsWith('/documented') ? 'documented' : null))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await playwright[engineName].launch(launch.options)

// Chromium can override the user agent, its client hints and the screen of one tab, so conditions there stay in one context
const PER_TAB = engineName === 'chromium'

/**
 * A context in which every request off the local server is aborted and recorded into bucket, and every WebSocket is
 * recorded and closed. Where the context carries client hints, the tab emulates them with its user agent before any visit.
 * In Chromium the tab's CDP session is returned too, for the conditions applied inside the context.
 */
async function open(ctx, bucket, init) {
  const context = await browser.newContext({ ...ctx.options, serviceWorkers: 'block' })
  await context.route('**/*', (route) => {
    const request = route.request()
    if (request.url().startsWith(base + '/')) return route.continue()
    bucket.requests.push({ method: request.method(), url: request.url() })
    return route.abort()
  })
  await context.routeWebSocket(() => true, (socket) => {
    bucket.requests.push({ method: 'WEBSOCKET', url: socket.url() })
    return socket.close().catch(() => {})
  })
  if (init) await context.addInitScript(init)
  const tab = await context.newPage()
  const cdp = PER_TAB ? await context.newCDPSession(tab) : null
  if (ctx.hints) await overrideUserAgent(cdp, ctx)
  return { context, tab, cdp }
}

const overrideUserAgent = (cdp, ctx) => cdp.send('Emulation.setUserAgentOverride', { userAgent: ctx.options.userAgent, acceptLanguage: ctx.options.locale, userAgentMetadata: ctx.hints })

/** Puts an open tab into the state of a condition planned 'same' (lab/compare/contexts.mjs). */
async function apply(opened, cond) {
  const o = cond.options
  if (cond.via === 'user-agent override') return overrideUserAgent(opened.cdp, cond)
  if (cond.via === 'viewport size') return opened.tab.setViewportSize(o.viewport)
  if (cond.via === 'device metrics') {
    // the metrics Playwright sets for a context with these options, with the screen given apart from the viewport
    const landscape = o.viewport.width > o.viewport.height
    return opened.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: o.viewport.width,
      height: o.viewport.height,
      deviceScaleFactor: o.deviceScaleFactor || 1,
      mobile: !!o.isMobile,
      screenWidth: o.screen.width,
      screenHeight: o.screen.height,
      screenOrientation: o.isMobile ? (landscape ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' }) : { angle: 0, type: 'landscapePrimary' },
    })
  }
  throw new Error(`no way to apply "${cond.via}"`)
}

const withTimeout = (promise, ms, what) => {
  let timer
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(what)), ms) })]).finally(() => clearTimeout(timer))
}

/**
 * One visit: load the page, wait for the first answer, then read what the page recorded.
 * hints: the client hints the context emulates, checked against what the page saw; undefined skips the check (fault visits).
 * expect: the context options whose user agent and screen the page must see; undefined skips that check.
 */
async function visit(tab, lib, bucket, { wait = ANSWER_WAIT_MS, settle = SETTLE_MS, variant = null, hints, expect } = {}) {
  bucket.visits++
  const pageErrors = []
  const onError = (error) => pageErrors.push('pageerror: ' + String(error).slice(0, 200))
  tab.on('pageerror', onError)
  try {
    await tab.goto(`${base}/${lib.key}${variant ? '/' + variant : ''}`, { waitUntil: 'load' })
    await tab.waitForFunction(() => window.__h && window.__h.answers > 0, null, { timeout: wait, polling: 50 }).catch(() => {})
    await tab.waitForTimeout(settle)
    const seen = await withTimeout(
      tab.evaluate(async ({ url, readHints, names }) => {
        // the calls that reached a fault, copied before the reads below can add to them
        const hits = window.__faultHits ? JSON.parse(JSON.stringify(window.__faultHits)) : null
        const h = window.__h
        const entry = performance.getEntriesByName(url)[0]
        let ua = null
        let scr = null
        let size = {}
        let seenHints = null
        try { ua = navigator.userAgent } catch (e) {}
        try { scr = { width: screen.width, height: screen.height } } catch (e) {}
        try { size = { inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio, orientation: screen.orientation ? screen.orientation.type : null } } catch (e) {}
        try {
          const data = navigator.userAgentData
          if (readHints && data) {
            const high = await Promise.race([data.getHighEntropyValues(names), new Promise((resolve) => setTimeout(() => resolve({}), 1000))])
            seenHints = { brands: data.brands, mobile: data.mobile, platform: data.platform }
            for (const name of names) seenHints[name] = high[name]
          }
        } catch (e) {}
        return { values: h.values, error: h.error, answers: h.answers, escaped: h.escaped.slice(), stamps: h.stamps, spans: h.spans, components: h.components, t0: h.t0, at: h.at === undefined ? null : h.at, loaded: entry ? entry.responseEnd : null, ua, scr, ...size, hints: seenHints, hits, faultErrors: window.__faultErrors || [] }
      }, { url: `${base}/lib/${lib.key}.js`, readHints: hints !== undefined, names: HINT_NAMES }),
      5000,
      'the page stopped responding',
    )
    seen.escaped = seen.escaped.concat(pageErrors)
    if (hints !== undefined && !hintsMatch(hints, seen.hints)) seen.harness = `the page saw client hints ${JSON.stringify(seen.hints)}, not the ones emulated`
    // a fault that could not be installed would read as a library meeting it
    if (seen.faultErrors.length) seen.harness = `a fault could not be installed: ${seen.faultErrors.join('; ')}`
    if (expect && seen.ua !== expect.userAgent) seen.harness = `the page saw the user agent "${seen.ua}", not "${expect.userAgent}"`
    if (expect && expect.screen && JSON.stringify(seen.scr) !== JSON.stringify({ width: expect.screen.width, height: expect.screen.height })) seen.harness = `the page saw the screen ${JSON.stringify(seen.scr)}, not ${JSON.stringify(expect.screen)}`
    // time from the end of the script's download, when the engine can start on it, to each output; or the duration the call timed itself
    const start = seen.loaded || seen.t0
    seen.ms = {}
    for (const output of lib.outputs) seen.ms[output] = output in seen.spans ? seen.spans[output] : output in seen.stamps ? seen.stamps[output] - start : null
    return seen
  } catch (error) {
    return { values: null, error: null, harness: error.message.split('\n')[0], escaped: pageErrors, ms: {} }
  } finally {
    tab.off('pageerror', onError)
  }
}

async function once(lib, ctx, bucket, extra = {}) {
  const { context, tab } = await open(ctx, bucket, extra.init)
  try {
    const seen = await visit(tab, lib, bucket, { hints: extra.init ? undefined : ctx.hints, expect: extra.init ? undefined : ctx.options, ...extra })
    if (extra.dropComponents) delete seen.components
    return seen
  } finally {
    await context.close()
  }
}

// the library's stored computed values, removed so that the next visit computes its ids again
const removeCached = (tab, lib) => (lib.cacheKeys.length ? tab.evaluate((keys) => { for (const key of keys) try { localStorage.removeItem(key) } catch (e) {} }, lib.cacheKeys) : null)

/** Reloads in one context; with recompute, the library's stored computed values are removed after every visit. */
async function reloadRun(lib, ctx, bucket, recompute) {
  const { context, tab } = await open(ctx, bucket)
  const reloads = []
  let cleared = null
  try {
    for (let i = 0; i < RELOADS; i++) {
      reloads.push(await visit(tab, lib, bucket, { hints: ctx.hints, expect: ctx.options }))
      if (recompute) await removeCached(tab, lib)
    }
    if (!recompute) {
      await context.clearCookies()
      await tab.evaluate(() => {
        try { localStorage.clear() } catch (e) {}
        try { sessionStorage.clear() } catch (e) {}
      })
      cleared = await visit(tab, lib, bucket, { hints: ctx.hints, expect: ctx.options })
    }
  } finally {
    await context.close()
  }
  return { reloads, cleared }
}

// the window and the layout viewport both kept their size: in Chromium's desktop profile the device-metrics override
// leaves outerWidth at the window's size and moves innerWidth, in its phone profile the reverse can hold
const sameSize = (a, b) => !!(a && b) && ['outer', 'inner'].every((k) => a[k] && b[k] && a[k][0] === b[k][0] && a[k][1] === b[k][1])

/**
 * One condition. Planned 'same': a base visit, the cached values removed, the condition applied, a second visit, all in
 * one context. Planned 'new': one visit in a context of its own. A condition that changes the viewport must show another
 * window size than its base (before: the visit it is compared with, or the first recomputed reload for a new context).
 */
async function conditionRun(lib, plan, key, bucket, before) {
  const cond = plan[key]
  if (!cond) return null
  let result
  if (cond.in === 'new') {
    result = { in: 'new', via: null, base: null, visit: await once(lib, cond, bucket) }
  } else {
    const opened = await open(plan.base, bucket)
    try {
      const first = await visit(opened.tab, lib, bucket, { hints: plan.base.hints, expect: plan.base.options })
      await removeCached(opened.tab, lib)
      await apply(opened, cond)
      result = { in: 'same', via: cond.via, base: first, visit: await visit(opened.tab, lib, bucket, { hints: cond.hints, expect: cond.options }) }
      before = first
    } finally {
      await opened.context.close()
    }
  }
  if (key !== 'uaBump' && sameSize(before, result.visit) && !result.visit.harness) result.visit.harness = `${key}: the window kept the size ${JSON.stringify(result.visit.outer)} and the viewport ${JSON.stringify(result.visit.inner)}`
  return result
}

async function profileRun(lib, plan, bucket) {
  const recomputed = (await reloadRun(lib, plan.base, bucket, true)).reloads
  const shipped = await reloadRun(lib, plan.base, bucket, false)
  const result = { recomputed, reloads: shipped.reloads, cleared: shipped.cleared, second: await once(lib, plan.second, bucket), conditions: {} }
  for (const key of ['uaBump', 'rotation', 'viewport']) result.conditions[key] = await conditionRun(lib, plan, key, bucket, recomputed[0])
  // components stay only where an id differs from the base, plus the base's once, so a change can be traced
  const output = lib.outputs[0]
  const conditions = Object.values(result.conditions).filter(Boolean).flatMap((c) => [c.base, c.visit])
  const all = [result.recomputed, result.reloads, [result.cleared, result.second], conditions].flat().filter(Boolean)
  result.baseComponents = pruneComponents(all, output, baseId(recomputed.map((v) => (v.values ? v.values[output] : null))))
  return result
}

/** What a context reports before any override: user agent, screen and, where the browser has them, its client hints. */
async function probe(options, withHints) {
  const { context, tab } = await open({ options, hints: null }, bucketOf())
  try {
    await tab.goto(`${base}/blank`)
    return await tab.evaluate(async (readHints) => {
      const data = navigator.userAgentData
      let hints = null
      if (readHints && data) {
        const high = await data.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64', 'formFactors'])
        hints = { brands: data.brands, fullVersionList: high.fullVersionList, platform: data.platform, platformVersion: high.platformVersion, architecture: high.architecture, model: high.model, mobile: data.mobile, bitness: high.bitness, wow64: high.wow64, formFactors: high.formFactors }
      }
      return { ua: navigator.userAgent, screen: { width: screen.width, height: screen.height }, hints }
    }, withHints)
  } finally {
    await context.close()
  }
}

/** The faults whose every edit is on a property this engine lacks, so that they change nothing here: { name: [properties] }. */
async function absentHere(options) {
  const { context, tab } = await open({ options, hints: null }, bucketOf())
  try {
    await tab.goto(`${base}/blank`)
    return await tab.evaluate((faults) => {
      const out = {}
      for (const fault of faults) {
        if (!fault.edits.length) continue
        const missing = fault.edits.filter(([target, prop]) => {
          let object = null
          try { object = (0, eval)(target) } catch (e) {}
          return !(object && prop in object)
        })
        if (missing.length === fault.edits.length) out[fault.name] = missing.map((edit) => edit[1])
      }
      return out
    }, FAULTS.map((f) => ({ name: f.name, edits: f.edits })))
  } finally {
    await context.close()
  }
}

const bucketOf = () => ({ visits: 0, requests: [] })
const results = {}
let clockStepMs = null
let own
let plans
let absent = {}
try {
  // client hints are emulated only where the browser has them; there every context carries the ones matching its user agent
  own = await probe(DESKTOP, engineName === 'chromium')
  const phoneProbe = await probe(PHONE_CONTEXT, false)
  absent = await absentHere(DESKTOP)
  const hints = (ua, device) => hintsFor(own.hints, own.ua, ua, device)
  plans = {
    phone: conditionContexts({ options: PHONE_CONTEXT, userAgent: PHONE.userAgent, screen: phoneProbe.screen, rotation: true, hints, perTab: PER_TAB, reduced: true }),
    desktop: conditionContexts({ options: DESKTOP, userAgent: own.ua, screen: own.screen, rotation: false, hints, perTab: PER_TAB }),
  }
  for (const lib of libs) {
    const network = { default: bucketOf(), forced: bucketOf(), faults: bucketOf() }
    const profiles = {
      phone: await profileRun(lib, plans.phone, network.default),
      desktop: await profileRun(lib, plans.desktop, network.default),
    }
    // a request sent only on a random sample of calls is due when Math.random() returns 0
    const forced = await once(lib, plans.desktop.base, network.forced, { init: 'Math.random = function () { return 0 }', settle: FORCED_SETTLE_MS, dropComponents: true })
    const faults = []
    for (const fault of FAULTS) {
      // a baseline visit is checked like a profile visit; a fault may break the very reads the check makes
      const ctx = fault.profile === 'reduced' ? plans.phone.reduced : plans.phone.base
      const checks = fault.edits.length ? { hints: undefined, expect: undefined } : { hints: ctx.hints, expect: ctx.options }
      const seen = await once(lib, ctx, network.faults, { init: faultScript(fault.edits), wait: FAULT_WAIT_MS, dropComponents: true, ...checks })
      faults.push({ fault: fault.name, ...seen })
    }
    results[lib.key] = { profiles, network, forcedVisit: forced, faults, timing: [], timingVisits: [], documentedTiming: lib.documented ? [] : undefined, documentedVisits: lib.documented ? [] : undefined }
    const p = profiles.phone.recomputed[0]
    console.log(`${lib.name.padEnd(24)} phone reload 1: ${p.values ? JSON.stringify(p.values) : 'no answer'}${p.error ? ' error ' + p.error : ''}${p.escaped.length ? ' escaped ' + p.escaped.join(' | ') : ''}`)
  }
  // timing: a new context per run on the same blank page, desktop profile, the order rotated so that no library always runs first
  for (let n = 0; n < TIMING_RUNS; n++) {
    for (let k = 0; k < libs.length; k++) {
      const lib = libs[(n + k) % libs.length]
      const seen = await once(lib, plans.desktop.base, results[lib.key].network.default, { dropComponents: true })
      results[lib.key].timingVisits.push(seen)
      results[lib.key].timing.push(seen.ms)
    }
  }
  // the call pattern a library documents, where it differs from one call when the script ends, in runs of its own
  for (let n = 0; n < TIMING_RUNS; n++) {
    for (const lib of libs.filter((l) => l.documented)) {
      const seen = await once(lib, plans.desktop.base, results[lib.key].network.default, { variant: 'documented', settle: SETTLE_MS, dropComponents: true })
      results[lib.key].documentedVisits.push(seen)
      results[lib.key].documentedTiming.push(seen.ms)
    }
  }
  // the smallest step the page's clock takes bounds every timing above (engines coarsen it on purpose)
  const clock = await open(plans.desktop.base, bucketOf())
  await clock.tab.goto(`${base}/blank`)
  clockStepMs = await clock.tab.evaluate(() => {
    let step = Infinity
    let last = performance.now()
    for (let i = 0; i < 200000 && step > 0.0001; i++) {
      const now = performance.now()
      if (now > last) {
        step = Math.min(step, now - last)
        last = now
      }
    }
    return Math.round(step * 1e6) / 1e6
  })
  await clock.context.close()
} finally {
  await browser.close()
  server.close()
}

const playwrightVersion = JSON.parse(readFileSync(new URL('node_modules/playwright/package.json', root), 'utf8')).version
const report = {
  schema: 3,
  date: new Date().toISOString(),
  engine: engineName,
  launch: { suffix: launch.suffix, label: launch.label },
  run,
  browserVersion: browser.version(),
  os: `${os.platform()} ${os.release()} ${os.arch()}`,
  playwright: playwrightVersion,
  node: process.version,
  harness,
  headless: launch.options.headless !== false,
  absent,
  clockStepMs,
  clientHints: own.hints ? { ua: own.ua, own: own.hints } : null,
  contexts: plans,
  settings: { reloads: RELOADS, timingRuns: TIMING_RUNS, answerWaitMs: ANSWER_WAIT_MS, faultWaitMs: FAULT_WAIT_MS, settleMs: SETTLE_MS, forcedSettleMs: FORCED_SETTLE_MS, phone: PHONE, faults: FAULTS },
  libraries: libs.map(({ source, call, ...lib }) => ({ ...lib, documented: lib.documented ? { label: lib.documented.label, method: lib.documented.method } : undefined })),
  results,
}
mkdirSync(new URL('lab/report/raw/', root), { recursive: true })
const out = new URL(`lab/report/raw/compare-${engineName}${launch.suffix}${run ? '-run' + run : ''}.json`, root)
writeFileSync(out, JSON.stringify(report, null, 1))
console.log(`\n${engineName}${launch.label} ${browser.version()}: wrote ${fileURLToPath(out)}`)
// a visit the harness itself could not read, or one that did not see the user agent, screen or client hints planned, would show as a result: fail the run
const broken = []
for (const [key, r] of Object.entries(results)) {
  const all = [...r.faults, ...r.timingVisits, ...(r.documentedVisits || []), r.forcedVisit]
  for (const profile of [r.profiles.phone, r.profiles.desktop]) {
    all.push(...profile.recomputed, ...profile.reloads, profile.cleared, profile.second)
    for (const c of Object.values(profile.conditions)) if (c) all.push(c.base, c.visit)
  }
  for (const seen of all) if (seen && seen.harness) broken.push(`${key}: ${seen.harness}`)
}
if (broken.length) {
  console.log(`harness errors in ${broken.length} visits:\n  ${[...new Set(broken)].join('\n  ')}`)
  process.exit(1)
}
