import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANCHOR_VERSIONS, CANDIDATES, CORE_MARKS, COST_MEDIAN_MS, EMBEDDERS, EXTENSIONS, MIN_BLINK, POLICIES, POLICY_ENGINES, PROPOSED_ANCHORS, COST_BROWSERS, floorOf, inGate, judge, populations, tally, truth, uaApp, uaOs, verdict } from '../lab/mark-truth.mjs'

const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const ANDROID = 'Mozilla/5.0 (Linux; Android 12; SM-X135FU) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
const clean = (extra = {}) => ({ launch: 'clean', browser: 'chrome', engine: 'blink', host: 'windows', userAgent: WINDOWS_CHROME, ...extra })
const driven = (extra = {}) => ({ launch: 'driven', browser: 'chromium', engine: 'blink', host: 'windows', userAgent: WINDOWS_CHROME, ...extra })

test('the harness tells the OS of a user agent by its own rule', () => {
  assert.equal(uaOs(WINDOWS_CHROME), 'windows')
  assert.equal(uaOs(ANDROID), 'android')
  assert.equal(uaOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)'), 'ios')
  assert.equal(uaOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac')
  assert.equal(uaOs(null), 'other')
})

test('on a clean launch nothing is produced: every firing of every mark is a false positive', () => {
  for (const mark of [...CANDIDATES, ...CORE_MARKS]) {
    assert.equal(truth(mark, clean()), 'absent', mark)
    assert.equal(judge(mark, clean(), true), 'fp', mark)
    assert.equal(judge(mark, clean(), false), 'quiet', mark)
  }
})

test('on a clean launch the person configured, an inconsistency mark is person-caused and an automation mark is still a false positive', () => {
  const configured = clean({ configured: true, userAgent: ANDROID })
  for (const mark of ['platform', 'no-touch', 'not-android', 'app-version', 'own-value', 'plain-getter', 'plugins-type']) assert.equal(judge(mark, configured, true), 'person', mark)
  for (const mark of ['webdriver', 'global', 'headless', 'no-languages', 'no-webdriver', 'frame-window', 'frame-srcdoc']) assert.equal(judge(mark, configured, true), 'fp', mark)
})

test('a fixture produces its own mark only; the other candidates stay absent, and missing it is a miss only where the check could be made', () => {
  const ctx = driven({ fixture: 'own-value' })
  assert.equal(truth('own-value', ctx), 'produced')
  assert.equal(judge('own-value', ctx, true), 'true')
  assert.equal(judge('own-value', ctx, false, true), 'miss')
  assert.equal(judge('own-value', ctx, false, false), 'quiet')
  assert.equal(judge('plain-getter', ctx, true), 'fp')
  // the launch still decides the core marks
  assert.equal(truth('webdriver', ctx), 'produced')
})

test('a fixture produces plain-getter the same way', () => {
  const ctx = driven({ fixture: 'plain-getter' })
  assert.equal(truth('plain-getter', ctx), 'produced')
  assert.equal(judge('plain-getter', ctx, true), 'true')
  assert.equal(judge('own-value', ctx, true), 'fp')
})

test('a driven launch without a fixture produces none of the automation candidates', () => {
  for (const mark of ['own-value', 'frame-window', 'frame-srcdoc', 'no-webdriver']) assert.equal(judge(mark, driven({ headless: true, shell: true }), true), 'fp', mark)
})

test('driven Chromium produces webdriver, and the headless shell its user agent unless a context replaced it', () => {
  assert.equal(truth('webdriver', driven()), 'produced')
  assert.equal(truth('headless', driven({ headless: true, shell: true })), 'produced')
  assert.equal(truth('headless', driven({ headless: true })), 'allowed')
  assert.equal(truth('headless', driven({ headless: true, shell: true, uaSet: true })), 'absent')
  assert.equal(truth('headless', driven()), 'absent')
})

test('emulating another OS allows the inconsistency marks; the browser\'s own user agent does not', () => {
  const phone = driven({ uaSet: true, userAgent: ANDROID })
  for (const mark of ['platform', 'no-touch', 'no-brands', 'not-android']) assert.equal(truth(mark, phone), 'allowed', mark)
  for (const mark of ['platform', 'no-touch', 'no-brands', 'not-android']) assert.equal(truth(mark, driven()), 'absent', mark)
  // a tool's own default user agent for another OS counts as emulation too
  assert.equal(truth('platform', driven({ engine: 'webkit', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })), 'allowed')
})

test('a test build that reports webdriver by itself is not counted against the mark', () => {
  assert.equal(truth('webdriver', clean({ browser: 'firefox', engine: 'gecko', testBuild: true })), 'allowed')
  assert.equal(truth('webdriver', clean()), 'absent')
})

const rec = (source, ctx, marks, ran, key = 'k') => ({ source, key, ctx, marks, ran })

test('the tally counts per mark, source, launch and browser, and flags a mark that fires in only some runs of one context', () => {
  const rows = tally([
    rec('lab', clean(), { 'own-value': false }, { 'own-value': true }, 'a'),
    rec('lab', clean(), { 'own-value': true }, { 'own-value': true }, 'a'),
    rec('lab', driven({ fixture: 'own-value' }), { 'own-value': true }, { 'own-value': true }, 'b'),
  ])
  const cleanRow = rows.find((row) => row.launch === 'clean')
  assert.equal(cleanRow.runs, 2)
  assert.equal(cleanRow.ran, 2)
  assert.equal(cleanRow.fp, 1)
  assert.deepEqual(cleanRow.nondeterministic, ['a'])
  assert.equal(rows.find((row) => row.launch === 'driven').true, 1)
})

// Complete evidence for one mark: clean rows from every Chromium rung from the floor up, every extension configuration on each,
// the installed branded browsers, every page policy in every engine, the cost in every browser, a gate that stops at the newest rung,
// and the embedders measured. The last two do not exist today; tests remove one piece at a time.
const RUNGS = [86, 90, 101, 110, 120, 130, 140, 149, 153, 156, 158]
const EDGE_UA = WINDOWS_CHROME + ' Edg/157.0.0.0'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'
const EXTENSION_UA = { 'ua-switcher edge-windows': EDGE_UA, 'ua-switcher edge-windows-full-profile': EDGE_UA, 'ua-switcher chrome-mac': MAC_UA, 'ua-switcher firefox-windows': FIREFOX_UA }
function evidence(mark, { rungs = RUNGS, skip = [], fire = null } = {}) {
  const records = []
  const add = (ctx, key, fired = false) => records.push(rec('lab', ctx, { [mark]: fired }, { [mark]: inGate(ctx, 0) }, key))
  for (const major of rungs) {
    const base = { browser: 'chromium', version: major + '.0.0.0', major, userAgent: WINDOWS_CHROME }
    add(clean(base), `chromium ${major} clean normal plain`, fire === 'plain ' + major)
    for (const name of EXTENSIONS) {
      if (skip.includes(name + ' ' + major)) continue
      add(clean({ ...base, extension: name, configured: true, userAgent: EXTENSION_UA[name] || WINDOWS_CHROME }), `chromium ${major} clean ${name} plain`, fire === name + ' ' + major)
    }
  }
  for (const browser of ['chrome', 'edge', 'brave']) add(clean({ browser, version: '157.0.0.0', major: 157, userAgent: browser === 'edge' ? EDGE_UA : WINDOWS_CHROME }), `${browser} 157 clean normal plain`)
  const policies = []
  for (const policy of POLICIES) for (const engine of POLICY_ENGINES) if (!skip.includes(policy + ' ' + engine)) policies.push({ policy, engine, loads: 3, console: 0, violations: 0, reports: 0 })
  const cost = COST_BROWSERS.filter((browser) => !skip.includes('cost ' + browser)).map((browser) => ({ browser, contexts: 30, median: 0.4, max: 0.9 }))
  const newest = rungs[rungs.length - 1]
  const ceiling = skip.includes('ceiling') ? undefined : newest
  const embedders = skip.includes('embedders') ? undefined : 'measured'
  return { rows: tally(records), evidence: { floor: rungs[0], newest, policies, cost, ceiling, embedders } }
}
const owed = (pops) => pops.filter((p) => p.inGate && p.status !== 'measured').map((p) => p.name)

test('nothing ships while the embedders that send a Windows Chrome or Edge user agent are unmeasured', () => {
  const { rows, evidence: e } = evidence('frame-window', { skip: ['embedders'] })
  assert.deepEqual(owed(populations(rows, 'frame-window', e)), [EMBEDDERS])
  const v = verdict(rows, 'frame-window', e)
  assert.equal(v.ships, false)
  assert.equal(v.held, true)
  assert.ok(v.reasons.some((r) => /Electron/.test(r)), v.reasons.join('; '))
})

test('nothing ships while Blink newer than the newest measured build is inside the gate', () => {
  const { rows, evidence: e } = evidence('frame-window', { skip: ['ceiling'] })
  assert.deepEqual(owed(populations(rows, 'frame-window', e)), ['Blink newer than 158'])
  assert.equal(verdict(rows, 'frame-window', e).ships, false)
  // a ceiling above the newest measured version leaves the versions between them owed
  const high = evidence('frame-window')
  assert.equal(verdict(high.rows, 'frame-window', { ...high.evidence, ceiling: 170 }).ships, false)
})

test('with the evidence that exists today every candidate is held back, and each names both unmeasured populations', () => {
  // as lab/marks.mjs calls it: no gate has a ceiling and no embedder was measured
  for (const mark of CANDIDATES) {
    const { rows, evidence: e } = evidence(mark, { skip: ['ceiling', 'embedders'] })
    const v = verdict(rows, mark, { ...e, floor: floorOf(mark) })
    assert.equal(v.ships, false, mark)
    assert.equal(v.held, true, mark)
    assert.ok(v.reasons.some((r) => /Blink newer than/.test(r) && /Electron/.test(r)), `${mark}: ${v.reasons.join('; ')}`)
  }
})

test('the harness names the app family of a user agent by its own rule', () => {
  assert.equal(uaApp(WINDOWS_CHROME), 'chrome')
  assert.equal(uaApp(EDGE_UA), 'edge')
  assert.equal(uaApp(WINDOWS_CHROME + ' OPR/120.0.0.0'), 'opera')
  assert.equal(uaApp(FIREFOX_UA), 'firefox')
  assert.equal(uaApp(null), 'other')
})

test('the gate by the harness\'s own facts: Chrome or Edge in Blink on Windows, at or above the floor', () => {
  assert.equal(inGate(clean({ major: 120 }), 120), true)
  assert.equal(inGate(clean({ major: 119 }), 120), false)
  assert.equal(inGate(clean({ major: 157, userAgent: EDGE_UA }), 120), true)
  assert.equal(inGate(clean({ major: 157, userAgent: MAC_UA }), 120), false)
  assert.equal(inGate(clean({ major: 157, userAgent: FIREFOX_UA }), 120), false)
  assert.equal(inGate(clean({ major: 157, userAgent: ANDROID }), 120), false)
  assert.equal(inGate(clean({ major: 157, engine: 'gecko' }), 120), false)
})

test('the harness knows every candidate the lab build records, in its order, and each proposed anchor has a Chrome version', async () => {
  const { BOT_KEYS } = await import('../build/esm/botlab.js')
  assert.deepEqual(BOT_KEYS, CANDIDATES.map((mark) => 'x.bot.' + mark))
  for (const [mark, anchor] of Object.entries(PROPOSED_ANCHORS)) {
    assert.ok(CANDIDATES.includes(mark), mark)
    assert.ok(Number.isInteger(ANCHOR_VERSIONS[anchor]), `${mark}: anchor ${anchor} has no version`)
  }
  // the floors measured on the ladder (docs/DECISIONS.md); a candidate without one is judged from the oldest supported Chrome
  assert.deepEqual(Object.fromEntries(CANDIDATES.map((mark) => [mark, floorOf(mark)])), {
    'own-value': 86, 'frame-window': 86, 'frame-srcdoc': MIN_BLINK, 'no-webdriver': 101, 'app-version': MIN_BLINK, 'plain-getter': MIN_BLINK,
    'plugins-type': MIN_BLINK, 'ua-version': MIN_BLINK, 'no-platform-hint': MIN_BLINK, 'runtime-constructible': MIN_BLINK,
  })
})

test('every anchor the entry can use has a Chrome version from MDN compatibility data', () => {
  for (const [condition, version] of Object.entries(ANCHOR_VERSIONS)) {
    assert.match(condition, /^\(.+\)$|^selector\(.+\)$/)
    assert.ok(Number.isInteger(version) && version > 0, condition)
  }
})

test('with complete evidence, a ceiling and the embedders included, every population inside the gate is measured, and the mark ships', () => {
  const { rows, evidence: e } = evidence('frame-window')
  assert.deepEqual(owed(populations(rows, 'frame-window', e)), [])
  assert.equal(verdict(rows, 'frame-window', e).ships, true)
})

test('versions below the anchor are excluded by the gate; versions between two clean rungs at most twelve apart are covered', () => {
  const { rows, evidence: e } = evidence('frame-window', { rungs: [110, 120, 130] })
  const pops = populations(rows, 'frame-window', e)
  assert.equal(pops.find((p) => p.name === 'Blink 80').status, 'excluded')
  assert.equal(pops.find((p) => p.name === 'Blink 115').status, 'measured')
  assert.deepEqual(owed(pops), [])
  // a gap wider than twelve versions leaves the versions inside it unmeasured
  const wide = evidence('frame-window', { rungs: [110, 130] })
  assert.ok(owed(populations(wide.rows, 'frame-window', wide.evidence)).includes('Blink 120'))
  assert.equal(verdict(wide.rows, 'frame-window', wide.evidence).ships, false)
})

test('an anchor below the oldest measured rung leaves the versions under it owed: the mark cannot ship', () => {
  const { rows, evidence: e } = evidence('frame-window', { rungs: [110, 120] })
  const lower = { ...e, floor: 93 }
  assert.ok(owed(populations(rows, 'frame-window', lower)).includes('Blink 93'))
  assert.equal(verdict(rows, 'frame-window', lower).ships, false)
})

test('an extension configuration missing from one rung inside the gate leaves that population owed', () => {
  const { rows, evidence: e } = evidence('frame-window', { skip: ['privacy 140'] })
  assert.deepEqual(owed(populations(rows, 'frame-window', e)), ['privacy extension'])
  assert.equal(verdict(rows, 'frame-window', e).ships, false)
})

test('an extension whose user agent takes the browser outside the gate is excluded there, not owed', () => {
  const { rows, evidence: e } = evidence('frame-window')
  const pops = populations(rows, 'frame-window', e)
  assert.equal(pops.find((p) => p.name === 'ua-switcher chrome-mac extension').status, 'excluded')
  assert.equal(pops.find((p) => p.name === 'ua-switcher edge-windows extension').status, 'measured')
  // as lab/marks.mjs records it: rows beyond the gate carry the source "lab-outside"
  const outside = tally(rows.flatMap((row) => Array.from({ length: row.runs }, () => rec(inGate(row.ctx, 0) ? 'lab' : 'lab-outside', row.ctx, { 'frame-window': false }, { 'frame-window': inGate(row.ctx, 0) }, row.key))))
  assert.equal(populations(outside, 'frame-window', e).find((p) => p.name === 'ua-switcher chrome-mac extension').status, 'excluded')
})

test('a firing with an extension is person-caused and blocks the mark', () => {
  const { rows, evidence: e } = evidence('own-value', { fire: 'ua-switcher edge-windows 153' })
  const v = verdict(rows, 'own-value', e)
  assert.equal(v.ships, false)
  assert.ok(v.person > 0)
})

test('a page policy not run in one engine, or one where the entry logged or reported, blocks every mark', () => {
  const missing = evidence('frame-window', { skip: ['tt-enforced webkit'] })
  assert.deepEqual(owed(populations(missing.rows, 'frame-window', missing.evidence)), ['tt-enforced page in webkit'])
  const reported = evidence('frame-window')
  reported.evidence.policies[0].reports = 1
  assert.equal(verdict(reported.rows, 'frame-window', reported.evidence).ships, false)
  const logged = evidence('frame-window')
  logged.evidence.policies[1].console = 1
  assert.equal(verdict(logged.rows, 'frame-window', logged.evidence).ships, false)
})

test('the cost must be measured in every headed browser named, with a median at or under the limit', () => {
  const missing = evidence('frame-window', { skip: ['cost msedge'] })
  assert.deepEqual(owed(populations(missing.rows, 'frame-window', missing.evidence)), ['cost in msedge'])
  const slow = evidence('frame-window')
  slow.evidence.cost[0].median = COST_MEDIAN_MS + 0.1
  assert.equal(verdict(slow.rows, 'frame-window', slow.evidence).ships, false)
  const few = evidence('frame-window')
  few.evidence.cost[1].contexts = 10
  assert.equal(verdict(few.rows, 'frame-window', few.evidence).ships, false)
})

test('without evidence nothing can be reported as shipping', () => {
  const quiet = tally([rec('lab', clean(), { 'frame-window': false }, { 'frame-window': true })])
  const v = verdict(quiet, 'frame-window')
  assert.equal(v.ships, false)
  assert.ok(v.reasons.some((r) => /no evidence/.test(r)))
})

test('a mark ships only with no false positive, no person-caused firing and runs on a clean launch of an installed branded browser', () => {
  const base = evidence('frame-window')
  const full = base.evidence
  assert.equal(verdict(base.rows, 'frame-window', full).ships, true)
  const withoutBranded = (rows) => rows.filter((row) => ['chrome', 'edge', 'brave'].indexOf(row.browser) < 0)
  assert.equal(verdict(withoutBranded(base.rows), 'frame-window', full).ships, false)
  const notRun = tally([rec('lab', clean(), { 'frame-window': false }, { 'frame-window': false })])
  assert.equal(verdict(notRun, 'frame-window', full).ships, false)
  const fired = tally([rec('lab', clean(), { 'frame-window': true }, { 'frame-window': true })])
  assert.deepEqual([verdict(fired, 'frame-window', full).ships, verdict(fired, 'frame-window', full).fp], [false, 1])
  const person = tally([rec('lab', clean({ configured: true }), { 'app-version': true }, { 'app-version': true })])
  assert.deepEqual([verdict(person, 'app-version', full).ships, verdict(person, 'app-version', full).person], [false, 1])
})
