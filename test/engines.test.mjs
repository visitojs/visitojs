import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KNOWN, TESTS, evidence, exitCode, expected, judge, report, storage, tally } from '../lab/engine-truth.mjs'
import { askDirectory, askPersist, launchOptions, openContext, overBidi, readOnce, startWithin, within } from '../lab/engine-read.mjs'

// a weak desktop reading as the library builds it: no model, so screen and cores stand in
const weak = (engine, scr = '1280x720', cores = 8, mem = 8) => ({
  v: 3,
  c: { 'hw.model': '!na', 'hw.mem': mem, 'hw.scr': scr, 'hw.cores': cores, 'x.engine': engine, 'x.android': false },
})
const strong = (engine) => ({ v: 3, c: { 'hw.model': 'SM-X135FU', 'hw.mem': 8, 'x.engine': engine, 'x.android': false } })
const states = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.state]))
const run = (engine, version, reading, extra = {}) =>
  judge({ engine, version, build: 'product', profile: 'desktop', weak: true, reading, known: [], ...extra })

test('Chromium must read as Blink, not Android, with nothing excluded', () => {
  assert.deepEqual(expected('chromium', '149.0.7795.2'), { engine: 'blink', android: false, excluded: { mem: false, scr: false, cores: false } })
})

test('Firefox excludes screen and cores from version 143 on, and memory never', () => {
  assert.deepEqual(expected('firefox', '142.0.1').excluded, { mem: false, scr: false, cores: false })
  assert.deepEqual(expected('firefox', '143.0').excluded, { mem: false, scr: true, cores: true })
  assert.deepEqual(expected('firefox', '146.0b3').excluded, { mem: false, scr: true, cores: true })
  assert.equal(expected('firefox', '146.0').engine, 'gecko')
})

test('WebKit excludes the screen from version 17 on, Safari or not, and memory and cores never', () => {
  assert.deepEqual(expected('webkit', '26.0'), { engine: 'webkit', android: false, excluded: { mem: false, scr: true, cores: false } })
  assert.deepEqual(expected('webkit', '17.0').excluded, { mem: false, scr: true, cores: false })
  assert.deepEqual(expected('webkit', '16.4').excluded, { mem: false, scr: false, cores: false })
})

test('an unknown engine name or an unreadable version is a usage error, not a pass', () => {
  assert.throws(() => expected('safari', '26.0'), /engine/)
  assert.throws(() => expected('toString', '26.0'), /engine/)
  assert.throws(() => expected('firefox', 'nightly'), /version/)
})

test('a correct weak Chromium reading passes every check', () => {
  const checks = run('chromium', '149.0', weak('blink'))
  assert.ok(checks.length >= 5)
  assert.ok(checks.every((c) => c.state === 'ok'), JSON.stringify(checks))
})

test('the wrong engine, an Android answer and a missed exclusion each fail their own check', () => {
  assert.equal(states(run('chromium', '149.0', weak('gecko')))['chromium/product/desktop/x.engine'], 'FAIL')
  const android = weak('blink')
  android.c['x.android'] = true
  assert.equal(states(run('chromium', '149.0', android))['chromium/product/desktop/x.android'], 'FAIL')
  const firefox = states(run('firefox', '146.0', weak('gecko')))
  assert.equal(firefox['firefox/product/desktop/hw.scr'], 'FAIL')
  assert.equal(firefox['firefox/product/desktop/hw.cores'], 'FAIL')
  assert.equal(firefox['firefox/product/desktop/hw.mem'], 'ok')
  assert.ok(Object.values(states(run('firefox', '146.0', weak('gecko', '!ex', '!ex', '!na')))).every((s) => s === 'ok'))
})

test('an exclusion where the browser has none fails', () => {
  const checks = states(run('chromium', '149.0', weak('blink', '!ex', 8, '!ex')))
  assert.equal(checks['chromium/product/desktop/hw.scr'], 'FAIL')
  assert.equal(checks['chromium/product/desktop/hw.mem'], 'FAIL')
  assert.equal(checks['chromium/product/desktop/hw.cores'], 'ok')
})

test('a reading that should be weak but is not fails instead of skipping the exclusion checks', () => {
  const checks = states(run('firefox', '146.0', strong('gecko')))
  assert.equal(checks['firefox/product/desktop/weak'], 'FAIL')
})

test('a reading with a model checks memory and leaves screen and cores alone', () => {
  const checks = run('chromium', '149.0', strong('blink'), { profile: 'phone', weak: false })
  assert.ok(checks.some((c) => c.id === 'chromium/product/phone/hw.mem'))
  assert.ok(checks.every((c) => c.state === 'ok'), JSON.stringify(checks))
  assert.ok(!checks.some((c) => /hw\.(scr|cores)$/.test(c.id)))
})

test('no reading at all fails', () => {
  const checks = run('webkit', '26.0', null)
  assert.ok(checks.length && checks.every((c) => c.state === 'FAIL'))
})

test('every check line names the observed and the expected value', () => {
  const checks = run('chromium', '149.0', weak('blink'))
  assert.ok(checks.length)
  for (const c of checks) {
    assert.ok('observed' in c && 'expected' in c, c.id)
    assert.match(c.name, /\S/)
  }
})

test('a known failure is reported as known and tolerated; a tolerance that no longer applies fails', () => {
  const known = [{ id: 'webkit/*/desktop/hw.scr', observed: '"1280x720"', why: 'the detection misses the Safari 17 level in the test build' }]
  const wrong = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit'), known })
  assert.equal(states(wrong)['webkit/lab/desktop/hw.scr'], 'KNOWN')
  assert.deepEqual(tally(wrong, known, 'webkit'), { failed: 0, known: 1, stale: [], partly: [] })

  const right = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit', '!ex'), known })
  assert.equal(states(right)['webkit/lab/desktop/hw.scr'], 'ok')
  assert.deepEqual(tally(right, known, 'webkit').stale, known, 'a fixed case must have its tolerance removed')

  // a tolerance for another engine is not stale here
  assert.deepEqual(tally(run('chromium', '149.0', weak('blink')), known, 'chromium').stale, [])
})

test('a tolerance never hides a different failure', () => {
  const known = [{ id: 'webkit/*/desktop/hw.scr', observed: '"1280x720"', why: 'x' }]
  const checks = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('gecko'), known })
  assert.equal(states(checks)['webkit/lab/desktop/hw.scr'], 'KNOWN')
  assert.equal(states(checks)['webkit/lab/desktop/x.engine'], 'FAIL')
  assert.equal(tally(checks, known, 'webkit').failed, 1)
})

test('a tolerance with a wildcard engine goes stale in every engine where its case passes', () => {
  const known = [{ id: '*/*/desktop/hw.scr', observed: '"1280x720"', why: 'x' }]
  const wrong = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit'), known })
  assert.deepEqual(tally(wrong, known, 'webkit'), { failed: 0, known: 1, stale: [], partly: [] })
  const right = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit', '!ex'), known })
  assert.deepEqual(tally(right, known, 'webkit').stale, known)
  assert.deepEqual(tally(run('chromium', '149.0', weak('blink'), { known }), known, 'chromium').stale, known)
  // a partial wildcard applies only to the engines it matches
  const partial = [{ id: 'web*/*/desktop/hw.scr', observed: '"1280x720"', why: 'x' }]
  assert.deepEqual(tally(right, partial, 'webkit').stale, partial)
  assert.deepEqual(tally(run('chromium', '149.0', weak('blink')), partial, 'chromium').stale, [])
})

test('a wildcard tolerance that also matches a passing check is partly stale and must be narrowed', () => {
  // the product build is fixed, the lab build still names the wrong engine
  const known = [{ id: 'chromium/*/*/x.engine', observed: '"blinq"', why: 'x' }]
  const checks = ['desktop', 'firefox-ua'].flatMap((profile) => [
    ...judge({ engine: 'chromium', version: '153.0', build: 'product', profile, weak: true, reading: weak('blink'), known }),
    ...judge({ engine: 'chromium', version: '153.0', build: 'lab', profile, weak: true, reading: weak('blinq'), known }),
  ])
  assert.deepEqual(tally(checks, known, 'chromium'), {
    failed: 0,
    known: 2,
    stale: [],
    partly: [{ entry: known[0], passing: ['chromium/product/desktop/x.engine', 'chromium/product/firefox-ua/x.engine'] }],
  })
  // narrowed to what still fails, it is neither stale nor partly stale
  const narrow = [{ id: 'chromium/lab/*/x.engine', observed: '"blinq"', why: 'x' }]
  const narrowed = ['desktop', 'firefox-ua'].flatMap((profile) => [
    ...judge({ engine: 'chromium', version: '153.0', build: 'product', profile, weak: true, reading: weak('blink'), known: narrow }),
    ...judge({ engine: 'chromium', version: '153.0', build: 'lab', profile, weak: true, reading: weak('blinq'), known: narrow }),
  ])
  assert.deepEqual(tally(narrowed, narrow, 'chromium'), { failed: 0, known: 2, stale: [], partly: [] })
  // a tolerance for another engine is not partly stale here, and a fully fixed case is stale, not partly stale
  assert.deepEqual(tally(checks, [{ id: 'webkit/*/*/x.engine', observed: '"blinq"', why: 'x' }], 'chromium').partly, [])
  const fixed = judge({ engine: 'chromium', version: '153.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('blink'), known })
  assert.deepEqual(tally(fixed, known, 'chromium'), { failed: 0, known: 0, stale: known, partly: [] })
})

test('a tally without the engine, or with a tolerance that names no engine, is a usage error, not a pass', () => {
  const known = [{ id: 'webkit/*/desktop/hw.scr', observed: '"1280x720"', why: 'x' }]
  const right = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit', '!ex'), known })
  // without the engine a literal tolerance could never be stale
  assert.throws(() => tally(right, known), /engine/)
  assert.throws(() => tally(right, known, 'safari'), /engine/)
  // a misspelt engine segment applies nowhere, so it would never be stale in any run
  for (const id of ['WebKit/*/desktop/hw.scr', 'chrome/*/desktop/hw.scr']) {
    assert.throws(() => tally(right, [{ id, observed: '"1280x720"', why: 'x' }], 'webkit'), /engine/, id)
    assert.throws(() => tally(run('chromium', '149.0', weak('blink')), [{ id, observed: '"1280x720"', why: 'x' }], 'chromium'), /engine/, id)
  }
})

test('a tolerance covers only the wrong value it names; any other wrong value fails and the tolerance goes stale', () => {
  const known = [{ id: 'webkit/*/desktop/hw.scr', observed: '"1280x720"', why: 'x' }]
  const reading = weak('webkit')
  delete reading.c['hw.scr']
  const checks = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading, known })
  assert.equal(states(checks)['webkit/lab/desktop/hw.scr'], 'FAIL')
  assert.deepEqual(tally(checks, known, 'webkit'), { failed: 1, known: 0, stale: known, partly: [] })
  // an entry that names no value tolerates nothing
  const vague = [{ id: 'webkit/*/desktop/hw.scr', why: 'x' }]
  const wrong = judge({ engine: 'webkit', version: '26.0', build: 'lab', profile: 'desktop', weak: true, reading: weak('webkit'), known: vague })
  assert.equal(states(wrong)['webkit/lab/desktop/hw.scr'], 'FAIL')
})

test('the schema check fails a malformed reading and can be tolerated like any other check', () => {
  const bad = run('chromium', '149.0', weak('blink'), { schema: ['did', 'flags.weak'] })
  assert.equal(bad[0].id, 'chromium/product/desktop/schema')
  assert.equal(bad[0].state, 'FAIL')
  assert.equal(bad[0].observed, 'did; flags.weak')
  assert.equal(states(run('chromium', '149.0', weak('blink'), { schema: [] }))['chromium/product/desktop/schema'], 'ok')
  const known = [{ id: 'chromium/product/desktop/schema', observed: 'did', why: 'x' }]
  const tolerated = run('chromium', '149.0', weak('blink'), { schema: ['did'], known })
  assert.deepEqual(tally(tolerated, known, 'chromium'), { failed: 0, known: 1, stale: [], partly: [] })
})

test('when no reading came back the error is the observed value and nothing reads as ok', () => {
  const checks = run('firefox', '155.0', null, { schema: [], error: 'page.goto: net::ERR_CONNECTION_REFUSED' })
  assert.ok(checks.length && checks.every((c) => c.state === 'FAIL'), JSON.stringify(checks))
  assert.equal(states(checks)['firefox/product/desktop/reading'], 'FAIL')
  assert.match(checks.find((c) => c.id.endsWith('/reading')).observed, /ERR_CONNECTION_REFUSED/)
})

test('every entry in KNOWN names an id of four segments, the wrong value it tolerates and why', () => {
  for (const entry of KNOWN) {
    assert.equal(typeof entry.id, 'string')
    assert.equal(entry.id.split('/').length, 4, entry.id)
    assert.equal(typeof entry.observed, 'string', entry.id)
    assert.match(entry.why, /\S/, entry.id)
  }
})

// one reading, driven through a stand-in for a Playwright context: the page runs the evaluated function here, against a stand-in Visito,
// and a page whose main thread is blocked is a step that never answers
const never = () => new Promise(() => {})
const asksForReading = (fn) => String(fn).includes('Visito.get')
const runHere = (fn, arg) => Promise.resolve().then(() => fn(arg))
const LIMITS = { wait: 100, limit: 300 }
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
async function readFake({ load = () => Promise.resolve(), evaluate = runHere, get } = {}) {
  const gotos = []
  const context = { newPage: async () => ({ goto: (address, options) => (gotos.push(options), load(options)), evaluate }) }
  globalThis.Visito = { get }
  const before = timers()
  const started = Date.now()
  try {
    const got = await readOnce(context, 'http://127.0.0.1:1/product', LIMITS)
    const checks = judge({ engine: 'chromium', version: '153.0', build: 'product', profile: 'desktop', weak: true, reading: got.reading, error: got.error, known: [] })
    return { ...got, ms: Date.now() - started, timersLeft: timers() - before, gotos, check: checks.find((c) => c.id.endsWith('/reading')), exit: exitCode(tally(checks, [], 'chromium')) }
  } finally {
    delete globalThis.Visito
  }
}
const blockedWithin = (got, step) => {
  assert.ok(got.ms < LIMITS.limit + 200, `ended after ${got.ms} ms`)
  assert.equal(got.reading, null)
  assert.equal(got.error, `the page did not answer within 0.3 s while ${step}: its main thread is blocked`)
  assert.equal(got.check.state, 'FAIL')
  assert.equal(got.check.observed, got.error)
  assert.equal(got.exit, 1)
  assert.equal(got.timersLeft, 0, 'the Node timer is cleared')
}

test('a page that blocks at script start never fires load; the run ends within the limit with a named failure', { timeout: 3000 }, async () => {
  const got = await readFake({ load: never })
  blockedWithin(got, 'loading the page')
  // the browser's own navigation limit is no longer than the harness's
  assert.ok(got.gotos.length === 1 && got.gotos[0].timeout > 0 && got.gotos[0].timeout <= LIMITS.limit, JSON.stringify(got.gotos))
})

test('a page that blocks after load, before the harness asks for the reading, ends within the limit with a named failure', { timeout: 3000 }, async () => {
  blockedWithin(await readFake({ evaluate: never }), 'asking for the reading')
})

test('a page that blocks inside the reading callback ends within the limit with a named failure', { timeout: 3000 }, async () => {
  // the callback runs, then the page blocks, so the answer never leaves it; anything else the page is asked still answers
  const get = (callback) => callback(weak('blink'))
  blockedWithin(await readFake({ get, evaluate: (fn, arg) => (asksForReading(fn) ? runHere(fn, arg).then(never) : runHere(fn, arg)) }), 'asking for the reading')
})

test('a reading that comes back empty at once is reported as empty, not as a timeout', { timeout: 3000 }, async () => {
  const got = await readFake({ get: (callback) => callback(null) })
  assert.ok(got.ms < LIMITS.wait, `ended after ${got.ms} ms`)
  assert.equal(got.error, 'the reading was empty: Visito.get called back with null')
  assert.equal(got.check.state, 'FAIL')
  assert.equal(got.exit, 1)
  assert.equal(got.timersLeft, 0)
})

test('a page that never calls back fails after its own wait', { timeout: 3000 }, async () => {
  const got = await readFake({ get: () => {} })
  assert.ok(got.ms >= LIMITS.wait - 5 && got.ms < LIMITS.limit, `ended after ${got.ms} ms`)
  assert.equal(got.error, 'no reading within 0.1 s')
  assert.equal(got.exit, 1)
  assert.equal(got.timersLeft, 0)
})

test('an evaluate that rejects is reported with its first line and leaves no Node timer behind', { timeout: 3000 }, async () => {
  // the page crashes while it is asked for the reading
  const crash = () => Promise.reject(new Error('page.evaluate: Target crashed\n  at somewhere'))
  const got = await readFake({ evaluate: (fn, arg) => (asksForReading(fn) ? crash() : runHere(fn, arg)) })
  assert.equal(got.error, 'page.evaluate: Target crashed')
  assert.equal(got.check.state, 'FAIL')
  assert.equal(got.exit, 1)
  assert.equal(got.timersLeft, 0, 'the Node timer is cleared')
})

test('a page that answers gives its reading and the user agent it reports, and passes', { timeout: 3000 }, async () => {
  const got = await readFake({ get: (callback) => callback(weak('blink')) })
  assert.equal(got.error, null)
  assert.deepEqual(got.reading, weak('blink'))
  assert.equal(got.userAgent, navigator.userAgent)
  assert.equal(got.check, undefined, 'no reading check when a reading came back')
  assert.equal(got.exit, 0)
  assert.equal(got.timersLeft, 0)
})

test('closing waits no longer than the limit, says whether it finished, and leaves no Node timer behind', { timeout: 3000 }, async () => {
  const before = timers()
  assert.equal(await within(Promise.resolve(), 300), true)
  assert.equal(await within(Promise.reject(new Error('already closed')), 300), true)
  const started = Date.now()
  assert.equal(await within(never(), 50), false)
  assert.ok(Date.now() - started < 250)
  assert.equal(timers() - before, 0)
})

// The drift run (.github/workflows/browser-drift.yml): the same readings in newer browsers, with every engine test the lab build records checked by name

// the marks each pinned build gave in lab/engines.mjs (Playwright 1.63.0, 2026-11-13), as a lab reading carries them
const MARKS = {
  chromium: { 'x.ev.blink': '11111', 'x.ev.webkit': '00000', 'x.ev.gecko': '00000', 'x.ev.android': '00110', 'x.ev.safari17': '11111', 'x.ev.firefox143': '111', 'x.ev.brave': '0' },
  firefox: { 'x.ev.blink': '00000', 'x.ev.webkit': '00000', 'x.ev.gecko': '11111', 'x.ev.android': '00110', 'x.ev.safari17': '11111', 'x.ev.firefox143': '111', 'x.ev.brave': '0' },
  webkit: { 'x.ev.blink': '00000', 'x.ev.webkit': '11111', 'x.ev.gecko': '00000', 'x.ev.android': '10000', 'x.ev.safari17': '11111', 'x.ev.firefox143': '101', 'x.ev.brave': '0' },
}
const ENGINE = { chromium: 'blink', firefox: 'gecko', webkit: 'webkit' }
const VERSION = { chromium: '153.0.8010.12', firefox: '155.0', webkit: '26.6' }
const labReading = (engine, change = {}) => {
  const reading = weak(ENGINE[engine], engine === 'chromium' ? '1280x720' : '!ex', engine === 'firefox' ? '!ex' : 8)
  Object.assign(reading.c, MARKS[engine], change)
  return reading
}
const labRun = (engine, reading, extra = {}) =>
  judge({ engine, version: VERSION[engine], build: 'lab', profile: 'desktop', weak: true, reading, known: [], evidence: true, ...extra })
const evidenceChecks = (checks) => checks.filter((c) => /\/x\.ev\./.test(c.id))

test('the test names are the ones src/env.ts runs, in its order', () => {
  const source = readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8')
  const list = (name) => source.match(new RegExp(`^const ${name} = '([^']*)'`, 'm'))[1].split(' ')
  assert.deepEqual(TESTS.blink, list('BLINK'))
  assert.deepEqual(TESTS.webkit, list('WEBKIT'))
  assert.deepEqual(TESTS.gecko, list('GECKO'))
  assert.deepEqual(TESTS.android, [...list('MOBILE'), ...list('HANDLER'), ...list('SINK'), 'isSecureContext false'])
  assert.deepEqual(TESTS.safari17, list('SAFARI17'))
  assert.deepEqual(TESTS.firefox143, list('FIREFOX143'))
  assert.deepEqual(TESTS.brave, list('BRAVE'))
  // and every key featureMarks returns has a list here, no more and no fewer
  const keys = [...source.matchAll(/'x\.ev\.(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(Object.keys(TESTS).sort(), [...new Set(keys)].sort())
})

test('the table holds only the sets that decide something in that engine', () => {
  assert.deepEqual(evidence('chromium', '153.0', 'desktop'), { blink: '11111', webkit: '00000', gecko: '00000', android: '00110', brave: '0' })
  // Playwright's mobile emulation adds onorientationchange in Chromium, and only there
  assert.equal(evidence('chromium', '157.0', 'phone').android, '10110')
  assert.deepEqual(evidence('firefox', '155.0', 'phone'), { blink: '00000', webkit: '00000', gecko: '11111', android: '00110', firefox143: '111', brave: '0' })
  // the Firefox 143 and Safari 17 tests each shipped in exactly that release, so an earlier build has none of them
  assert.equal(evidence('firefox', '142.0', 'desktop').firefox143, '000')
  assert.equal(evidence('firefox', '162.0a1', 'desktop').firefox143, '111')
  // WebKit's answer reads no Android test, so they are not checked there
  assert.deepEqual(evidence('webkit', '26.6', 'desktop'), { blink: '00000', webkit: '11111', gecko: '00000', safari17: '11111', brave: '0' })
  assert.equal(evidence('webkit', '16.4', 'desktop').safari17, '00000')
  assert.throws(() => evidence('safari', '26.0', 'desktop'), /engine/)
  assert.throws(() => evidence('firefox', 'nightly', 'desktop'), /version/)
})

test('the drift checks run only when asked for, so the pull-request run is unchanged', () => {
  for (const engine of Object.keys(MARKS)) {
    assert.deepEqual(evidenceChecks(labRun(engine, labReading(engine), { evidence: false })), [], engine)
    const checks = labRun(engine, labReading(engine))
    assert.equal(evidenceChecks(checks).length, Object.keys(evidence(engine, VERSION[engine], 'desktop')).length, engine)
    assert.ok(checks.every((c) => c.state === 'ok'), JSON.stringify(checks))
  }
  // the product build records no evidence, so nothing is asked of it
  assert.deepEqual(evidenceChecks(judge({ engine: 'firefox', version: '155.0', build: 'product', profile: 'desktop', weak: true, reading: labReading('firefox'), known: [], evidence: true })), [])
})

test('one drifting test fails the run with its own name, before the vote changes', () => {
  // four of five Gecko tests still give gecko, so only the evidence check sees it
  const checks = labRun('firefox', labReading('firefox', { 'x.ev.gecko': '11101' }))
  const byId = states(checks)
  assert.equal(byId['firefox/lab/desktop/x.engine'], 'ok')
  assert.equal(byId['firefox/lab/desktop/x.ev.gecko'], 'FAIL')
  const gecko = checks.find((c) => c.id === 'firefox/lab/desktop/x.ev.gecko')
  assert.equal(gecko.observed, '"11101"')
  assert.equal(gecko.expected, '"11111"')
  assert.match(gecko.name, /gecko test 4 of 5, HTMLCanvasElement\.prototype\.mozPrintCallback, no longer holds/)
  assert.equal(exitCode(tally(checks, [], 'firefox')), 1)
  // a foreign engine's test that appears is drift too
  const gained = labRun('webkit', labReading('webkit', { 'x.ev.blink': '00100' })).find((c) => c.id.endsWith('/x.ev.blink'))
  assert.equal(gained.state, 'FAIL')
  assert.match(gained.name, /blink test 3 of 5, performance\.memory, now holds/)
  // two at once are both named
  const two = labRun('chromium', labReading('chromium', { 'x.ev.android': '01111' })).find((c) => c.id.endsWith('/x.ev.android'))
  assert.match(two.name, /HTMLInputElement\.prototype\.capture, now holds/)
  assert.match(two.name, /isSecureContext false, now holds/)
})

test('a set the engine does not read can drift without failing the run', () => {
  // Chromium's answer never reads the Safari 17 or Firefox 143 tests
  const checks = labRun('chromium', labReading('chromium', { 'x.ev.safari17': '01111', 'x.ev.firefox143': '000' }))
  assert.ok(checks.every((c) => c.state === 'ok'), JSON.stringify(checks))
})

test('evidence that is missing or of the wrong length fails instead of passing', () => {
  const reading = labReading('webkit')
  delete reading.c['x.ev.safari17']
  const missing = labRun('webkit', reading).find((c) => c.id.endsWith('/x.ev.safari17'))
  assert.equal(missing.state, 'FAIL')
  assert.equal(missing.observed, 'absent')
  const short = labRun('webkit', labReading('webkit', { 'x.ev.webkit': '1111' })).find((c) => c.id.endsWith('/x.ev.webkit'))
  assert.equal(short.state, 'FAIL')
  assert.match(short.name, /4 results where lab\/engine-truth\.mjs lists 5 tests/)
})

test('a failing line names the browser, its channel and version, and the test', () => {
  const check = labRun('firefox', labReading('firefox', { 'x.ev.gecko': '01111' })).find((c) => c.id.endsWith('/x.ev.gecko'))
  const lines = report(check, 'firefox moz-firefox-beta 161.0')
  assert.match(lines[0], /^FAIL  firefox moz-firefox-beta 161\.0 lab desktop: gecko test 1 of 5, scrollMaxX, no longer holds: "01111", expected "11111"$/)
  // the lines of the pull-request run read as they did
  const ok = run('chromium', '153.0.8010.12', weak('blink'))[0]
  assert.deepEqual(report(ok, 'chromium 153.0.8010.12'), [`ok    chromium 153.0.8010.12 ${ok.name}: ${ok.observed}`])
  const known = { ...ok, state: 'KNOWN', why: 'x' }
  assert.deepEqual(report(known, 'chromium 153.0.8010.12'), [`KNOWN chromium 153.0.8010.12 ${ok.name}: ${ok.observed}, expected ${ok.expected}`, '      ^ KNOWN FAILURE, tolerated until the detection is fixed: x'])
})

test('a browser is chosen by engine, channel or executable, and a mismatch is a usage error', () => {
  assert.deepEqual(launchOptions([]), { engine: 'chromium', channel: null, executable: null, evidence: false, launch: {}, label: 'chromium', tag: 'chromium' })
  assert.deepEqual(launchOptions(['firefox']).launch, {})
  const beta = launchOptions(['chromium', '--channel', 'chrome-beta', '--evidence'])
  assert.deepEqual(beta, { engine: 'chromium', channel: 'chrome-beta', executable: null, evidence: true, launch: { channel: 'chrome-beta' }, label: 'chromium chrome-beta', tag: 'chromium-chrome-beta' })
  const nightly = launchOptions(['firefox', '--channel', 'moz-firefox-nightly', '--executable', '/tmp/firefox-nightly/firefox/firefox'])
  assert.deepEqual(nightly.launch, { channel: 'moz-firefox-nightly', executablePath: '/tmp/firefox-nightly/firefox/firefox' })
  assert.equal(nightly.tag, 'firefox-moz-firefox-nightly')
  assert.equal(launchOptions(['chromium', '--executable', '/opt/google/chrome-unstable/chrome']).tag, 'chromium-executable')
  // Playwright reports its own WebKit version, in browser.version() and in the user agent, whatever WebKit binary it drives (measured with
  // Playwright 1.63.0 and WebKit 27.2): the version the table depends on would be wrong, so a newer WebKit runs with the Playwright that ships it
  assert.throws(() => launchOptions(['webkit', '--executable', 'C:/pw/webkit-2392/Playwright.exe']), /version/)
  // a branded Chromium is not a Firefox, Mozilla's builds are driven only as Firefox, and WebKit has no channels
  assert.throws(() => launchOptions(['firefox', '--channel', 'chrome-beta']), /channel/)
  assert.throws(() => launchOptions(['chromium', '--channel', 'moz-firefox-beta']), /channel/)
  assert.throws(() => launchOptions(['webkit', '--channel', 'webkit-wsl']), /channel/)
  // Mozilla's own builds speak WebDriver BiDi, which only a moz- channel selects
  assert.throws(() => launchOptions(['firefox', '--executable', '/opt/firefox-beta/firefox']), /moz-/)
  assert.throws(() => launchOptions(['safari']), /engine/)
  assert.throws(() => launchOptions(['chromium', '--channel']), /--channel/)
  assert.throws(() => launchOptions(['chromium', '--headed']), /--headed/)
})

test('in permanent private browsing Firefox must still refuse the file system; the day it opens, the run fails and says what to do', () => {
  const directory = 'rejects SecurityError'
  const privateReading = { v: 3, c: { 'x.engine': 'gecko', 'x.private': true } }
  // persist: how storage.persist() settled in that session, which shows it is private (the next test)
  const fine = storage({ engine: 'firefox', version: '161.0', profile: 'private', reading: privateReading, directory, persist: 'resolves false', known: [] })
  assert.deepEqual(fine.map((c) => [c.id, c.state]), [['firefox/lab/private/private', 'ok'], ['firefox/lab/private/x.private', 'ok'], ['firefox/lab/private/getDirectory', 'ok']])
  // Bugzilla 1975760 shipped: getDirectory() resolves, and the library answers '!na' there
  const opened = storage({ engine: 'firefox', version: '163.0a1', profile: 'private', reading: { v: 3, c: { 'x.engine': 'gecko', 'x.private': '!na' } }, directory: 'resolves', persist: 'resolves false', known: [] })
  assert.deepEqual(opened.map((c) => [c.id, c.state]), [['firefox/lab/private/private', 'ok'], ['firefox/lab/private/x.private', 'FAIL'], ['firefox/lab/private/getDirectory', 'FAIL']])
  const line = opened.find((c) => c.id.endsWith('/getDirectory'))
  assert.equal(line.observed, '"resolves"')
  assert.equal(line.expected, '"rejects SecurityError"')
  assert.match(report(line, 'firefox moz-firefox-nightly 163.0a1').join('\n'), /CONTRIBUTING\.md/)
  assert.equal(exitCode(tally(opened, [], 'firefox')), 1)
  // a normal window opens it: the control that the private run differs at all
  assert.deepEqual(storage({ engine: 'firefox', version: '161.0', profile: 'desktop', directory: 'resolves', known: [] }).map((c) => c.state), ['ok'])
  assert.equal(storage({ engine: 'firefox', version: '161.0', profile: 'desktop', directory: 'rejects SecurityError', known: [] })[0].state, 'FAIL')
  // a private run that gave no reading fails by name
  const none = storage({ engine: 'firefox', version: '161.0', profile: 'private', reading: null, error: 'no reading within 10 s', directory, known: [] })
  assert.equal(states(none)['firefox/lab/private/reading'], 'FAIL')
})

test('WebKit must keep refusing the file system to its in-memory sessions', () => {
  const reading = labReading('webkit', { 'x.private': true })
  assert.deepEqual(storage({ engine: 'webkit', version: '26.6', profile: 'desktop', reading, directory: 'rejects UnknownError', known: [] }).map((c) => c.state), ['ok', 'ok'])
  // a lab reading in any other profile checks the library's answer only
  assert.deepEqual(storage({ engine: 'webkit', version: '26.6', profile: 'phone', reading, known: [] }).map((c) => c.id), ['webkit/lab/phone/x.private'])
  const opened = storage({ engine: 'webkit', version: '27.0', profile: 'desktop', reading: labReading('webkit', { 'x.private': false }), directory: 'resolves', known: [] })
  assert.deepEqual(opened.map((c) => c.state), ['FAIL', 'FAIL'])
  // Blink is never asked
  assert.deepEqual(storage({ engine: 'chromium', version: '157.0', profile: 'desktop', reading: labReading('chromium'), directory: 'resolves', known: [] }), [])
})

test('the canary is evidence only from a session shown to be private; otherwise it is reported as unverified and the run fails by name', () => {
  const reading = (value) => ({ v: 3, c: { 'x.engine': 'gecko', 'x.private': value } })
  // measured with Playwright 1.63.0's Firefox 155.0: launchPersistentContext() under browser.privatebrowsing.autostart gives a window that is not
  // private (16 cores, storage written to the profile, persist() waits) and there getDirectory() resolves; read as evidence, that is a false record
  const notPrivate = storage({ engine: 'firefox', version: '155.0', profile: 'private', reading: reading('!na'), directory: 'resolves', persist: 'waits', known: [] })
  assert.deepEqual(notPrivate.map((c) => [c.id, c.state]), [['firefox/lab/private/private', 'FAIL'], ['firefox/lab/private/x.private', 'UNVERIFIED'], ['firefox/lab/private/getDirectory', 'UNVERIFIED']])
  const shown = notPrivate[0]
  assert.equal(shown.observed, '"waits"')
  assert.equal(shown.expected, '"resolves false"')
  assert.match(report(shown, 'firefox 155.0').join('\n'), /not evidence/)
  // an unverified line keeps what was seen and wanted, says why it does not count, and does not count as a failure
  const lines = report(notPrivate[2], 'firefox 155.0')
  assert.match(lines[0], /^UNVERIFIED firefox 155\.0 lab private: .*: "resolves", expected "rejects SecurityError"$/)
  assert.match(lines[1], /^ {6}\^ .*not shown to be private/)
  assert.deepEqual(tally(notPrivate, [], 'firefox'), { failed: 1, known: 0, stale: [], partly: [] })
  // not asked at all is not shown either
  assert.equal(states(storage({ engine: 'firefox', version: '155.0', profile: 'private', reading: reading(true), directory: 'rejects SecurityError', known: [] }))['firefox/lab/private/private'], 'FAIL')
  // a tolerance never turns an unverified line into a pass or a known failure
  const known = [{ id: 'firefox/lab/private/getDirectory', observed: '"resolves"', why: 'x' }]
  assert.equal(states(storage({ engine: 'firefox', version: '155.0', profile: 'private', reading: reading('!na'), directory: 'resolves', persist: 'waits', known }))['firefox/lab/private/getDirectory'], 'UNVERIFIED')
  // the control: a normal window waits for a permission answer, so the private check can tell the two apart
  assert.deepEqual(storage({ engine: 'firefox', version: '155.0', profile: 'desktop', directory: 'resolves', persist: 'waits', known: [] }).map((c) => [c.id, c.state]), [['firefox/lab/desktop/getDirectory', 'ok'], ['firefox/lab/desktop/persist', 'ok']])
  assert.equal(states(storage({ engine: 'firefox', version: '155.0', profile: 'desktop', directory: 'resolves', persist: 'resolves false', known: [] }))['firefox/lab/desktop/persist'], 'FAIL')
})

test("Mozilla's builds over WebDriver BiDi report the canary as unverified, never as evidence or as a failure", () => {
  const opened = storage({ engine: 'firefox', version: '163.0a1', profile: 'private', reading: { v: 3, c: { 'x.engine': 'gecko', 'x.private': '!na' } }, directory: 'resolves', persist: 'resolves false', bidi: true, known: [] })
  assert.deepEqual(opened.map((c) => c.state), ['UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED'])
  assert.match(report(opened[2], 'firefox moz-firefox-nightly 163.0a1').join('\n'), /WebDriver BiDi[\s\S]*by hand/)
  assert.equal(exitCode(tally(opened, [], 'firefox')), 0)
  // the normal-window control and a missing private reading are not evidence there either
  assert.deepEqual(storage({ engine: 'firefox', version: '161.0', profile: 'desktop', directory: 'rejects SecurityError', persist: 'resolves false', bidi: true, known: [] }).map((c) => c.state), ['UNVERIFIED', 'UNVERIFIED'])
  assert.equal(states(storage({ engine: 'firefox', version: '161.0', profile: 'private', reading: null, error: 'the context did not open: x', bidi: true, known: [] }))['firefox/lab/private/reading'], 'UNVERIFIED')
  // the drift table is still checked in those builds: only the canary depends on the driver
  assert.equal(labRun('firefox', labReading('firefox', { 'x.ev.gecko': '11101' })).find((c) => c.id.endsWith('/x.ev.gecko')).state, 'FAIL')
  // the BiDi driver is the one a moz- channel selects
  assert.equal(overBidi(launchOptions(['firefox', '--channel', 'moz-firefox-beta', '--executable', '/tmp/f/firefox'])), true)
  assert.equal(overBidi(launchOptions(['firefox'])), false)
  assert.equal(overBidi(launchOptions(['chromium', '--channel', 'chrome-beta'])), false)
})

test('a private browser that will not start is one named failing check, in every driver', () => {
  for (const bidi of [false, true]) {
    const checks = storage({ engine: 'firefox', version: '161.0', profile: 'private', launch: 'browserType.launch: Browser closed.', bidi, known: [] })
    assert.deepEqual(checks.map((c) => [c.id, c.state, c.observed, c.expected]), [['firefox/lab/private/launch', 'FAIL', 'browserType.launch: Browser closed.', 'a browser']])
    assert.match(report(checks[0], 'firefox 161.0').join('\n'), /tooling/)
  }
})

test('starting a browser and opening a context end within their limit, give the first line of an error, and close what opens late', { timeout: 3000 }, async () => {
  const before = timers()
  const browser = { closed: false, close() { this.closed = true; return Promise.resolve() } }
  assert.deepEqual(await startWithin(() => Promise.resolve(browser), 300), { browser })
  assert.deepEqual(await startWithin(() => Promise.reject(new Error('browserType.launch: Browser closed.\n==== logs ====')), 300), { error: 'browserType.launch: Browser closed.' })
  assert.deepEqual(await startWithin(() => { throw new Error('no such executable\n at x') }, 300), { error: 'no such executable' })
  let started = Date.now()
  assert.deepEqual(await startWithin(never, 50), { error: 'the browser did not start within 0.05 s' })
  assert.ok(Date.now() - started < 250)
  // a browser that starts after the limit is closed, not left running
  let late
  const lateBrowser = { closed: false, close() { this.closed = true; return Promise.resolve() } }
  assert.deepEqual(await startWithin(() => new Promise((resolve) => (late = () => resolve(lateBrowser))), 50), { error: 'the browser did not start within 0.05 s' })
  late()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(lateBrowser.closed, true)

  const context = { closed: false, close() { this.closed = true; return Promise.resolve() } }
  const target = (newContext) => ({ newContext })
  assert.deepEqual(await openContext(target(() => Promise.resolve(context)), {}, 300), { context })
  assert.deepEqual(await openContext(target(() => Promise.reject(new Error('Protocol error: unknown option locale\n at x'))), {}, 300), { error: 'the context did not open: Protocol error: unknown option locale' })
  started = Date.now()
  assert.deepEqual(await openContext(target(never), {}, 50), { error: 'the context did not open within 0.05 s' })
  assert.ok(Date.now() - started < 250)
  assert.equal(timers() - before, 0, 'no Node timer is left behind')
})

test('asking a page for storage.persist() gives how it settled, says when it waits, and never hangs', { timeout: 3000 }, async () => {
  const context = (evaluate) => ({ newPage: async () => ({ goto: () => Promise.resolve(), evaluate }) })
  assert.equal(await askPersist(context(() => Promise.resolve('resolves false')), 'http://127.0.0.1:1/blank', 300), 'resolves false')
  assert.equal(await askPersist(context(never), 'http://127.0.0.1:1/blank', 100), 'no answer within 0.1 s')
  // the question asked in the page: persist() raced against the page's own timer, which answers "waits"; no other storage is touched
  let asked
  let wait
  await askPersist(context((fn, arg) => ((asked = String(fn)), (wait = arg), Promise.resolve('waits'))), 'http://127.0.0.1:1/blank', 300)
  assert.match(asked, /persist\(\)/)
  assert.match(asked, /waits/)
  assert.doesNotMatch(asked, /getDirectory|localStorage|indexedDB/)
  assert.ok(wait > 0 && wait < 300, `the page waits ${wait} ms, inside the Node-side limit`)
})

test('asking a page for getDirectory() gives how it settled, by name only, and never hangs', { timeout: 3000 }, async () => {
  const context = (evaluate, load = () => Promise.resolve()) => ({ newPage: async () => ({ goto: load, evaluate }) })
  const answer = (value) => context(() => Promise.resolve(value))
  assert.equal(await askDirectory(answer('resolves'), 'http://127.0.0.1:1/blank', 300), 'resolves')
  assert.equal(await askDirectory(answer('rejects SecurityError'), 'http://127.0.0.1:1/blank', 300), 'rejects SecurityError')
  const before = timers()
  assert.equal(await askDirectory(context(never), 'http://127.0.0.1:1/blank', 100), 'no answer within 0.1 s')
  assert.equal(await askDirectory(context(() => Promise.reject(new Error('page.evaluate: Target crashed\n at x'))), 'http://127.0.0.1:1/blank', 300), 'page.evaluate: Target crashed')
  assert.equal(timers() - before, 0)
  // the question asked in the page reads the name and nothing else
  let asked
  await askDirectory(context((fn) => ((asked = String(fn)), Promise.resolve('resolves'))), 'http://127.0.0.1:1/blank', 300)
  assert.match(asked, /getDirectory/)
  assert.doesNotMatch(asked, /message/)
})
