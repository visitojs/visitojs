import { test } from 'node:test'
import assert from 'node:assert/strict'
import { short } from '../build/esm/hash.js'
import { hints, intl, textSize, once } from '../build/esm/probes.js'

test('short: the first 8 hex characters are standard FNV-1a, the whole is 16 hex and deterministic', () => {
  assert.equal(short('a').slice(0, 8), 'e40c292c')
  assert.equal(short('foobar').slice(0, 8), 'bf9cf968')
  assert.match(short('data:image/png;base64,AAAA'), /^[0-9a-f]{16}$/)
  assert.equal(short('x'.repeat(50000)), short('x'.repeat(50000)))
  assert.notEqual(short('abc'), short('abd'))
  assert.notEqual(short('é'), short('e'))
})

test('once: a callback wrapper that fires one time, with a timeout value if the read never answers', async () => {
  const seen = []
  const done = once({ setTimeout, clearTimeout }, 20, { k: '!to' }, (v) => seen.push(v))
  await new Promise((r) => setTimeout(r, 40))
  done({ k: 'late' })
  assert.deepEqual(seen, [{ k: '!to' }])

  const seen2 = []
  const done2 = once({ setTimeout, clearTimeout }, 20, { k: '!to' }, (v) => seen2.push(v))
  done2({ k: 'value' })
  done2({ k: 'again' })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(seen2, [{ k: 'value' }])
})

test('hints: no client hints is "!na"; a model arrives; a refusal is final; silence times out', async () => {
  const run = (userAgentData) => new Promise((resolve) => hints({ setTimeout, clearTimeout, navigator: { userAgentData } }, resolve, 30))
  assert.deepEqual(await run(undefined), { 'x.ch.model': '!na' })
  const brands = [{ brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '150' }, { brand: 'Google Chrome', version: '150' }]
  const ok = { brands, mobile: true, getHighEntropyValues: () => Promise.resolve({ model: 'SM-A135F', platformVersion: '14.0.0', architecture: '', bitness: '' }) }
  assert.deepEqual(await run(ok), { 'x.ch.model': 'SM-A135F', 'x.ch.pv': '14.0.0', 'x.ch.brands': 'Chromium,Google Chrome', 'x.ch.mobile': true })
  assert.deepEqual(await run({ brands, mobile: true, getHighEntropyValues: () => Promise.reject(new Error('NotAllowedError')) }), { 'x.ch.model': '!na' })
  assert.deepEqual(await run({ brands, mobile: true, getHighEntropyValues: () => new Promise(() => {}) }), { 'x.ch.model': '!to' })
  assert.deepEqual(await run({ getHighEntropyValues: () => { throw new Error('boom') } }), { 'x.ch.model': '!err' })
})

// The User-Agent Client Hints draft (WICG, 26 October 2026, 4.1.3 "create an arbitrary brand"): words of ASCII letters, with one
// character of greaseyChars put between each two of them. The characters as the draft lists them, in its order:
const GREASEY_CHARS = [' ', '(', ')', '-', '.', '/', ':', ';', '=', '?', '_']
// Every string the algorithm can make from a list of words: each gap between two words takes each character, in every combination.
const joinings = (words) => {
  let forms = [words[0]]
  for (const word of words.slice(1)) forms = forms.flatMap((form) => GREASEY_CHARS.map((c) => form + c + word))
  return forms
}
// The draft names no words. These are the words of the brands seen below, the words of the draft's own example, and made-up ones.
const WORD_LISTS = [['Not', 'A', 'Brand'], ['Not', 'Browser'], ['Xwebs', 'mega'], ['Q', 'Not', 'A', 'Brand']]
// The draft's non-normative example, which starts with a separator, and each other character at either end of three words.
const ENDED = ['(Not;Browser', ...GREASEY_CHARS.slice(1).flatMap((c) => [c + 'Not A Brand', 'Not A Brand' + c])]
// Brands read from navigator.userAgentData on this PC on 13 November 2026, recorded as observations: Playwright's Chromium
// 153.0.8010.12 headless and with a window, Microsoft Edge 157.0.4341.46 and Google Chrome 157.0.8103.51.
const OBSERVED = [
  [['HeadlessChrome', 'Not_A Brand', 'Chromium'], 'Chromium,HeadlessChrome'],
  [['Chromium', 'Not_A Brand'], 'Chromium'],
  [['Not-A.Brand', 'Microsoft Edge', 'Chromium'], 'Chromium,Microsoft Edge'],
  [['Not-A.Brand', 'Google Chrome', 'Chromium'], 'Chromium,Google Chrome'],
]
// real products, a made-up vendor, and a made-up name that contains the letters "not"
const REAL_BRANDS = ['Chromium', 'Google Chrome', 'Microsoft Edge', 'Brave', 'Opera', 'Samsung Internet', 'Android WebView', 'HeadlessChrome', 'Xwebs mega', 'Knot Browser']
const brandsOf = (brands) => new Promise((resolve) => hints({ setTimeout, clearTimeout, navigator: { userAgentData: { brands, mobile: false, getHighEntropyValues: () => Promise.resolve({ model: '', platformVersion: '' }) } } }, resolve, 30))

test('hints: every arbitrary brand the draft\'s algorithm can make with a separator other than the space is dropped', async () => {
  const fake = [...WORD_LISTS.flatMap(joinings).filter((form) => /[^ A-Za-z]/.test(form)), ...ENDED]
  assert.equal(fake.length, 120 + 10 + 10 + 1330 + 1 + 20)
  for (const brand of fake) assert.equal((await brandsOf([{ brand }, { brand: 'Chromium' }]))['x.ch.brands'], 'Chromium', JSON.stringify(brand))
  const mixed = await brandsOf([...fake.slice(0, 11), ...REAL_BRANDS, ...fake.slice(-11)].map((brand) => ({ brand, version: '99' })))
  assert.equal(mixed['x.ch.brands'], [...REAL_BRANDS].sort().join(','))
})

test('hints: of the forms joined by spaces alone, only NotABrand is dropped: any other is indistinguishable from a real name', async () => {
  for (const words of WORD_LISTS) {
    const spaced = words.join(' ')
    const expected = spaced.replace(/ /g, '') === 'NotABrand' ? 'Chromium' : [spaced, 'Chromium'].sort().join(',')
    assert.equal((await brandsOf([{ brand: spaced }, { brand: 'Chromium' }]))['x.ch.brands'], expected, spaced)
  }
  for (const brand of ['NotA Brand', 'N ot A Bra nd']) assert.equal((await brandsOf([{ brand }, { brand: 'Chromium' }]))['x.ch.brands'], 'Chromium', brand)
  for (const brand of REAL_BRANDS) assert.equal((await brandsOf([{ brand: 'Not)A;Brand' }, { brand }]))['x.ch.brands'], brand)
})

test('hints: the brands observed on this PC keep the real names only', async () => {
  for (const [brands, expected] of OBSERVED) assert.equal((await brandsOf(brands.map((brand) => ({ brand }))))['x.ch.brands'], expected, brands.join(','))
})

test('hints: only the first 32 entries are read, so a list with an enormous length cannot hold the page', async () => {
  const started = Date.now()
  assert.equal((await brandsOf({ length: Infinity, 0: { brand: 'Chromium' } }))['x.ch.brands'], 'Chromium')
  assert.ok(Date.now() - started < 1000)
  const many = Array.from({ length: 40 }, (_, i) => ({ brand: 'B' + String(i).padStart(2, '0') }))
  assert.equal((await brandsOf(many))['x.ch.brands'], many.slice(0, 32).map((entry) => entry.brand).join(','))
})

test('hints: the kept brand names are sorted, so the hint does not change when a browser update reorders them', async () => {
  const one = await brandsOf([{ brand: 'Microsoft Edge' }, { brand: 'Not.A/Brand' }, { brand: 'Chromium' }])
  const two = await brandsOf([{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }, { brand: 'Not.A/Brand' }])
  assert.equal(one['x.ch.brands'], 'Chromium,Microsoft Edge')
  assert.equal(two['x.ch.brands'], 'Chromium,Microsoft Edge')
})

test('hints: an entry that is not an object or whose brand is not a string is skipped; a list that is not array-like is empty', async () => {
  const got = await brandsOf([null, 7, 'Chromium', { brand: 5 }, {}, { brand: 'Google Chrome' }])
  assert.equal(got['x.ch.brands'], 'Google Chrome')
  assert.equal(got['x.ch.model'], '', 'the model is still read')
  for (const brands of [undefined, null, {}, 5, { length: 'two' }]) assert.equal((await brandsOf(brands))['x.ch.brands'], '', String(brands))
  const throwing = await brandsOf([{ get brand() { throw new Error('fault') } }])
  assert.deepEqual(throwing, { 'x.ch.model': '!err' }, 'a getter that throws ends the read as failed, as any exception there does')
})

test('hints: a page that broke Array.prototype.sort gets the brands in order all the same', async () => {
  const sort = Array.prototype.sort
  Array.prototype.sort = () => { throw new Error('fault') }
  try {
    assert.equal((await brandsOf([{ brand: 'Opera' }, { brand: 'Chromium' }]))['x.ch.brands'], 'Chromium,Opera')
  } finally {
    Array.prototype.sort = sort
  }
})

// The answer to a promise-based read arrives after the call returned, when the page may have broken a built-in: nothing may escape as an unhandled rejection.
const rejections = async (fn) => {
  const seen = []
  const record = (reason) => seen.push(String(reason))
  process.on('unhandledRejection', record)
  try {
    const value = await fn()
    await new Promise((r) => setTimeout(r, 10))
    return { value, rejections: seen }
  } finally {
    process.off('unhandledRejection', record)
  }
}
// The read is started with the built-in intact, which is broken once the call has returned and mended once the promise callbacks have run.
const breakWhileAnswering = (target, name, call) => {
  const saved = Object.getOwnPropertyDescriptor(target, name)
  call()
  Object.defineProperty(target, name, { configurable: true, writable: true, value: () => { throw new Error('fault') } })
  queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => Object.defineProperty(target, name, saved))))
}

test('once: a clearTimeout that throws does not lose the answer', async () => {
  const seen = []
  const done = once({ setTimeout, clearTimeout: () => { throw new Error('fault') } }, 20, { k: '!to' }, (v) => seen.push(v))
  assert.doesNotThrow(() => done({ k: 'value' }))
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(seen, [{ k: 'value' }])
})

test('hints: a page that breaks Array.prototype.join while the answer is pending still gets the answer, and nothing is rejected', async () => {
  const brands = [{ brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '150' }]
  const data = { brands, mobile: true, getHighEntropyValues: () => Promise.resolve({ model: 'SM-A135F', platformVersion: '14.0.0' }) }
  const got = await rejections(() => new Promise((resolve) => {
    breakWhileAnswering(Array.prototype, 'join', () => hints({ setTimeout, clearTimeout, navigator: { userAgentData: data } }, resolve, 30))
  }))
  assert.deepEqual(got.rejections, [])
  assert.equal(got.value['x.ch.model'], 'SM-A135F')
})

test('hints: an answer that is not a dictionary of strings is "!err", and nothing is rejected', async () => {
  const model = { get model() { throw new Error('fault') } }
  for (const answer of [undefined, null, model]) {
    const data = { brands: [], mobile: false, getHighEntropyValues: () => Promise.resolve(answer) }
    const got = await rejections(() => new Promise((resolve) => hints({ setTimeout, clearTimeout, navigator: { userAgentData: data } }, resolve, 30)))
    assert.deepEqual(got.rejections, [], String(answer))
    assert.deepEqual(got.value, { 'x.ch.model': '!err' }, String(answer))
  }
})

test('intl: zone, locale, calendar, numbering and hour cycle; no Intl is "!na"', () => {
  const Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Africa/Cairo', locale: 'ar-EG', calendar: 'gregory', numberingSystem: 'arab', hourCycle: 'h23' }) }) }
  assert.deepEqual(intl({ Intl }), { 'x.tz': 'Africa/Cairo', 'x.loc': 'ar-EG', 'x.cal': 'gregory', 'x.num': 'arab', 'x.hc': 'h23' })
  assert.deepEqual(intl({}), { 'x.tz': '!na', 'x.loc': '!na', 'x.cal': '!na', 'x.num': '!na', 'x.hc': '!na' })
})

// A document that records the nodes it was given, and a computed style that answers from each node's own inline styles.
// As in a browser, the `font` shorthand resets the longhands declared before it: the order of the declarations counts.
function page({ scale = 1.15, zoom = 100, appleBody = 17 } = {}) {
  const fontSize = (styles) =>
    'font-size' in styles ? zoom : styles.font === '-apple-system-body' ? appleBody : styles.font ? (parseFloat(styles.font) * zoom) / 100 : zoom
  const node = () => {
    const styles = {}
    const self = {
      styles, children: [], parentNode: null, important: true,
      style: {
        setProperty: (property, value, priority) => {
          if (property === 'font') for (const longhand of ['font-size', 'font-family', 'line-height']) delete styles[longhand]
          styles[property] = value
          if (priority !== 'important') self.important = false
        },
        set cssText(text) { styles.cssText = text },
      },
      setAttribute: () => {},
      appendChild: (child) => { child.parentNode = self; self.children.push(child) },
      removeChild: (child) => { self.children.splice(self.children.indexOf(child), 1); child.parentNode = null },
      getBoundingClientRect: () => ({ width: 6.001 * fontSize(styles) }),
    }
    return self
  }
  const body = node()
  const made = []
  const w = {
    document: { body, createElement: () => { const n = node(); made.push(n); return n } },
    getComputedStyle: (n) => ({
      lineHeight: 'line-height' in n.styles ? `${scale * 100}px` : 'normal',
      fontSize: `${fontSize(n.styles)}px`,
    }),
  }
  return { w, body, made }
}

test('textSize: the scale, the zoomed font size and its width; every style is set as important; the page is left as it was', () => {
  const chrome = page()
  assert.deepEqual(textSize(chrome.w, { engine: 'blink' }), { 'x.txt.env': 1.15, 'x.txt.fs': 100, 'x.txt.w': 600.1, 'x.txt.apple': '!na' })
  assert.deepEqual(chrome.body.children, [], 'the hidden node is removed again')
  assert.ok(chrome.made.length >= 3 && chrome.made.slice(1).every((n) => n.important), "a page's own styles must not reach the probes")

  const inApp = page({ zoom: 115 })
  assert.deepEqual(textSize(inApp.w, { engine: 'blink' }), { 'x.txt.env': 1.15, 'x.txt.fs': 115, 'x.txt.w': 690.1, 'x.txt.apple': '!na' })
})

test('textSize: on WebKit it also reads the Dynamic Type body size', () => {
  const iphone = page({ scale: 1, appleBody: 19 })
  assert.equal(textSize(iphone.w, { engine: 'webkit' })['x.txt.apple'], 19)
  assert.equal(textSize(page().w, { engine: 'blink' })['x.txt.apple'], '!na', 'other engines are not asked')
})

test('textSize: the WebKit probe is an empty element styled with the font shorthand, never font-family, declared important, read after one append', () => {
  const iphone = page({ scale: 1, appleBody: 23 })
  let appends = 0
  const append = iphone.body.appendChild
  iphone.body.appendChild = (child) => { appends++; append(child) }
  assert.equal(textSize(iphone.w, { engine: 'webkit' })['x.txt.apple'], 23)
  const probe = iphone.made.find((n) => n.styles.font === '-apple-system-body')
  assert.ok(probe, 'a probe carries font: -apple-system-body')
  assert.ok(!('font-family' in probe.styles) && !('font-size' in probe.styles), 'the shorthand alone sets the size')
  assert.equal(probe.important, true)
  assert.equal(probe.textContent, '')
  assert.equal(probe.parentNode, iphone.made[0], 'inside the one hidden container')
  assert.equal(appends, 1, 'the document is changed once for all probes')
  assert.deepEqual(iphone.made.filter((n) => n.styles.font === '-apple-system-body').length, 1)
})

test('textSize: a WebKit page with no body leaves the WebKit probe not available and the others failed, as before', () => {
  const iphone = page()
  iphone.w.document.body = null
  assert.deepEqual(textSize(iphone.w, { engine: 'webkit' }), { 'x.txt.env': '!err', 'x.txt.fs': '!err', 'x.txt.w': '!err', 'x.txt.apple': '!na' })
})

test('textSize: a page that adds an enumerable font to Object.prototype and makes hasOwnProperty always true gets the values an intact page gets', () => {
  for (const engine of ['blink', 'webkit']) {
    const intact = textSize(page().w, { engine })
    const polluted = page()
    const hasOwnProperty = Object.prototype.hasOwnProperty
    let got
    // the inherited shorthand is declared once, before each probe's own font properties, so it cannot reset them
    Object.defineProperty(Object.prototype, 'font', { configurable: true, enumerable: true, writable: true, value: '10px serif' })
    Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: true, writable: true, value: () => true })
    try {
      got = textSize(polluted.w, { engine })
    } finally {
      Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: true, writable: true, value: hasOwnProperty })
      delete Object.prototype.font
    }
    assert.deepEqual(got, intact, engine)
  }
})

test('textSize: without a document it reports "!err" for each probe', () => {
  assert.deepEqual(textSize({}, { engine: 'blink' }), { 'x.txt.env': '!err', 'x.txt.fs': '!err', 'x.txt.w': '!err', 'x.txt.apple': '!na' })
})

test('textSize: on WebKit a system text size that is not a number is a failed read ("!err"), not a value the browser lacks', () => {
  for (const appleBody of ['', 'auto', NaN]) {
    const iphone = page({ scale: 1, appleBody })
    assert.equal(textSize(iphone.w, { engine: 'webkit' })['x.txt.apple'], '!err', JSON.stringify(String(appleBody)))
  }
  assert.equal(textSize(page({ appleBody: '' }).w, { engine: 'blink' })['x.txt.apple'], '!na', 'other engines are still not asked')
})

test('textSize: an engine without env() drops the scale declaration and the probe reads "!na", never the page\'s own line height', () => {
  // as Chrome before 69 or Firefox before 65: a value with env( is refused, and a span without its own line height inherits the page's 1.5
  const node = () => {
    const styles = {}
    return {
      styles, children: [], parentNode: null,
      style: {
        setProperty: (property, value) => { if (value.indexOf('env(') < 0) styles[property] = value },
        set cssText(text) { styles.cssText = text },
      },
      setAttribute: () => {},
      appendChild(child) { child.parentNode = this; this.children.push(child) },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null },
      getBoundingClientRect: () => ({ width: 600.1 }),
    }
  }
  const body = node()
  const w = {
    document: { body, createElement: node },
    getComputedStyle: (n) => {
      const size = 'font-size' in n.styles ? parseFloat(n.styles['font-size']) : 16
      const own = n.styles['line-height']
      return { lineHeight: own === undefined ? `${size * 1.5}px` : own === 'normal' ? 'normal' : own, fontSize: `${size}px` }
    },
  }
  const out = textSize(w, { engine: 'blink' })
  assert.equal(out['x.txt.env'], '!na')
  assert.equal(out['x.txt.fs'], 100)
})
