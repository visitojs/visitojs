import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_KEYS, botMarks } from '../build/esm/botlab.js'
import { protoWindow } from './fake-window.mjs'

// The lab build records every automation mark candidate as x.bot.<mark>. None ships: docs/DECISIONS.md, "Automation marks: none added in 1.0".
const CANDIDATES = ['own-value', 'frame-window', 'frame-srcdoc', 'no-webdriver', 'app-version', 'plain-getter', 'plugins-type', 'ua-version', 'no-platform-hint', 'runtime-constructible']

/** A plug-in emulator's state: its own list and constructor, holding the native entries and then one object of its own. */
function emulate(w) {
  const native = w.navigator.plugins
  const Emulated = function PluginArray() {}
  const list = Object.create(Emulated.prototype)
  let n = 0
  for (; n < native.length; n++) list[n] = native[n]
  list[n] = { name: 'Emulated' }
  list.length = n + 1
  Object.defineProperty(w.navigator, 'plugins', { configurable: true, enumerable: true, value: list })
  w.PluginArray = Emulated
}

test('the lab keys are every candidate, in a fixed order, and chrome-late is gone', () => {
  assert.deepEqual(BOT_KEYS, CANDIDATES.map((mark) => 'x.bot.' + mark))
  assert.deepEqual(Object.keys(botMarks(protoWindow())), BOT_KEYS)
})

test('a clean window: every mark false, and "!na" where there was nothing to look at', () => {
  assert.deepEqual(botMarks(protoWindow()), {
    'x.bot.own-value': false,
    'x.bot.frame-window': false,
    'x.bot.frame-srcdoc': false,
    'x.bot.no-webdriver': false,
    'x.bot.app-version': false,
    'x.bot.plain-getter': false,
    'x.bot.plugins-type': false,
    'x.bot.ua-version': false,
    // no client hints in this window
    'x.bot.no-platform-hint': '!na',
    // no chrome.runtime: nothing to look at, which is not the same as looked and found nothing
    'x.bot.runtime-constructible': '!na',
  })
})

test('runtime-constructible looks only where chrome.runtime.sendMessage is a function', () => {
  const w = protoWindow()
  w.chrome = { runtime: {} }
  assert.equal(botMarks(w)['x.bot.runtime-constructible'], '!na')
  // a built-in binding has no own prototype, like an arrow function
  w.chrome.runtime.sendMessage = () => {}
  assert.equal(botMarks(w)['x.bot.runtime-constructible'], false)
  w.chrome.runtime.sendMessage = function () {}
  assert.equal(botMarks(w)['x.bot.runtime-constructible'], true)
})

test('plugins-type, held back: fires on a plug-in emulator\'s list when the native list is empty, which is why it is lab only', () => {
  // with the native entries first, entry 0 is a real Plugin and the replaced constructor matches the list
  const full = protoWindow()
  emulate(full)
  assert.equal(botMarks(full)['x.bot.plugins-type'], false)
  const empty = protoWindow({ plugins: 0 })
  emulate(empty)
  assert.equal(botMarks(empty)['x.bot.plugins-type'], true)
  assert.equal(botMarks(protoWindow({ plugins: 0 }))['x.bot.plugins-type'], false)
})

test('the lab records each observation with no version gate, so older engines show what a mark would see there', () => {
  const w = protoWindow({ supports: (text) => text === '(accent-color:red)' })
  Object.defineProperty(w.navigator, 'hardwareConcurrency', { configurable: true, value: 8 })
  const marks = botMarks(w)
  assert.equal(marks['x.bot.own-value'], true)
  assert.equal(marks['x.bot.frame-window'], false)
})

test('app-version, held back: fires where appVersion is not the user agent after "Mozilla/", as a switcher that replaces the user agent alone leaves it', () => {
  const w = protoWindow()
  Object.defineProperty(w.Navigator.prototype, 'appVersion', { configurable: true, get: () => '5.0 (X11; Linux x86_64)' })
  assert.equal(botMarks(w)['x.bot.app-version'], true)
  // a user agent that does not start as the standard says is not judged
  assert.equal(botMarks(protoWindow({ ua: 'CustomAgent/1.0' }))['x.bot.app-version'], '!na')
  const THROW = () => { throw new Error('fault') }
  for (const fault of [
    (x) => Object.defineProperty(x.Navigator.prototype, 'userAgent', { get: () => undefined }),
    (x) => Object.defineProperty(x.Navigator.prototype, 'appVersion', { get: THROW }),
    (x) => Object.defineProperty(x.Navigator.prototype, 'appVersion', { get: () => ({ toString: THROW, valueOf: THROW }) }),
  ]) {
    const broken = protoWindow()
    fault(broken)
    assert.equal(botMarks(broken)['x.bot.app-version'], '!na')
  }
})

test('plain-getter, held back: fires on a getter replaced by an ordinary function or by a plain value, as privacy extensions and switchers leave them', () => {
  const fn = protoWindow()
  Object.defineProperty(fn.Navigator.prototype, 'platform', { configurable: true, get: function () { return 'Win32' } })
  assert.equal(botMarks(fn)['x.bot.plain-getter'], true)
  const value = protoWindow()
  Object.defineProperty(value.Screen.prototype, 'width', { value: 1920 })
  assert.equal(botMarks(value)['x.bot.plain-getter'], true)
  // a proxy around the built-in getter, and an arrow function, have no own prototype
  const proxied = protoWindow()
  const d = Object.getOwnPropertyDescriptor(proxied.Screen.prototype, 'height')
  Object.defineProperty(proxied.Screen.prototype, 'height', { configurable: true, get: new Proxy(d.get, {}) })
  assert.equal(botMarks(proxied)['x.bot.plain-getter'], false)
})

test('own-value does not look at plugins, mimeTypes, the user agent, app version or platform, which extensions people run define on navigator', () => {
  for (const name of ['plugins', 'mimeTypes', 'userAgent', 'appVersion', 'platform']) {
    const w = protoWindow()
    Object.defineProperty(w.navigator, name, { configurable: true, enumerable: true, value: w.Navigator.prototype[name] === undefined ? {} : w.navigator[name] })
    assert.equal(botMarks(w)['x.bot.own-value'], false, name)
  }
})

test('frame-window in the lab writes nothing to the element it makes', () => {
  const w = protoWindow()
  const writes = []
  const create = w.document.createElement
  w.document.createElement = (tag) => new Proxy(create(tag), {
    set: (target, key) => { writes.push(String(key)); return true },
    defineProperty: (target, key) => { writes.push(String(key)); return true },
  })
  botMarks(w)
  assert.deepEqual(writes, [])
})

test('every read that throws or is missing is "!na", never a throw', () => {
  const w = protoWindow()
  const THROW = () => { throw new Error('fault') }
  for (const name of ['Navigator', 'Screen', 'PluginArray', 'Plugin', 'CSS']) Object.defineProperty(w, name, { get: THROW })
  Object.defineProperty(w, 'navigator', { get: THROW })
  Object.defineProperty(w, 'document', { get: THROW })
  Object.defineProperty(w, 'chrome', { get: THROW })
  const marks = botMarks(w)
  for (const key of BOT_KEYS) assert.equal(marks[key], '!na', key)
})

// Each state a candidate looks for, made in the fake window only: none of these is reproduced in a real browser
const POSITIVE = {
  'own-value': (w) => Object.defineProperty(w.navigator, 'language', { configurable: true, value: 'en-US' }),
  'frame-window': (w) => Object.defineProperty(w.HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get: () => ({}) }),
  'frame-srcdoc': (w) => {
    const create = w.document.createElement
    w.document.createElement = (tag) => Object.defineProperty(create(tag), 'srcdoc', { configurable: true, get: () => '', set: () => {} })
  },
  'no-webdriver': (w) => delete w.Navigator.prototype.webdriver,
}

for (const mark of Object.keys(POSITIVE)) {
  test(`${mark} is true on the state it looks for, and no other of these four is`, () => {
    const w = protoWindow()
    POSITIVE[mark](w)
    const marks = botMarks(w)
    for (const other of Object.keys(POSITIVE)) assert.equal(marks['x.bot.' + other], other === mark, other)
  })
}

test('own-value: an own value planted on screen counts too', () => {
  const w = protoWindow()
  Object.defineProperty(w.screen, 'availHeight', { value: 1040 })
  assert.equal(botMarks(w)['x.bot.own-value'], true)
})

test('frame-window: a fresh frame element carrying its own contentWindow counts', () => {
  const w = protoWindow()
  const create = w.document.createElement
  w.document.createElement = (tag) => Object.defineProperty(create(tag), 'contentWindow', { configurable: true, value: null })
  assert.equal(botMarks(w)['x.bot.frame-window'], true)
  assert.equal(botMarks(w)['x.bot.frame-srcdoc'], false)
})

test('frame-srcdoc reads the descriptor of srcdoc on a fresh element and never the attribute itself, and writes nothing', () => {
  const w = protoWindow()
  const touched = []
  const create = w.document.createElement
  w.document.createElement = (tag) => new Proxy(create(tag), {
    get: (target, key, receiver) => { touched.push('get ' + String(key)); return Reflect.get(target, key, receiver) },
    set: (target, key) => { touched.push('set ' + String(key)); return true },
    defineProperty: (target, key) => { touched.push('define ' + String(key)); return true },
  })
  assert.equal(botMarks(w)['x.bot.frame-srcdoc'], false)
  assert.ok(!touched.some((t) => /srcdoc/.test(t) || /^(set|define) /.test(t)), touched.join(', '))
  // an engine with no srcdoc attribute has nothing to look at
  const old = protoWindow()
  delete old.HTMLIFrameElement.prototype.srcdoc
  assert.equal(botMarks(old)['x.bot.frame-srcdoc'], '!na')
})

test('no-webdriver is "!na" where CSS.supports cannot show the engine is recent enough to define webdriver', () => {
  for (const supports of [() => true, () => false]) {
    const w = protoWindow({ supports })
    POSITIVE['no-webdriver'](w)
    assert.equal(botMarks(w)['x.bot.no-webdriver'], '!na')
  }
})

// every read each of these four makes, missing, throwing and returning garbage: "!na", never true, never a throw
const THROWS = () => { throw new Error('fault') }
const FAULTS = {
  'frame-window': {
    'createElement missing': (w) => delete w.document.createElement,
    'createElement throws': (w) => (w.document.createElement = THROWS),
    'createElement garbage': (w) => (w.document.createElement = () => 5),
    'createElement returns a Proxy that throws on every trap': (w) => (w.document.createElement = () => new Proxy({}, { has: THROWS, get: THROWS, getOwnPropertyDescriptor: THROWS })),
    'contentWindow missing': (w) => delete w.HTMLIFrameElement.prototype.contentWindow,
    'contentWindow throws': (w) => Object.defineProperty(w.HTMLIFrameElement.prototype, 'contentWindow', { get: THROWS }),
  },
  'frame-srcdoc': {
    'createElement missing': (w) => delete w.document.createElement,
    'createElement throws': (w) => (w.document.createElement = THROWS),
    'createElement garbage': (w) => (w.document.createElement = () => 5),
    'createElement returns a Proxy that throws on every trap': (w) => (w.document.createElement = () => new Proxy({}, { has: THROWS, get: THROWS, getOwnPropertyDescriptor: THROWS })),
    'srcdoc missing': (w) => delete w.HTMLIFrameElement.prototype.srcdoc,
  },
  'no-webdriver': {
    'CSS missing': (w) => delete w.CSS,
    'CSS.supports throws': (w) => (w.CSS.supports = THROWS),
    'navigator a Proxy that throws': (w) => (w.navigator = new Proxy({}, { has: THROWS, get: THROWS })),
  },
  'own-value': {
    'navigator a Proxy that throws': (w) => (w.navigator = new Proxy({}, { has: THROWS, get: THROWS, getOwnPropertyDescriptor: THROWS })),
    'screen missing': (w) => delete w.screen,
  },
}
for (const mark of Object.keys(FAULTS)) {
  for (const [name, fault] of Object.entries(FAULTS[mark])) {
    test(`${mark} with ${name} is "!na"`, () => {
      const w = protoWindow()
      // the positive state is there too, so a fault that slipped through to an answer would show; an own srcdoc where the engine has
      // none is still an own srcdoc, so that row runs on the plain element
      if (mark !== 'own-value' && name !== 'srcdoc missing') POSITIVE[mark](w)
      fault(w)
      let marks
      assert.doesNotThrow(() => (marks = botMarks(w)))
      assert.equal(marks['x.bot.' + mark], '!na')
    })
  }
}

// built-ins replaced as a page script leaves them, in the realm the observations run in
const REALM = {
  'Object.getOwnPropertyDescriptor missing': [Object, 'getOwnPropertyDescriptor', undefined],
  'Object.getOwnPropertyDescriptor throws': [Object, 'getOwnPropertyDescriptor', THROWS],
  'Object.getOwnPropertyDescriptor answers a descriptor for everything': [Object, 'getOwnPropertyDescriptor', () => ({ value: 1, get: () => {} })],
  'Object.getOwnPropertyDescriptor answers garbage': [Object, 'getOwnPropertyDescriptor', () => 5],
  'Object.getPrototypeOf missing': [Object, 'getPrototypeOf', undefined],
  'Object.getPrototypeOf answers garbage': [Object, 'getPrototypeOf', () => ({})],
}
for (const [name, [owner, key, value]] of Object.entries(REALM)) {
  test(`with ${name}, no candidate reads true and nothing throws`, () => {
    const w = protoWindow()
    const real = owner[key]
    let marks
    try {
      owner[key] = value
      marks = botMarks(w)
    } finally {
      owner[key] = real
    }
    for (const k of BOT_KEYS) assert.notEqual(marks[k], true, k)
  })
}

test('a page wrapper around Object.getOwnPropertyDescriptor that returns the real answer changes nothing', () => {
  const real = Object.getOwnPropertyDescriptor
  let marks
  try {
    Object.getOwnPropertyDescriptor = function (o, p) { return real(o, p) }
    marks = botMarks(protoWindow())
  } finally {
    Object.getOwnPropertyDescriptor = real
  }
  assert.deepEqual(marks, botMarks(protoWindow()))
})
