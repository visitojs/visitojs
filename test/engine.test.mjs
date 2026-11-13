import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectBuild, featureMarks } from '../build/esm/env.js'
import { BROWSERS, FEATURES, dress, fakeWindow } from './fake-window.mjs'

const NONE = { engine: 'other', android: false, safari17: false, firefox143: false, brave: false }
const as = (name, extra = []) => dress(fakeWindow(), [...BROWSERS[name], ...extra])
const without = (name, gone) => dress(fakeWindow(), BROWSERS[name].filter((feature) => !gone.includes(feature)))
const build = (name, extra) => detectBuild(as(name, extra))

test('each browser the specification names gets its engine, Android build, version level and Brave answer', () => {
  const expected = {
    chromeDesktop: { ...NONE, engine: 'blink' },
    chromeDesktopHttp: { ...NONE, engine: 'blink' },
    chromeAndroid: { ...NONE, engine: 'blink', android: true },
    chromeAndroidHttp: { ...NONE, engine: 'blink', android: true },
    braveDesktop: { ...NONE, engine: 'blink', brave: true },
    braveAndroid: { ...NONE, engine: 'blink', android: true, brave: true },
    safari16: { ...NONE, engine: 'webkit' },
    safari17: { ...NONE, engine: 'webkit', safari17: true },
    webkitWindows: { ...NONE, engine: 'webkit', safari17: true },
    firefox142: { ...NONE, engine: 'gecko' },
    firefoxDesktop: { ...NONE, engine: 'gecko', firefox143: true },
    firefoxDesktopHttp: { ...NONE, engine: 'gecko', firefox143: true },
    firefoxAndroid: { ...NONE, engine: 'gecko', android: true, firefox143: true },
    edgeHtml: NONE,
  }
  for (const name of Object.keys(expected)) assert.deepEqual(build(name), expected[name], name)
})

test('a window with none of the features, or no window at all, is another engine with nothing excluded', () => {
  for (const w of [fakeWindow(), {}, undefined, null, 0, 'window']) assert.deepEqual(detectBuild(w), NONE)
})

test('the answer comes from features only: replacing the user agent, vendor and platform changes nothing', () => {
  const chrome = as('chromeAndroid')
  const before = detectBuild(chrome)
  Object.assign(chrome.navigator, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    vendor: 'Apple Computer, Inc.',
    platform: 'MacIntel',
    appVersion: '5.0',
  })
  assert.deepEqual(detectBuild(chrome), before)
})

test('the same window gives the same answer every time', () => {
  for (const name of Object.keys(BROWSERS)) {
    const w = as(name)
    assert.deepEqual(detectBuild(w), detectBuild(w), name)
  }
})

test('an engine keeps its answer with one or two of its own five features gone, and loses it with three gone', () => {
  for (const [name, own, set] of [['chromeDesktop', 'blink', FEATURES.blink], ['safari17', 'webkit', FEATURES.webkit], ['firefoxDesktop', 'gecko', FEATURES.gecko]]) {
    for (let start = 0; start < 5; start++) {
      const one = [set[start]]
      const two = [set[start], set[(start + 1) % 5]]
      const three = [...two, set[(start + 2) % 5]]
      assert.equal(detectBuild(without(name, one)).engine, own, `${name} without ${one}`)
      assert.equal(detectBuild(without(name, two)).engine, own, `${name} without ${two}`)
      assert.equal(detectBuild(without(name, three)).engine, 'other', `${name} without ${three}`)
    }
  }
})

test('an engine keeps its answer with one or two foreign features added, and three of one foreign set make it a tie', () => {
  const cases = [['chromeDesktop', 'blink'], ['safari17', 'webkit'], ['firefoxDesktop', 'gecko']]
  for (const [name, own] of cases) {
    for (const foreign of ['blink', 'webkit', 'gecko']) {
      if (foreign === own) continue
      const set = FEATURES[foreign]
      assert.equal(build(name, set.slice(0, 1)).engine, own, `${name} with one ${foreign} feature`)
      assert.equal(build(name, set.slice(3)).engine, own, `${name} with two ${foreign} features`)
      assert.equal(build(name, [...set.slice(0, 1), ...FEATURES[cases.find((c) => c[1] !== own && c[1] !== foreign)[1]].slice(0, 2)]).engine, own, `${name} with three features spread over two foreign sets`)
      assert.equal(build(name, set.slice(2)).engine, 'other', `${name} with three ${foreign} features`)
    }
  }
})

test('a real Android Chromium build is Android: both mobile features, neither desktop one', () => {
  assert.equal(build('chromeAndroid').android, true)
  assert.equal(build('chromeAndroidHttp').android, true, 'an http: page')
  for (const feature of FEATURES.mobile) assert.equal(detectBuild(without('chromeAndroid', [feature])).android, true, `without ${feature}`)
  for (const feature of FEATURES.mobile) assert.equal(detectBuild(without('chromeAndroidHttp', [feature])).android, true, `http: without ${feature}`)
  assert.equal(detectBuild(without('chromeAndroid', FEATURES.mobile)).android, false)
  assert.equal(build('chromeAndroid', ['HTMLMediaElement.prototype.setSinkId']).android, true, 'one desktop feature is not enough to veto')
})

test('a build with both mobile features is never vetoed, so a desktop feature shipping on Android cannot raise a false mark', () => {
  assert.equal(build('chromeAndroid', FEATURES.desktop).android, true)
  assert.equal(build('chromeAndroidHttp', ['HTMLMediaElement.prototype.setSinkId']).android, true)
  // with one mobile feature, the two desktop features still veto
  assert.equal(detectBuild(dress(without('chromeAndroid', ['HTMLInputElement.prototype.capture']), FEATURES.desktop)).android, false)
})

test('a desktop Chromium emulating a phone is not Android, on a secure page and on an http: page', () => {
  assert.equal(build('emulatedAndroid').android, false)
  // on an http: page registerProtocolHandler is gone, and the page being insecure takes its place in the veto
  assert.equal(build('emulatedAndroidHttp').android, false)
  assert.equal(build('chromeDesktop').android, false)
  assert.equal(build('chromeDesktopHttp').android, false)
})

test('a page whose isSecureContext getter throws loses only that piece of the veto', () => {
  const w = as('emulatedAndroid')
  Object.defineProperty(w, 'isSecureContext', { get() { throw new Error('fault') } })
  assert.deepEqual(detectBuild(w), { ...NONE, engine: 'blink' })
  const android = as('chromeAndroidHttp')
  Object.defineProperty(android, 'isSecureContext', { get() { throw new Error('fault') } })
  assert.deepEqual(detectBuild(android), { ...NONE, engine: 'blink', android: true })
})

// every object or function a test reads through: the first name of a dotted path, and CSS.supports for the conditions
const dependsOn = (feature) => (feature.includes('(') ? 'CSS' : feature.includes('.') ? feature.split('.')[0] : feature)
const REAL = ['chromeDesktop', 'chromeDesktopHttp', 'chromeAndroid', 'chromeAndroidHttp', 'braveDesktop', 'braveAndroid', 'safari16', 'safari17', 'webkitWindows', 'firefox142', 'firefoxDesktop', 'firefoxDesktopHttp', 'firefoxAndroid']

test('no engine or version set has more than two tests behind any one object or function', () => {
  for (const set of ['blink', 'webkit', 'gecko', 'safari17']) {
    const count = {}
    for (const feature of FEATURES[set]) count[dependsOn(feature)] = (count[dependsOn(feature)] || 0) + 1
    for (const name of Object.keys(count)) assert.ok(count[name] <= 2, `${set}: ${count[name]} tests behind ${name}`)
  }
})

test('one page global named like any tested feature changes no answer, apart from the outcome documented', () => {
  const names = [...new Set(Object.values(FEATURES).flat().filter((f) => !f.includes('.') && !f.includes('(')))]
  for (const name of REAL) {
    const expected = build(name)
    for (const global of names) {
      const w = as(name)
      w[global] = function () {}
      const want = { ...expected }
      // documented: Firefox on an http: page has neither desktop feature, so a global onorientationchange reads as Android there
      if (name === 'firefoxDesktopHttp' && global === 'onorientationchange') want.android = true
      assert.deepEqual(detectBuild(w), want, `${name} with a page global ${global}`)
    }
  }
})

test('one page fault on any object the tests read through changes no answer, apart from the two outcomes documented', () => {
  const objects = [...new Set(Object.values(FEATURES).flat().filter((f) => f.includes('.') || f.includes('(')).map(dependsOn)), 'isSecureContext']
  const breaks = {
    deleted: (w, name) => delete w[name],
    throws: (w, name) => Object.defineProperty(w, name, { configurable: true, get() { throw new Error('fault') } }),
    primitive: (w, name) => Object.defineProperty(w, name, { configurable: true, value: 1 }),
  }
  const cssBreaks = {
    'CSS.supports throws': (w) => { w.CSS = { supports() { throw new Error('fault') } } },
    'CSS.supports returns 1': (w) => { w.CSS = { supports: () => 1 } },
    'CSS.supports answers true to everything': (w) => { w.CSS = { supports: () => true } },
  }
  for (const name of REAL) {
    const expected = build(name)
    const cases = []
    for (const object of objects) for (const mode of Object.keys(breaks)) cases.push([`${object} ${mode}`, object, (w) => breaks[mode](w, object)])
    for (const label of Object.keys(cssBreaks)) cases.push([label, 'CSS', cssBreaks[label]])
    for (const [label, object, fault] of cases) {
      const w = as(name)
      fault(w)
      const want = { ...expected }
      // documented: Firefox 143 has no test outside CSS.supports but its one removal, so a page that breaks CSS.supports is an older Firefox there
      if (object === 'CSS' && expected.engine === 'gecko') want.firefox143 = false
      // documented: Brave's own API is the only evidence of Brave there is
      if (object === 'navigator') want.brave = false
      assert.deepEqual(detectBuild(w), want, `${name}, ${label}`)
    }
  }
})

test('Gecko is Android with one mobile feature, and the veto never reaches Firefox for Android, which has no setSinkId; WebKit and other engines are never Android', () => {
  assert.equal(build('firefoxAndroid').android, true)
  assert.equal(build('firefoxAndroid', FEATURES.desktop).android, true)
  assert.equal(detectBuild(without('firefoxAndroid', ['HTMLInputElement.prototype.capture'])).android, true, 'Firefox for Android before 79')
  assert.equal(detectBuild(dress(without('firefoxAndroid', ['HTMLInputElement.prototype.capture']), ['insecure'])).android, true, 'the same on an http: page')
  assert.equal(build('firefoxDesktop').android, false)
  // a page global named like a mobile feature: desktop Firefox on a secure page has both desktop features and is vetoed
  assert.equal(build('firefoxDesktop', ['onorientationchange']).android, false)
  // documented: on an http: page Firefox withholds both desktop features, so nothing vetoes it; no mark reads android in Gecko
  assert.equal(build('firefoxDesktopHttp', ['onorientationchange']).android, true)
  assert.equal(build('webkitWindows', FEATURES.mobile).android, false)
  assert.equal(detectBuild(dress(fakeWindow(), FEATURES.mobile)).android, false)
})

test('Safari 17 needs three of its five features: two may go, and one polyfill on Safari 16 is not enough', () => {
  const set = FEATURES.safari17
  assert.equal(detectBuild(without('safari17', set.slice(3))).safari17, true)
  assert.equal(detectBuild(without('safari17', set.slice(2))).safari17, false)
  assert.equal(build('safari16', ['URL.canParse']).safari17, false)
  assert.equal(build('safari16', set.slice(2)).safari17, true)
})

test('a CSS.supports that answers true to everything counts for nothing: Firefox 142 stays below 143 and Safari 16 with a URL.canParse polyfill below 17', () => {
  const yes = (w) => { w.CSS = { supports: () => true }; return w }
  assert.deepEqual(detectBuild(yes(as('firefox142'))), { ...NONE, engine: 'gecko' })
  assert.deepEqual(detectBuild(yes(as('safari16', ['URL.canParse']))), { ...NONE, engine: 'webkit' })
  // the conditions count for nothing, so a real Firefox 143 there reads as older, as on any page that breaks CSS.supports, and Safari 17 keeps its answer
  assert.deepEqual(detectBuild(yes(as('firefoxDesktop'))), { ...NONE, engine: 'gecko' })
  assert.deepEqual(detectBuild(yes(as('safari17'))), { ...NONE, engine: 'webkit', safari17: true })
  // the lab build shows the same: no condition passes
  assert.equal(featureMarks(yes(as('safari16')))['x.ev.webkit'], '11100')
  assert.equal(featureMarks(yes(as('chromeDesktop')))['x.ev.webkit'], '00000')
})

test('Firefox 143 needs two of its three tests: one may fail, and Firefox 142 with one new selector is still below', () => {
  assert.equal(detectBuild(without('firefoxDesktop', ['selector(::details-content)'])).firefox143, true)
  assert.equal(detectBuild(without('firefoxDesktop', ['selector(::before::marker)'])).firefox143, true)
  assert.equal(detectBuild(without('firefoxDesktop', ['selector(::details-content)', 'selector(::before::marker)'])).firefox143, false)
  assert.equal(build('firefoxDesktop', FEATURES.firefoxBefore143).firefox143, true, 'the locale back, both selectors there')
  assert.equal(build('firefox142', ['selector(::details-content)']).firefox143, false)
})

test('a version level belongs to its own engine: Chromium and WebKit pass most Firefox 143 tests, Chromium and Firefox all Safari 17 ones', () => {
  for (const name of ['chromeDesktop', 'chromeAndroid', 'firefoxDesktop', 'firefoxAndroid']) assert.equal(build(name).safari17, false, name)
  for (const name of ['chromeDesktop', 'webkitWindows', 'safari17']) assert.equal(build(name, FEATURES.firefox143).firefox143, false, name)
})

test('Brave is told by its own API existing, in any engine; the API is never called', () => {
  let calls = 0
  const w = as('chromeAndroid')
  w.navigator.brave = { isBrave: () => calls++ }
  assert.equal(detectBuild(w).brave, true)
  assert.equal(calls, 0)
  assert.equal(build('safari17', FEATURES.brave).brave, true)
  const half = as('chromeDesktop')
  half.navigator.brave = {}
  assert.equal(detectBuild(half).brave, false, 'navigator.brave without isBrave')
})

test('a tested property is looked up, never read: a getter that throws or counts does not run', () => {
  let reads = 0
  const w = as('chromeDesktop')
  Object.defineProperty(w.performance, 'memory', { get() { reads++; throw new Error('fault') } })
  w.navigator = Object.assign({}, w.navigator)
  Object.defineProperty(w.navigator, 'registerProtocolHandler', { get() { reads++; return () => {} } })
  assert.deepEqual(detectBuild(w), { ...NONE, engine: 'blink' })
  assert.equal(reads, 0)
})

test('faults on the page cost at most the tests they touch and never throw', () => {
  const faults = {
    'a holder deleted': (w) => delete w.ShadowRoot,
    'navigator throws': (w) => Object.defineProperty(w, 'navigator', { get() { throw new Error('fault') } }),
    'performance throws': (w) => Object.defineProperty(w, 'performance', { get() { throw new Error('fault') } }),
    'a holder replaced by a primitive': (w) => { w.ShadowRoot = 1; w.navigator = 'nav' },
    'a holder is a Proxy whose has trap throws': (w) => { w.performance = new Proxy({}, { has() { throw new Error('fault') } }) },
    'CSS deleted': (w) => delete w.CSS,
    'CSS throws': (w) => Object.defineProperty(w, 'CSS', { get() { throw new Error('fault') } }),
    'CSS.supports not a function': (w) => { w.CSS = { supports: 'yes' } },
    'CSS.supports throws': (w) => { w.CSS = { supports() { throw new Error('fault') } } },
    'CSS.supports returns a truthy non-boolean': (w) => { w.CSS = { supports: () => 1 } },
    'a page global with a tested name of another engine': (w) => { w.GestureEvent = function () {} },
  }
  for (const label of Object.keys(faults)) {
    const w = as('chromeDesktop')
    faults[label](w)
    let got
    assert.doesNotThrow(() => { got = detectBuild(w) }, label)
    assert.equal(got.engine, 'blink', label)
    assert.deepEqual(detectBuild(w), got, label)
  }
  // a hostile window: every property read throws
  const hostile = new Proxy({}, { get() { throw new Error('fault') }, has() { throw new Error('fault') } })
  assert.deepEqual(detectBuild(hostile), NONE)
})

test('Object.prototype gaining a tested name moves one count by one and changes no answer', () => {
  Object.prototype.getSelection = function () {}
  try {
    // WebKit and Gecko have ShadowRoot, only without getSelection
    const safari = as('safari17', ['ShadowRoot.prototype'])
    assert.equal(featureMarks(safari)['x.ev.blink'], '00010')
    assert.equal(detectBuild(safari).engine, 'webkit')
    assert.equal(build('firefoxDesktop', ['ShadowRoot.prototype']).engine, 'gecko')
    assert.equal(build('chromeDesktop').engine, 'blink')
  } finally {
    delete Object.prototype.getSelection
  }
})

test('a page that broke String.prototype.split gets the answer that excludes nothing, without an exception', () => {
  const w = as('braveAndroid')
  const split = String.prototype.split
  String.prototype.split = function () { throw new Error('fault') }
  let got
  try {
    got = detectBuild(w)
  } finally {
    String.prototype.split = split
  }
  assert.deepEqual(got, NONE)
})

test('the lab build records every test, one string of 1 and 0 per set, so a drifting feature shows before it flips an answer', () => {
  assert.deepEqual(featureMarks(as('chromeDesktopHttp')), {
    'x.ev.blink': '11111',
    'x.ev.webkit': '00000',
    'x.ev.gecko': '00000',
    // the two mobile tests, the two desktop ones, then whether the page is insecure
    'x.ev.android': '00011',
    'x.ev.safari17': '11111',
    'x.ev.firefox143': '111',
    'x.ev.brave': '0',
  })
  const marks = featureMarks(without('firefoxAndroid', ['scrollMaxX', 'selector(::before::marker)']))
  assert.equal(marks['x.ev.gecko'], '01111')
  assert.equal(marks['x.ev.android'], '11100')
  assert.equal(marks['x.ev.firefox143'], '101')
})

test('a page whose String.prototype.split returns an object or an empty list gets the answer that excludes nothing, never Brave', () => {
  const split = String.prototype.split
  for (const [label, answer] of [['{}', () => ({})], ['[]', () => []]]) {
    // a real window has a property named "undefined": a lookup of a missing last name must not find it
    const w = as('chromeDesktop')
    w['undefined'] = undefined
    let result
    String.prototype.split = function () { return answer() }
    try {
      result = detectBuild(w)
    } finally {
      String.prototype.split = split
    }
    assert.deepEqual(result, NONE, label)
  }
})
