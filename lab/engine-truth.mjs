// What a real engine must report, worked out from the browser's own version and never from the code under test.
// lab/engines.mjs applies it to readings from real browsers; test/engines.test.mjs checks the rules themselves.
const ENGINES = { chromium: 'blink', firefox: 'gecko', webkit: 'webkit' }

// Cases today's code gets wrong, each { id, observed, why }: tolerated only with that exact wrong value, and the run fails once any check it matches passes.
// An id is "engine/build/profile/key" and any segment may use '*'.
export const KNOWN = []

export function expected(engine, version) {
  if (!Object.hasOwn(ENGINES, engine)) throw new Error(`unknown engine "${engine}": use chromium, firefox or webkit`)
  const major = parseInt(version, 10)
  if (!(major > 0)) throw new Error(`unreadable ${engine} version "${version}"`)
  return {
    engine: ENGINES[engine],
    // these are desktop builds: whatever user agent a context claims, the engine is not Android's
    android: false,
    excluded: {
      // memory is excluded only in Brave, which no test build is
      mem: false,
      // Firefox's fingerprinting protection flattens screen and core count from 143 on (docs/DECISIONS.md).
      // The screen is also excluded in every WebKit browser at the Safari 17 level or later, Safari or not (docs/DECISIONS.md, decision 5):
      // only Safari's private windows were measured altering it, but a test for Safari itself cannot be checked without a real iPhone and a
      // wrong one would split one phone's ids, so the test build, which is not Safari, excludes it too
      scr: (engine === 'firefox' && major >= 143) || (engine === 'webkit' && major >= 17),
      cores: engine === 'firefox' && major >= 143,
    },
  }
}

// The tests behind each x.ev.* key of a lab reading, in the order src/env.ts runs them; test/engines.test.mjs holds the two together.
// The last Android result is not a feature: it is 1 on an http: page, where Chromium withholds registerProtocolHandler.
export const TESTS = {
  blink: ['InputDeviceCapabilities', 'BeforeInstallPromptEvent', 'performance.memory', 'ShadowRoot.prototype.getSelection', '(-webkit-app-region:drag)'],
  webkit: ['GestureEvent', 'HTMLMediaElement.prototype.getStartDate', 'SVGFEGaussianBlurElement.prototype.edgeMode', '(-webkit-nbsp-mode:space)', '(-webkit-hyphenate-limit-after:auto)'],
  gecko: ['scrollMaxX', 'Event.prototype.explicitOriginalTarget', 'getDefaultComputedStyle', 'HTMLCanvasElement.prototype.mozPrintCallback', 'TimeEvent'],
  android: ['onorientationchange', 'HTMLInputElement.prototype.capture', 'navigator.registerProtocolHandler', 'HTMLMediaElement.prototype.setSinkId', 'isSecureContext false'],
  safari17: ['RegExp.prototype.unicodeSets', 'CSSContainerRule.prototype.containerName', '(contain-intrinsic-size:1px)', '(hyphens:auto)', 'URL.canParse'],
  firefox143: ['selector(::details-content)', 'selector(::before::marker)', '!CompositionEvent.prototype.locale'],
  brave: ['navigator.brave.isBrave'],
}

/**
 * The exact x.ev.* marks a desktop build of this engine and version must record, for each set its answer reads (src/env.ts detectBuild):
 * all three engine votes and Brave everywhere, the Android tests in Blink and Gecko, and the engine's own threshold set.
 * A set the answer never reads in that engine is left out, so its drift cannot fail the run.
 */
export function evidence(engine, version, profile) {
  expected(engine, version)
  const major = parseInt(version, 10)
  const all = (n, on) => (on ? '1' : '0').repeat(n)
  // WebKit test 1, GestureEvent, is not WebKit's own in any Playwright WebKit: Playwright 1.63.0 defines it in every WebKit page's bootstrap
  // script ("if (!window.GestureEvent) window.GestureEvent = function GestureEvent() {}", playwright-core/lib/coreBundle.js:47442). So this
  // run cannot see WebKit change it, and a change there is a Playwright change, not a WebKit release (docs/DECISIONS.md, "Watched every week")
  const table = { blink: all(5, engine === 'chromium'), webkit: all(5, engine === 'webkit'), gecko: all(5, engine === 'firefox') }
  // a desktop build on a secure page has registerProtocolHandler and setSinkId. The emulated phone's onorientationchange in Chromium comes
  // from the mobile emulation Playwright turns on (isMobile), not from a phone: a change there is a Playwright or emulation change too
  if (engine === 'chromium') table.android = profile === 'phone' ? '10110' : '00110'
  if (engine === 'firefox') table.android = '00110'
  // every test in these two sets shipped in exactly that release (docs/DECISIONS.md), so an earlier build has none of them
  if (engine === 'firefox') table.firefox143 = all(3, major >= 143)
  if (engine === 'webkit') table.safari17 = all(5, major >= 17)
  table.brave = '0'
  return table
}

const glob = (pattern) => new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]*') + '$')
const covers = (entry, check) => glob(entry.id).test(check.id) && entry.observed === check.observed
const shown = (value) => (value === undefined ? 'absent' : JSON.stringify(value))

/** One check per assertion, each with an id "engine/build/profile/key", the values seen and wanted, and a state. */
export function judge({ engine, version, build, profile, weak, reading, error, schema, known = KNOWN, evidence: drift = false }) {
  const want = expected(engine, version)
  const c = reading && reading.c ? reading.c : null
  const checks = []
  const add = (key, ok, observed, wanted, claim) => {
    const check = { id: `${engine}/${build}/${profile}/${key}`, name: `${build} ${profile}: ${claim}`, observed, expected: wanted }
    const entry = ok ? null : known.find((candidate) => covers(candidate, check))
    checks.push({ ...check, state: ok ? 'ok' : entry ? 'KNOWN' : 'FAIL', why: entry ? entry.why : undefined })
  }
  if (!c) {
    add('reading', false, error || shown(reading), 'a reading with values', 'a reading came back')
    return checks
  }
  if (schema) add('schema', !schema.length, schema.join('; ') || 'valid', 'valid', 'the reading is well formed')
  add('x.engine', c['x.engine'] === want.engine, shown(c['x.engine']), shown(want.engine), 'x.engine names the engine')
  add('x.android', c['x.android'] === want.android, shown(c['x.android']), shown(want.android), 'x.android follows the build, not the user agent')
  const isWeak = c['hw.model'] === '!na'
  add('weak', isWeak === weak, `hw.model ${shown(c['hw.model'])}`, weak ? 'no model' : 'a model', weak ? 'no model, so screen and cores stand in' : 'a model, so screen and cores stay out')
  const exclusion = (key, part) => {
    const observed = c[key]
    const ok = (observed === '!ex') === want.excluded[part] && observed !== undefined
    add(key, ok, shown(observed), want.excluded[part] ? '"!ex"' : 'a value, not "!ex"', `${key} is ${want.excluded[part] ? 'excluded' : 'kept'}`)
  }
  exclusion('hw.mem', 'mem')
  // screen and cores enter the reading only when there is no model; a missing weak reading already failed above
  if (isWeak && weak) {
    exclusion('hw.scr', 'scr')
    exclusion('hw.cores', 'cores')
  }
  // the drift run: every test the answer reads, so one that comes or goes in a new release fails by name while the vote still holds
  if (drift && build === 'lab') {
    const table = evidence(engine, version, profile)
    for (const set of Object.keys(table)) {
      const observed = c[`x.ev.${set}`]
      const wanted = table[set]
      const ok = observed === wanted
      add(`x.ev.${set}`, ok, shown(observed), shown(wanted), ok ? `x.ev.${set} is as the table says` : changed(set, observed, wanted))
    }
  }
  return checks
}

/** Which tests of one set moved, by name. */
function changed(set, observed, wanted) {
  const n = TESTS[set].length
  if (typeof observed !== 'string') return `x.ev.${set} is not in the lab reading`
  if (observed.length !== n) return `x.ev.${set} has ${observed.length} results where lab/engine-truth.mjs lists ${n} tests: update TESTS and the table`
  const moved = []
  for (let i = 0; i < n; i++) if (observed[i] !== wanted[i]) moved.push(`${set} test ${i + 1} of ${n}, ${TESTS[set][i]}, ${observed[i] === '1' ? 'now holds' : 'no longer holds'}`)
  return moved.join('; ')
}

// what the drift run does when the private-window canary fails; CONTRIBUTING.md has the procedure
const STORAGE_HINT = 'the private-window answer is no longer evidence in this engine: see "When the drift run fails" in CONTRIBUTING.md'
const PRIVATE_HINT = 'this session is not shown to be private, so the canary below is not evidence this run: see "When the drift run fails" in CONTRIBUTING.md'
const CONTROL_HINT = 'a normal window no longer waits here, so the private check cannot tell the two apart: see "When the drift run fails" in CONTRIBUTING.md'
const LAUNCH_HINT = 'a tooling failure, not drift: see "When the drift run fails" in CONTRIBUTING.md'
// why a canary line is printed but counts neither way
const UNSHOWN = 'not evidence: the session was not shown to be private (the line above)'
const BIDI = "not evidence: measured in Mozilla's build over WebDriver BiDi, where only Playwright's own Firefox counts; if this resolves while Playwright's own Firefox still refuses, confirm in a real private window by hand before recording a version"

/**
 * The private-window canary (docs/DECISIONS.md, "The in-memory-session check") on a lab reading and on how getDirectory() settled in a blank page:
 * Firefox in permanent private browsing ('private') must refuse it with SecurityError and a normal Firefox window must open it;
 * WebKit's default contexts are in memory, so it must refuse them with UnknownError. Blink is never asked.
 * Firefox's answer counts only from a session shown to be private: storage.persist() ('persist') settles false at once there, and waits for a
 * permission answer in a normal window. Otherwise, and in Mozilla's builds over WebDriver BiDi ('bidi'), the canary's lines are UNVERIFIED:
 * printed with what was seen and wanted, counted neither as a pass nor as a failure. 'launch' is why the private browser did not start.
 */
export function storage({ engine, version, profile, reading, error, directory, persist, launch, bidi = false, known = KNOWN }) {
  expected(engine, version)
  const checks = []
  const add = (key, ok, observed, wanted, claim, hint, unverified) => {
    const check = { id: `${engine}/lab/${profile}/${key}`, name: `lab ${profile}: ${claim}`, observed, expected: wanted }
    if (unverified) return checks.push({ ...check, state: 'UNVERIFIED', hint: unverified })
    const entry = ok ? null : known.find((candidate) => covers(candidate, check))
    checks.push({ ...check, state: ok ? 'ok' : entry ? 'KNOWN' : 'FAIL', why: entry ? entry.why : undefined, hint: ok ? undefined : hint })
  }
  if (engine === 'chromium') return checks
  const firefoxPrivate = engine === 'firefox' && profile === 'private'
  // a private browser that never started is a tooling failure in every driver, and there is nothing else to check
  if (firefoxPrivate && launch !== undefined) {
    add('launch', false, launch, 'a browser', 'the private browser started', LAUNCH_HINT)
    return checks
  }
  const inMemory = firefoxPrivate || engine === 'webkit'
  const driver = engine === 'firefox' && bidi ? BIDI : undefined
  let note = driver
  if (firefoxPrivate) {
    const isPrivate = persist === 'resolves false'
    add('private', isPrivate, shown(persist), '"resolves false"', 'the session is private: storage.persist() is refused at once, as Firefox does only in private browsing', PRIVATE_HINT, driver)
    if (!isPrivate) note = note || UNSHOWN
  }
  if (inMemory && reading !== undefined) {
    const c = reading && reading.c ? reading.c : null
    // no reading at all fails in Playwright's own builds whether or not the session was shown private
    if (!c) add('reading', false, error || shown(reading), 'a reading with values', 'a reading came back', undefined, driver)
    else add('x.private', c['x.private'] === true, shown(c['x.private']), 'true', 'x.private is true in a session held in memory', STORAGE_HINT, note)
  }
  if (directory !== undefined && (inMemory || profile === 'desktop')) {
    const wanted = !inMemory ? 'resolves' : engine === 'webkit' ? 'rejects UnknownError' : 'rejects SecurityError'
    const claim = inMemory ? `getDirectory() ${wanted.replace('rejects', 'is refused with')} in a session held in memory` : 'getDirectory() opens in a normal window'
    add('getDirectory', directory === wanted, shown(directory), shown(wanted), claim, inMemory ? STORAGE_HINT : undefined, note)
  }
  // the control for the private check: a normal window must not settle the way a private one does
  if (engine === 'firefox' && profile === 'desktop' && persist !== undefined) {
    add('persist', persist === 'waits', shown(persist), '"waits"', 'storage.persist() waits for a permission answer in a normal window', CONTROL_HINT, note)
  }
  return checks
}

/** The lines a run prints for one check; label names the browser, e.g. "firefox moz-firefox-beta 161.0". */
export function report(check, label) {
  const lines = [`${`${check.state} `.padEnd(6)}${label} ${check.name}: ${check.observed}${check.state === 'ok' ? '' : `, expected ${check.expected}`}`]
  if (check.state === 'KNOWN') lines.push(`      ^ KNOWN FAILURE, tolerated until the detection is fixed: ${check.why}`)
  if ((check.state === 'FAIL' || check.state === 'UNVERIFIED') && check.hint) lines.push(`      ^ ${check.hint}`)
  return lines
}

/** Counts real failures, tolerated ones, tolerances that apply to this engine but covered no failing check, and tolerances that also match a passing check. */
export function tally(checks, known = KNOWN, engine) {
  if (!Object.hasOwn(ENGINES, engine)) throw new Error(`unknown engine "${engine}": tally needs chromium, firefox or webkit`)
  // an entry that applies to no engine would never go stale in any run
  for (const entry of known) {
    const applies = glob(String(entry.id).split('/')[0])
    if (!Object.keys(ENGINES).some((name) => applies.test(name))) throw new Error(`known failure "${entry.id}" names no engine: start it with chromium, firefox, webkit or '*'`)
  }
  const failing = checks.filter((check) => check.state === 'KNOWN')
  // the engine segment is matched like the rest of the id, so a '*' tolerance goes stale in every engine
  const here = known.filter((entry) => glob(entry.id.split('/')[0]).test(engine))
  const stale = here.filter((entry) => !failing.some((check) => covers(entry, check)))
  // a half-fixed wildcard would tolerate the fixed half again if it regressed, so it has to be narrowed to what still fails
  const partly = here
    .filter((entry) => !stale.includes(entry))
    .map((entry) => ({ entry, passing: checks.filter((check) => check.state === 'ok' && glob(entry.id).test(check.id)).map((check) => check.id) }))
    .filter((found) => found.passing.length)
  return { failed: checks.filter((check) => check.state === 'FAIL').length, known: failing.length, stale, partly }
}

/** The run's exit status from a tally: 1 on any failure or stale tolerance, else 0. */
export const exitCode = (result) => (result.failed || result.stale.length || result.partly.length ? 1 : 0)
