import { test } from 'node:test'
import assert from 'node:assert/strict'
import { later, start } from '../build/esm/stages.js'
import { labStage } from '../build/esm/labstage.js'
import { inMemory } from '../build/esm/private.js'
import { fakeWindow, cookieJar, storageArea, UA, BROWSERS, dress } from './fake-window.mjs'
import { problems } from '../lab/schema.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const NONE = { textSize: 0, hints: 0, intl: 0, math: 0, canvas: 0, audio: 0, privateWindow: 0 }
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'

// A window whose events, timers and clock are driven by the test.
function harness(options = {}) {
  let time = 1000
  let timers = []
  const messages = []
  const listeners = {}
  const on = (type, fn) => (listeners[type] = listeners[type] || []).push(fn)
  const document = Object.assign(options.document || cookieJar(), { readyState: options.readyState || 'loading', hidden: !!options.hidden, addEventListener: on })
  const w = fakeWindow({ ...options, document })
  Object.assign(w, {
    addEventListener: on,
    performance: { now: () => time },
    setTimeout: (fn, ms) => timers.push({ fn, at: time + (ms || 0) }) && timers.length,
    clearTimeout: (id) => void (timers[id - 1] = null),
    MessageChannel: function () {
      const channel = { port1: {}, port2: { postMessage: () => messages.push(() => channel.port1.onmessage()) } }
      return channel
    },
  })
  const calls = { ...NONE }
  const cost = options.cost || {}
  const spend = (name) => { calls[name]++; time += cost[name] || 0 }
  const probes = {
    textSize: () => { spend('textSize'); if (options.textThrows) throw new Error('boom'); return options.text || { 'x.txt.env': 1.15, 'x.txt.fs': 100, 'x.txt.w': 600.2, 'x.txt.apple': '!na' } },
    hints: (_w, done) => { spend('hints'); done(options.hints || { 'x.ch.model': '!na' }) },
    intl: () => { spend('intl'); return { 'x.tz': 'America/Sao_Paulo', 'x.loc': 'pt-BR', 'x.cal': 'gregory', 'x.num': 'latn', 'x.hc': 'h23' } },
    math: () => { spend('math'); return { 'r.math': 'aaaaaaaaaaaaaaaa' } },
    canvas: () => { spend('canvas'); if (options.canvasThrows) throw new Error('boom'); return { 'r.cg': 'bbbbbbbbbbbbbbbb', 'r.ct': 'cccccccccccccccc' } },
    audio: (_w, done) => { spend('audio'); done({ 'r.audio': 'dddddddddddddddd' }) },
    privateWindow: (_w, _env, done) => { spend('privateWindow'); done({ 'x.private': options.isPrivate === undefined ? false : options.isPrivate }) },
  }
  // what the product build is given: the reads an id or a flag needs, nothing else
  const core = { textSize: probes.textSize, hints: probes.hints, privateWindow: probes.privateWindow }
  const flush = () => { for (let guard = 0; messages.length && guard < 1000; guard++) messages.shift()() }
  return {
    w, calls, probes, core, document,
    fire: (type) => { (listeners[type] || []).splice(0).forEach((fn) => fn()); flush() },
    tick: (ms) => {
      time += ms
      for (let guard = 0; guard < 100; guard++) {
        const due = timers.findIndex((t) => t && t.at <= time)
        if (due < 0) break
        const { fn } = timers[due]
        timers[due] = null
        fn()
        flush()
      }
    },
    flush,
  }
}
const finish = (h) => { h.fire('DOMContentLoaded'); h.document.readyState = 'complete'; h.fire('load'); h.tick(250) }
/** The product build's reading once the page has parsed. `shape` can dress the window as a given browser first. */
const settled = (options, shape) => {
  const h = harness(options)
  if (shape) shape(h.w)
  const session = start(h.w, h.core)
  h.fire('DOMContentLoaded')
  return session.reading()
}

// browsers as the engine detection sees them: by their features, whatever the user agent says
const asBrave = (w) => dress(w, BROWSERS.braveAndroid)
const asSafari = (w) => dress(w, BROWSERS.safari16)
const asSafari17 = (w) => dress(w, BROWSERS.safari17)
const asFirefox = (w) => dress(w, BROWSERS.firefoxDesktop)
const asFirefox142 = (w) => dress(w, BROWSERS.firefox142)

test('the product build is complete at DOMContentLoaded: text size read, both ids built, callback fired, nothing waits for load', () => {
  const h = harness()
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone((reading) => seen.push(reading))
  assert.equal(session.reading().id, null)
  assert.deepEqual(h.calls, NONE)

  h.fire('DOMContentLoaded')
  h.tick(1)
  const r = session.reading()
  assert.equal(r.c['p.txt'], 1.15)
  assert.match(r.id, HEX64)
  assert.match(r.idStrict, HEX64)
  assert.notEqual(r.idStrict, r.id)
  assert.deepEqual(r.flags, { partial: [], auto: [], private: null, weak: false })
  assert.deepEqual(seen, [r])

  h.document.readyState = 'complete'
  h.fire('load')
  h.tick(10000)
  assert.deepEqual(h.calls, { ...NONE, textSize: 1 }, 'the user agent names the model: client hints are not asked')
  assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(r.c).sort(), ['hw.mem', 'hw.model', 'p.lang', 'p.txt', 'x.android', 'x.engine', 'x.txt.apple', 'x.txt.env', 'x.txt.fs', 'x.txt.w'], 'nothing is read that no id or flag uses')
})

test('the lab build adds a stage after load plus an idle moment for the rendering and locale reads, and calls back once at the end', () => {
  const h = harness()
  const session = start(h.w, h.core, labStage(h.probes))
  const seen = []
  session.whenDone((reading) => seen.push(reading))

  h.fire('DOMContentLoaded')
  assert.match(session.reading().id, HEX64)
  assert.equal(h.calls.canvas, 0, 'rendering must not start before load')
  assert.equal(seen.length, 0)

  h.document.readyState = 'complete'
  h.fire('load')
  assert.equal(h.calls.canvas, 0, 'rendering waits for an idle moment after load')
  h.tick(250)
  assert.deepEqual(h.calls, { textSize: 1, hints: 1, intl: 1, math: 1, canvas: 1, audio: 1, privateWindow: 0 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0], session.reading())
  assert.equal(seen[0].c['r.audio'], 'dddddddddddddddd')
  assert.equal(seen[0].c['x.tz'], 'America/Sao_Paulo')
  assert.equal(seen[0].c['x.dpr'], 2.75)
  assert.equal(seen[0].c['x.scr'], '873x393')
  assert.equal(seen[0].c['x.tzo'], new Date().getTimezoneOffset())
  assert.equal(seen[0].c['x.ch.model'], '!na', 'the lab build asks for client hints even when the user agent names the model')
  assert.deepEqual(seen[0].flags.partial, [])
  h.tick(10000)
  assert.equal(seen.length, 1)
})

test('a page that finished loading before the script ran still gets every stage', () => {
  const h = harness({ readyState: 'complete' })
  const session = start(h.w, h.core, labStage(h.probes))
  h.flush()
  h.tick(250)
  assert.equal(h.calls.audio, 1)
  let late = null
  session.whenDone((reading) => (late = reading))
  assert.equal(late, null, 'the callback is never called before whenDone returns')
  h.tick(1)
  assert.equal(late, session.reading())
})

test('lab build: when load never fires (a hung pixel), the last stage stops waiting for it after 3 seconds, then still waits for an idle moment', () => {
  const h = harness()
  start(h.w, h.core, labStage(h.probes))
  h.fire('DOMContentLoaded')
  h.tick(2900)
  assert.equal(h.calls.canvas, 0)
  // no idle callback in this window: the short timer after the wait stands in for it
  h.tick(200)
  assert.equal(h.calls.canvas, 0, 'the 3 seconds end the wait for load, not the wait for an idle moment')
  h.tick(200)
  assert.equal(h.calls.canvas, 1)
})

test('lab build: rendering waits while the page is hidden', () => {
  const h = harness({ hidden: true })
  start(h.w, h.core, labStage(h.probes))
  finish(h)
  assert.equal(h.calls.canvas, 0)
  h.document.hidden = false
  h.fire('visibilitychange')
  assert.equal(h.calls.canvas, 1)
})

test('a reduced user agent gets its model from client hints, and only then an id', () => {
  const h = harness({ ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': 'Pixel 99', 'x.ch.pv': '16.0.0', 'x.ch.brands': 'Google Chrome', 'x.ch.mobile': true } })
  const session = start(h.w, h.core)
  assert.equal(session.reading().id, null)
  h.fire('DOMContentLoaded')
  assert.equal(h.calls.hints, 1)
  assert.equal(session.reading().c['hw.model'], 'Pixel 99')
  assert.equal(session.reading().model, 'Pixel 99')
  assert.match(session.reading().id, HEX64)
  assert.deepEqual(session.reading().flags.partial, [])
})

test('no model anywhere: screen size and core count stand in for it, and the reading says the id is weak', () => {
  const r = settled({ ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': '' } })
  assert.deepEqual([r.c['hw.model'], r.c['hw.scr'], r.c['hw.cores']], ['!na', '873x393', 8])
  assert.match(r.id, HEX64)
  assert.equal(r.flags.weak, true)
})

test('a phone that names its model is identified by it: screen and cores are not even read', () => {
  const r = settled()
  assert.equal(r.c['hw.model'], 'SM-X135FU')
  for (const key of ['hw.scr', 'hw.cores', 'x.scr', 'x.cores']) assert.ok(!(key in r.c), key)
  assert.equal(r.flags.weak, false)
})

test('Brave randomises memory and core count: both are excluded from the id, in the product and the lab build alike', () => {
  const noModel = { ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': '' } }
  const r = settled(noModel, asBrave)
  assert.deepEqual([r.c['hw.mem'], r.c['hw.cores'], r.c['hw.scr']], ['!ex', '!ex', '873x393'])
  assert.match(r.id, HEX64)

  const lab = harness(noModel)
  asBrave(lab.w)
  const session = start(lab.w, lab.core, labStage(lab.probes))
  finish(lab)
  assert.equal(session.reading().id, r.id, 'the lab build must report the id the product would')
  assert.equal(session.reading().c['x.mem'], 4, 'the raw value stays visible as a hint')
})

test('Brave on desktop alters the screen resolution (its farbling page, id version 3): memory, cores and the screen are excluded there', () => {
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  const r = settled({ ua: desktop, hints: { 'x.ch.model': '' } }, (w) => dress(w, BROWSERS.braveDesktop))
  assert.deepEqual([r.c['hw.model'], r.c['hw.mem'], r.c['hw.cores'], r.c['hw.scr']], ['!na', '!ex', '!ex', '!ex'])
  assert.match(r.id, HEX64)
  assert.equal(r.c['x.scr'], '873x393', 'the raw value stays visible as a hint')
  // the Android build keeps it: measured equal to Chrome's on one Pixel, in Brave's normal and private windows
  const android = settled({ ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': '' } }, asBrave)
  assert.equal(android.c['hw.scr'], '873x393')
  // Chrome on the same desktop keeps it too
  const chrome = settled({ ua: desktop, hints: { 'x.ch.model': '' } }, (w) => dress(w, BROWSERS.chromeDesktop))
  assert.deepEqual([chrome.c['hw.mem'], chrome.c['hw.cores'], chrome.c['hw.scr']], [4, 8, '873x393'])
})

test('Safari 17 and newer changes the screen size in private windows: the screen is excluded there', () => {
  const safari = settled({ ua: SAFARI }, asSafari17)
  assert.deepEqual([safari.c['hw.model'], safari.c['hw.scr'], safari.c['hw.cores']], ['!na', '!ex', 8])
  const safari16 = settled({ ua: SAFARI }, asSafari)
  assert.equal(safari16.c['hw.scr'], '873x393')
})

test('the Safari 17 rule covers every WebKit browser at that level: Chrome on an iPhone has the screen excluded too', () => {
  const chromeIos = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.8078.50 Mobile/15E148 Safari/604.1' }
  const r = settled(chromeIos, asSafari17)
  assert.deepEqual([r.c['x.engine'], r.c['hw.model'], r.c['hw.scr']], ['webkit', '!na', '!ex'])
})

test('a page that breaks CSS.supports keeps the Safari 17 exclusion, and makes Firefox 143 and newer read as an older Firefox', () => {
  const broken = (dressed) => (w) => { dressed(w); w.CSS = { supports() { throw new Error('fault') } } }
  const safari = settled({ ua: SAFARI }, broken(asSafari17))
  assert.deepEqual([safari.c['x.engine'], safari.c['hw.scr']], ['webkit', '!ex'])
  const firefox = settled({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0' }, broken(asFirefox))
  assert.deepEqual([firefox.c['x.engine'], firefox.c['hw.scr'], firefox.c['hw.cores']], ['gecko', '873x393', 8])
})

test('Firefox 143 and newer: screen and cores are excluded in every window, so private and normal windows give one id', () => {
  const noModel = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0' }
  const firefox = settled(noModel, asFirefox)
  assert.deepEqual([firefox.c['x.engine'], firefox.c['hw.model'], firefox.c['hw.scr'], firefox.c['hw.cores'], firefox.c['hw.mem']], ['gecko', '!na', '!ex', '!ex', 4])
  const older = settled(noModel, asFirefox142)
  assert.deepEqual([older.c['x.engine'], older.c['hw.scr'], older.c['hw.cores']], ['gecko', '873x393', 8])
})

test('text size: Chrome, a current in-app browser and an old in-app browser on one phone agree, and the setting separates two phones', () => {
  const text = (env, fs) => ({ text: { 'x.txt.env': env, 'x.txt.fs': fs, 'x.txt.w': 600, 'x.txt.apple': '!na' } })
  const chrome = settled(text(1.15, 100))
  const webView = settled(text(1.15, 115))
  const oldWebView = settled(text(1, 115))
  assert.deepEqual([chrome.c['p.txt'], webView.c['p.txt'], oldWebView.c['p.txt']], [1.15, 1.15, 1.15])
  assert.equal(webView.id, chrome.id)
  assert.equal(oldWebView.id, chrome.id)
  const defaultSize = settled(text(1, 100))
  assert.equal(defaultSize.c['p.txt'], 1)
  assert.notEqual(defaultSize.id, chrome.id)
})

test('text size on iPhone is the Dynamic Type body size', () => {
  const r = settled({ ua: SAFARI, text: { 'x.txt.env': 1, 'x.txt.fs': 100, 'x.txt.w': 602.1, 'x.txt.apple': 19 } }, asSafari)
  assert.equal(r.c['p.txt'], 19)
})

test('an app and browser update keeps the id and changes the strict id', () => {
  const before = settled()
  const after = settled({ ua: UA.facebookAndroidUpdated })
  assert.equal(after.id, before.id)
  assert.match(after.idStrict, HEX64)
  assert.notEqual(after.idStrict, before.idStrict)
  assert.equal(after.appVer, '586.0.0.1.1')
})

test('two fresh storages on one phone (a normal and a private window) share both ids and get different stored ids', () => {
  const normal = settled()
  const privateWindow = settled()
  assert.equal(privateWindow.id, normal.id)
  assert.equal(privateWindow.idStrict, normal.idStrict)
  assert.notEqual(privateWindow.did, normal.did)
})

test('a different language, memory size or text size gives a different id', () => {
  const base = settled().id
  assert.notEqual(settled({ language: 'hi-IN' }).id, base)
  assert.notEqual(settled({ deviceMemory: 8 }).id, base)
  assert.notEqual(settled({ text: { 'x.txt.env': 1.3, 'x.txt.fs': 100, 'x.txt.w': 600, 'x.txt.apple': '!na' } }).id, base)
})

test('storage blocked: no stored id, the id is still built', () => {
  const r = settled({ document: cookieJar({}, { blocked: true }), localStorage: null })
  assert.equal(r.did, null)
  assert.match(r.id, HEX64)
})

test('lab build: the running-time cap stops the remaining reads, names them, and still calls back', () => {
  const h = harness({ cost: { intl: 2500, canvas: 2500 } })
  const session = start(h.w, h.core, labStage(h.probes))
  let done = null
  session.whenDone((reading) => (done = reading))
  finish(h)
  assert.equal(h.calls.audio, 0)
  assert.equal(done.c['r.audio'], '!to')
  assert.deepEqual(done.flags.partial, ['r.audio'])
  assert.match(done.id, HEX64, 'a rendering read that timed out does not take the id away')
})

test('lab build: a read that throws is recorded as failed and the others still run', () => {
  const h = harness({ canvasThrows: true })
  const session = start(h.w, h.core, labStage(h.probes))
  finish(h)
  assert.equal(session.reading().c['r.cg'], '!err')
  assert.equal(session.reading().c['r.ct'], '!err')
  assert.equal(session.reading().c['r.audio'], 'dddddddddddddddd')
})

/** A canvas read in steps that records, for each step, how many times the page had been given a turn when it ran. */
const steppedCanvas = (h, options = {}) => {
  let turns = 0
  const Real = h.w.MessageChannel
  h.w.MessageChannel = function () {
    const channel = new Real()
    const port1 = {}
    Object.defineProperty(port1, 'onmessage', { set(fn) { channel.port1.onmessage = () => { turns++; fn() } } })
    return { port1, port2: channel.port2 }
  }
  const names = ['pattern', 'scene', 'hash']
  const ran = []
  let made = 0
  let index = 0
  const probes = {
    ...h.probes,
    canvasSteps: () => {
      made++
      return {
        names,
        next: () => {
          if (index >= names.length) return false
          ran.push([names[index], turns])
          if (options.cost) h.tick(options.cost)
          index++
          return index < names.length
        },
        parts: () => (index >= names.length ? { 'r.cg': 'eeeeeeeeeeeeeeee', 'r.ct': 'ffffffffffffffff' } : { 'r.cg': '!to', 'r.ct': '!to' }),
      }
    },
  }
  return { probes, ran, made: () => made }
}

test('lab build: a canvas read given as steps runs one step per task, so the page has a turn between any two', () => {
  const h = harness()
  const stepped = steppedCanvas(h)
  const session = start(h.w, h.core, labStage(stepped.probes))
  h.fire('DOMContentLoaded')
  h.document.readyState = 'complete'
  h.fire('load')
  assert.equal(stepped.ran.length, 0, 'no step runs before the stage starts')
  h.tick(250)
  const r = session.reading()
  assert.deepEqual(stepped.ran.map((s) => s[0]), ['pattern', 'scene', 'hash'])
  for (let i = 1; i < stepped.ran.length; i++) assert.ok(stepped.ran[i][1] > stepped.ran[i - 1][1], `the page had a turn before step ${stepped.ran[i][0]}`)
  assert.equal(stepped.made(), 1)
  assert.equal(h.calls.canvas, 0, 'the single-call canvas read is not used when steps are given')
  assert.equal(r.c['r.cg'], 'eeeeeeeeeeeeeeee')
  assert.equal(r.c['r.ct'], 'ffffffffffffffff')
  for (const name of ['canvas:pattern', 'canvas:scene', 'canvas:hash']) assert.equal(typeof r.t[name], 'number', `${name} is timed on its own`)
  assert.equal(r.c['r.audio'], 'dddddddddddddddd')
})

test('lab build: when the running-time cap ends a stepped canvas read part way, its values are "!to" and the rest still reports', () => {
  const h = harness({ cost: { intl: 2000 } })
  const stepped = steppedCanvas(h, { cost: 1500 })
  const session = start(h.w, h.core, labStage(stepped.probes))
  let done = null
  session.whenDone((reading) => (done = reading))
  finish(h)
  assert.deepEqual(stepped.ran.map((s) => s[0]), ['pattern', 'scene'], 'the cap stops the sequence before its last step')
  assert.equal(done.c['r.cg'], '!to')
  assert.equal(done.c['r.ct'], '!to')
  assert.ok(done.flags.partial.includes('r.cg'))
  assert.match(done.id, HEX64)
})

test('a text-size read that fails leaves no id rather than a different one', () => {
  const r = settled({ textThrows: true })
  assert.equal(r.c['p.txt'], '!err')
  assert.equal(r.id, null)
  assert.equal(r.idStrict, null)
  assert.ok(r.flags.partial.includes('p.txt'))
})

test('a second page view within 24 hours reuses the complete reading: both ids at script start, no probe run', () => {
  const document = cookieJar()
  const localStorage = storageArea()
  const first = harness({ document, localStorage })
  const a = start(first.w, first.core)
  finish(first)

  const second = harness({ document: cookieJar(document.values), localStorage })
  const b = start(second.w, second.core)
  assert.equal(b.reading().id, a.reading().id, 'ready before any event')
  assert.equal(b.reading().idStrict, a.reading().idStrict)
  let done = null
  b.whenDone((reading) => (done = reading))
  second.tick(1)
  assert.deepEqual(second.calls, NONE)
  assert.equal(done.c['x.txt.env'], 1.15)
  assert.equal(done.didNew, false, 'the stored-id fields are read live, never taken from the cache')
})

test('the cache is ignored after a browser update, after 24 hours, and when it is not valid JSON', () => {
  const localStorage = storageArea()
  const first = harness({ localStorage })
  start(first.w, first.core)
  finish(first)
  const saved = localStorage.values._visito_c
  assert.ok(saved, 'a complete reading was cached')

  const updated = harness({ localStorage, ua: UA.facebookAndroidUpdated })
  start(updated.w, updated.core)
  finish(updated)
  assert.equal(updated.calls.textSize, 1)

  localStorage.values._visito_c = JSON.stringify({ ...JSON.parse(saved), t: Date.now() - 25 * 3600 * 1000 })
  const stale = harness({ localStorage })
  start(stale.w, stale.core)
  finish(stale)
  assert.equal(stale.calls.textSize, 1)

  localStorage.values._visito_c = '{broken'
  const broken = harness({ localStorage })
  start(broken.w, broken.core)
  finish(broken)
  assert.equal(broken.calls.textSize, 1)
})

test('an incomplete reading is never cached', () => {
  const localStorage = storageArea()
  const h = harness({ localStorage, textThrows: true })
  start(h.w, h.core)
  finish(h)
  assert.equal(localStorage.values._visito_c, undefined)
})

test('the lab build reads everything fresh on every page view: nothing is cached', () => {
  const localStorage = storageArea()
  const h = harness({ localStorage })
  start(h.w, h.core, labStage(h.probes))
  finish(h)
  assert.equal(h.calls.canvas, 1)
  assert.equal(localStorage.values._visito_c, undefined)
})

test('inside a frame the session is silent and still calls back', () => {
  const h = harness()
  h.w.self = h.w
  h.w.top = {}
  const session = start(h.w, h.core)
  let got = 'unset'
  session.whenDone((reading) => (got = reading))
  h.tick(1)
  assert.equal(session.reading(), null)
  assert.equal(got, null)
})

test('lab build: an idle callback that exists but never fires does not hold the rendering stage forever', () => {
  const h = harness({ readyState: 'complete', extra: { requestIdleCallback: () => {} } })
  start(h.w, h.core, labStage(h.probes))
  h.flush()
  h.tick(2400)
  assert.equal(h.calls.canvas, 0)
  h.tick(200)
  assert.equal(h.calls.canvas, 1)
})

test('a document that never reports DOMContentLoaded still gets stage B after 10 seconds', () => {
  const h = harness()
  start(h.w, h.core)
  h.tick(9900)
  assert.equal(h.calls.textSize, 0)
  h.tick(200)
  assert.equal(h.calls.textSize, 1)
})

test('if the page never gives the library its turn back, the watchdog still calls back with what exists: the stored id, and no id', () => {
  const h = harness({ readyState: 'complete' })
  h.w.MessageChannel = function () {
    return { port1: {}, port2: { postMessage() {} } }
  }
  const session = start(h.w, h.core)
  let done = null
  session.whenDone((reading) => (done = reading))
  h.tick(29000)
  assert.equal(done, null)
  h.tick(1100)
  assert.equal(done, session.reading())
  assert.ok(done.did)
  assert.equal(done.id, null)
  assert.equal(done.c['x.txt.env'], '!to')
  assert.ok(done.flags.partial.includes('p.txt'))
  h.tick(60000)
  assert.equal(h.calls.textSize, 0, 'nothing runs after the callback')
})

test('the private-window check is skipped in Chrome, where it cannot work', () => {
  const h = harness()
  const session = start(h.w, h.core)
  finish(h)
  assert.equal(h.calls.privateWindow, 0)
  assert.equal(session.reading().flags.private, null)
})

test('in a WebKit browser with a brand-new stored id, the private-window check runs and its answer is reported', () => {
  const h = harness({ isPrivate: true })
  asSafari(h.w)
  const session = start(h.w, h.core)
  finish(h)
  assert.equal(h.calls.privateWindow, 1)
  assert.equal(session.reading().flags.private, true)
  assert.equal(h.w.localStorage.values._visito_c.includes('x.private'), false, 'the answer belongs to this visit and is never cached')
})

// The real check, given a file system that opens or is refused with the name each engine documents. asFirefox is the Firefox build above.
const fileSystem = (w, outcome) => {
  w.isSecureContext = true
  w.navigator.storage = { getDirectory: () => (outcome === 'opens' ? Promise.resolve({}) : Promise.reject({ name: outcome })) }
}
const realCheck = async (shape, outcome, options) => {
  const h = harness(options)
  shape(h.w)
  fileSystem(h.w, outcome)
  const core = { ...h.core, privateWindow: (w, env, done) => inMemory(w, env, done) }
  const session = start(h.w, core)
  finish(h)
  await new Promise((resolve) => setImmediate(resolve))
  h.flush()
  h.tick(250)
  return session.reading()
}

test('with the real check, Safari refusing the file system as UnknownError is a private window, and opening it is a normal one', async () => {
  const privateTab = await realCheck(asSafari, 'UnknownError')
  assert.equal(privateTab.c['x.engine'], 'webkit')
  assert.equal(privateTab.flags.private, true)
  assert.equal((await realCheck(asSafari, 'opens')).flags.private, false)
  assert.equal((await realCheck(asSafari, 'TypeError')).flags.private, null, 'storage blocked by policy cannot be told')
})

test('with the real check, Firefox refusing the file system as SecurityError is a private window; opening it says nothing', async () => {
  const privateWindow = await realCheck(asFirefox, 'SecurityError')
  assert.equal(privateWindow.c['x.engine'], 'gecko')
  assert.equal(privateWindow.flags.private, true)
  assert.equal((await realCheck(asFirefox, 'opens')).flags.private, null, 'private windows are getting a file system, so an open one proves nothing')
  assert.equal((await realCheck(asFirefox, 'SecurityError', { localStorage: null })).flags.private, null, 'storage blocked for the site refuses the same way and cannot be told')
})

test('later: a page whose timer throws gets the call made now, and nothing thrown', () => {
  const broken = () => { throw new Error('page broke setTimeout') }
  const saved = globalThis.setTimeout
  let calls = 0
  // in a browser the global timer is the window's own, so both are broken together
  globalThis.setTimeout = broken
  try {
    assert.doesNotThrow(() => later({ setTimeout: broken }, () => calls++, 0))
  } finally {
    globalThis.setTimeout = saved
  }
  assert.equal(calls, 1)
})

test('a stored id that was already there proves the storage is not fresh: no private-window check', () => {
  const h = harness({ document: cookieJar({ _visito: '11111111-2222-4333-8444-555555555555' }) })
  asSafari(h.w)
  const session = start(h.w, h.core)
  finish(h)
  assert.equal(h.calls.privateWindow, 0)
  assert.equal(session.reading().flags.private, null)
})

test('a read that waits on the browser is charged only for the time it kept the page busy', () => {
  const h = harness()
  let answer = null
  h.core.hints = (_w, done) => { answer = done }
  h.w.navigator.userAgent = UA.chromeAndroidReduced
  const session = start(h.w, h.core)
  h.fire('DOMContentLoaded')
  const before = session.reading().ms
  h.tick(700)
  answer({ 'x.ch.model': '!na' })
  h.flush()
  assert.equal(session.reading().t.hints, 0)
  assert.equal(session.reading().ms, before)
  assert.equal(session.reading().c['x.ch.model'], '!na')
})

test('a page that broke Math cannot be hashed: no id, the reading says so, nothing is thrown and the callback still fires', () => {
  const h = harness()
  const session = start(h.w, h.core)
  let done = null
  session.whenDone((reading) => (done = reading))
  const floor = Math.floor
  Math.floor = () => {
    throw new Error('fault')
  }
  try {
    assert.doesNotThrow(() => h.fire('DOMContentLoaded'))
  } finally {
    Math.floor = floor
  }
  h.tick(1)
  assert.equal(done, session.reading())
  assert.ok(done.did)
  assert.equal(done.id, null)
  assert.equal(done.idStrict, null)
  assert.deepEqual(done.flags.partial, ['x.id'])
})

// A page can replace a built-in after the script ran stage A and before the document has parsed. Each scenario reaches a different part of the path to the callback.
const SCENARIOS = {
  'a phone that names its model': {},
  'a reduced user agent': { ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': 'Pixel 99', 'x.ch.pv': '16.0.0' } },
  'a reduced user agent whose hints name no model (desktop Chromium)': { ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': '', 'x.ch.pv': '15.0.0' } },
  'a read that never answers (the watchdog)': { ua: UA.chromeAndroidReduced, hang: true },
  'a page without a usable performance clock': { noClock: true },
}
const broken = (options, target, name, value) => {
  const localStorage = storageArea()
  const h = harness({ ...options, localStorage })
  if (options.hang) h.core.hints = () => {}
  if (options.noClock) h.w.performance = {}
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone((reading) => seen.push(reading))
  const saved = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, { configurable: true, writable: true, value })
  let threw = null
  try {
    h.fire('DOMContentLoaded')
    h.tick(31000)
  } catch (e) {
    threw = e
  } finally {
    Object.defineProperty(target, name, saved)
  }
  h.tick(1)
  return { threw, seen, reading: session.reading(), cached: localStorage.values._visito_c }
}
const fault = () => {
  throw new Error('fault')
}
const POST_START = [
  ['Array.prototype', Array.prototype, 'sort'], ['Array.prototype', Array.prototype, 'join'], ['Array.prototype', Array.prototype, 'concat'],
  ['Object', Object, 'keys'], ['Object.prototype', Object.prototype, 'hasOwnProperty'], ['Math', Math, 'round'], ['Math', Math, 'floor'],
  ['String.prototype', String.prototype, 'charAt'], ['String.prototype', String.prototype, 'replace'], ['RegExp.prototype', RegExp.prototype, 'test'],
  ['JSON', JSON, 'stringify'], ['Date', Date, 'now'],
]
for (const [label, target, name] of POST_START) {
  test(`${label}.${name} broken after script start: nothing reaches the page, the callback fires once, an incomplete reading says so and is not cached`, () => {
    for (const [scenario, options] of Object.entries(SCENARIOS)) {
      for (const [mode, value] of [['throws', fault], ['removed', undefined]]) {
        const where = `${scenario}, ${mode}`
        const { threw, seen, reading, cached } = broken(options, target, name, value)
        assert.equal(threw, null, `${where}: ${threw}`)
        assert.equal(seen.length, 1, `${where}: called back once`)
        assert.equal(seen[0], reading, where)
        assert.deepEqual(problems(reading), [], where)
        assert.equal(reading.id === null, reading.flags.partial.length > 0, `${where}: an id exactly when nothing is partial`)
        if (reading.flags.partial.length) assert.equal(cached, undefined, `${where}: never cached`)
      }
    }
  })
}

test('a page with no usable performance clock that breaks Date.now after script start gets its callback at stage B, not from the watchdog', () => {
  for (const value of [fault, undefined]) {
    const h = harness()
    h.w.performance = {}
    const session = start(h.w, h.core)
    const seen = []
    session.whenDone((reading) => seen.push(reading))
    const now = Date.now
    Date.now = value
    try {
      assert.doesNotThrow(() => h.fire('DOMContentLoaded'))
      h.tick(1)
    } finally {
      Date.now = now
    }
    assert.deepEqual(seen, [session.reading()])
    assert.match(session.reading().id, HEX64)
  }
})

test('a page with no usable performance clock whose Date.now answers something that is no number after script start gets its reading, and nothing is thrown', () => {
  const answers = { 'an object whose conversion throws': { valueOf: fault, toString: fault }, 'a Symbol': Symbol('now'), 'a BigInt': 1n, NaN: NaN }
  for (const [label, value] of Object.entries(answers)) {
    const h = harness()
    h.w.performance = {}
    const session = start(h.w, h.core)
    const seen = []
    session.whenDone((reading) => seen.push(reading))
    const now = Date.now
    Date.now = () => value
    try {
      assert.doesNotThrow(() => h.fire('DOMContentLoaded'), label)
      h.tick(1)
    } finally {
      Date.now = now
    }
    assert.deepEqual(seen, [session.reading()], label)
    assert.match(session.reading().id, HEX64, label)
    // the clock always gives a finite number, so every time the reading reports is one too
    for (const ms of [session.reading().ms, ...Object.values(session.reading().t)]) assert.ok(Number.isFinite(ms), `${label}: ${ms}`)
  }
})

test('with no message channel and a timer that schedules its function and then throws, each step of a stage runs once', () => {
  const h = harness({ ua: UA.chromeAndroidReduced })
  h.w.MessageChannel = undefined
  let answer = null
  let asked = 0
  h.core.hints = (_w, done) => {
    asked++
    answer = done
  }
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone((reading) => seen.push(reading))
  const schedule = h.w.setTimeout
  const timer = globalThis.setTimeout
  // in a browser the global timer is the window's: both are wrapped together
  h.w.setTimeout = globalThis.setTimeout = (fn, ms) => {
    schedule(fn, ms)
    throw new Error('fault')
  }
  try {
    assert.doesNotThrow(() => h.fire('DOMContentLoaded'))
    h.tick(1)
    // the steps the timer scheduled as well must not move on while the client hints are still out
    assert.deepEqual(seen, [], 'nothing settles before the last task has answered')
    assert.doesNotThrow(() => answer({ 'x.ch.model': 'Pixel 99', 'x.ch.pv': '16.0.0' }))
    h.tick(1)
  } finally {
    globalThis.setTimeout = timer
  }
  h.tick(31000)
  assert.equal(h.calls.textSize, 1)
  assert.equal(asked, 1)
  assert.deepEqual(seen, [session.reading()])
  assert.equal(session.reading().model, 'Pixel 99')
  assert.match(session.reading().id, HEX64)
})

test('a complete reading is cached even when the page breaks Object.prototype.hasOwnProperty after script start', () => {
  for (const value of [fault, undefined]) {
    const { reading, cached } = broken({}, Object.prototype, 'hasOwnProperty', value)
    assert.match(reading.id, HEX64)
    assert.equal(typeof cached, 'string')
  }
})

test('a cached reading is replayed on a page that broke Object.prototype.hasOwnProperty before the script started', () => {
  const localStorage = storageArea()
  const first = harness({ localStorage })
  const earlier = start(first.w, first.core).reading()
  finish(first)
  const second = harness({ localStorage })
  const hasOwnProperty = Object.prototype.hasOwnProperty
  let session
  Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: true, writable: true, value: fault })
  try {
    session = start(second.w, second.core)
  } finally {
    Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: true, writable: true, value: hasOwnProperty })
  }
  second.fire('DOMContentLoaded')
  assert.equal(second.calls.textSize, 0)
  assert.equal(session.reading().t.cache, 0)
  assert.equal(session.reading().id, earlier.id)
})

test('a page that broke Array.prototype.push before the script started still gets a stored id from the crypto source', () => {
  const crypto = { getRandomValues: (buffer) => buffer.fill(0xab) }
  const h = harness({ extra: { crypto } })
  const push = Array.prototype.push
  let session
  Array.prototype.push = fault
  try {
    session = start(h.w, h.core)
  } finally {
    Array.prototype.push = push
  }
  assert.equal(session.reading().did, 'abababab-abab-4bab-abab-abababababab')
})

test('a timer that schedules its function and then throws still runs each callback once', () => {
  const h = harness()
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone((reading) => seen.push(reading))
  const schedule = h.w.setTimeout
  const timer = globalThis.setTimeout
  // in a browser the global timer is the window's: both are wrapped together
  h.w.setTimeout = globalThis.setTimeout = (fn, ms) => {
    schedule(fn, ms)
    throw new Error('fault')
  }
  try {
    assert.doesNotThrow(() => h.fire('DOMContentLoaded'))
  } finally {
    globalThis.setTimeout = timer
  }
  h.tick(31000)
  assert.deepEqual(seen, [session.reading()])
})

test('a page that breaks sorting after script start gets no id, the hash named as failed, no cache entry, and its callback', () => {
  const { threw, seen, reading, cached } = broken({}, Array.prototype, 'sort', fault)
  assert.equal(threw, null)
  assert.deepEqual(seen, [reading])
  assert.ok(reading.did)
  assert.equal(reading.id, null)
  assert.equal(reading.idStrict, null)
  assert.deepEqual(reading.flags.partial, ['x.id'])
  assert.equal(cached, undefined)
})

test('a built-in that no id needs, broken after script start, leaves the reading complete', () => {
  for (const [target, name] of [[Object.prototype, 'hasOwnProperty'], [Math, 'round'], [String.prototype, 'charAt'], [Array.prototype, 'concat']]) {
    for (const options of [SCENARIOS['a phone that names its model'], SCENARIOS['a reduced user agent']]) {
      const { reading } = broken(options, target, name, fault)
      assert.deepEqual(reading.flags.partial, [], name)
      assert.match(reading.id, HEX64, name)
    }
  }
})

test('asking for the reading while the page has broken Array.prototype.push neither throws nor loses the callback', () => {
  const h = harness()
  const session = start(h.w, h.core)
  const push = Array.prototype.push
  let got = null
  Array.prototype.push = fault
  try {
    assert.doesNotThrow(() => session.whenDone((reading) => (got = reading)))
  } finally {
    Array.prototype.push = push
  }
  finish(h)
  assert.equal(got, session.reading())
})

test('each callback runs in its own task, so one that throws does not stop the others', () => {
  const h = harness()
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone(() => {
    seen.push('first')
    throw new Error('page code')
  })
  session.whenDone(() => seen.push('second'))
  h.fire('DOMContentLoaded')
  assert.throws(() => h.tick(1), /page code/, "the page's own error surfaces as its own")
  h.tick(1)
  assert.deepEqual(seen, ['first', 'second'])
})

test('a page whose timers throw still gets every callback, even when one of them throws, and nothing reaches the page', () => {
  const h = harness()
  const session = start(h.w, h.core)
  const seen = []
  session.whenDone(() => {
    seen.push('first')
    throw new Error('page code')
  })
  session.whenDone((reading) => seen.push(reading))
  const timer = globalThis.setTimeout
  // in a browser the global timer is the window's: both are broken together
  h.w.setTimeout = globalThis.setTimeout = fault
  try {
    assert.doesNotThrow(() => h.fire('DOMContentLoaded'))
  } finally {
    globalThis.setTimeout = timer
  }
  assert.deepEqual(seen, ['first', session.reading()])
  assert.match(session.reading().id, HEX64)
})

test('a user agent that hides the model hides the OS version too: client hints give both, and the strict id uses it', () => {
  const hints = (pv) => ({ ua: UA.chromeAndroidReduced, hints: { 'x.ch.model': 'Pixel 99', 'x.ch.pv': pv, 'x.ch.brands': 'Chromium,Android WebView', 'x.ch.mobile': true } })
  const android17 = settled(hints('17.0.0'))
  assert.equal(android17.osVer, '17', 'written the way an in-app browser that names it writes it')
  assert.equal(settled(hints('8.1.0')).osVer, '8.1')
  assert.equal(settled(hints('!na')).osVer, null)

  const android16 = settled(hints('16.0.0'))
  assert.equal(android16.id, android17.id)
  assert.notEqual(android16.idStrict, android17.idStrict)
})

test('an OS version the user agent states is kept as it is', () => {
  assert.equal(settled().osVer, '12')
})

// The lab stage's start rule (research/specs/small-reads.md, 5.3), on a window whose listeners stay until removed, as a browser's do.
function idleWindow({ readyState = 'loading', hidden = false, idle = 'none', listenThrows = false } = {}) {
  let time = 0
  const timers = []
  const listeners = []
  const idles = []
  const target = (owner) => ({
    addEventListener: (type, fn) => {
      if (listenThrows) throw new Error('fault')
      if (!listeners.some((l) => l.owner === owner && l.type === type && l.fn === fn)) listeners.push({ owner, type, fn })
    },
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((l) => l.owner === owner && l.type === type && l.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  })
  const document = { readyState, hidden, ...target('document') }
  const w = { document, ...target('window'), setTimeout: (fn, ms) => void timers.push({ fn, at: time + (ms || 0) }) }
  if (idle === 'records') w.requestIdleCallback = (fn, options) => void idles.push({ fn, options })
  if (idle === 'throws') w.requestIdleCallback = () => { throw new Error('fault') }
  let went = 0
  labStage({}).wait(w, () => went++)
  return {
    w, document, idles,
    went: () => went,
    listening: () => listeners.map((l) => `${l.owner} ${l.type}`),
    fire: (owner, type) => listeners.filter((l) => l.owner === owner && l.type === type).forEach((l) => l.fn()),
    tick: (ms) => {
      time += ms
      for (let guard = 0; guard < 100; guard++) {
        const due = timers.filter((t) => !t.done && t.at <= time).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.done = true
        due.fn()
      }
    },
  }
}

test('lab stage start: load and the 3-second wait for it both happening start the stage once', () => {
  const s = idleWindow()
  s.document.readyState = 'complete'
  s.fire('window', 'load')
  s.tick(5000)
  assert.equal(s.went(), 1)
})

test('lab stage start: the idle moment is asked for with a 2-second timeout, and the idle callback and its 2.5-second backstop together start the stage once', () => {
  const s = idleWindow({ readyState: 'complete', idle: 'records' })
  assert.equal(s.idles.length, 1)
  assert.deepEqual(s.idles[0].options, { timeout: 2000 })
  s.idles[0].fn()
  assert.equal(s.went(), 1)
  s.tick(3000)
  assert.equal(s.went(), 1)
})

test('lab stage start: the backstop starts the stage 2.5 seconds after the idle request when the idle callback never comes', () => {
  const s = idleWindow({ readyState: 'complete', idle: 'records' })
  s.tick(2400)
  assert.equal(s.went(), 0)
  s.tick(100)
  assert.equal(s.went(), 1)
})

test('lab stage start: after the 3-second wait for a load that never comes, an idle moment is still asked for', () => {
  const s = idleWindow({ idle: 'records' })
  s.tick(2999)
  assert.equal(s.idles.length, 0)
  s.tick(1)
  assert.equal(s.went(), 0, 'the wait for load ends; the stage has not started')
  assert.equal(s.idles.length, 1)
  s.idles[0].fn()
  assert.equal(s.went(), 1)
  s.document.readyState = 'complete'
  s.fire('window', 'load')
  s.tick(10000)
  assert.equal(s.idles.length, 1, 'a late load asks for nothing more')
  assert.equal(s.went(), 1)
})

test('lab stage start: without an idle callback, or with one that throws, the stage starts 200 ms after load', () => {
  for (const idle of ['none', 'throws']) {
    const s = idleWindow({ readyState: 'complete', idle })
    s.tick(199)
    assert.equal(s.went(), 0, idle)
    s.tick(1)
    assert.equal(s.went(), 1, idle)
  }
})

test('lab stage start: a hidden page waits for a visibilitychange that shows it, however many times the event fires', () => {
  const s = idleWindow({ readyState: 'complete', hidden: true })
  s.tick(10000)
  assert.equal(s.went(), 0)
  s.fire('document', 'visibilitychange')
  assert.equal(s.went(), 0, 'still hidden')
  s.document.hidden = false
  s.fire('document', 'visibilitychange')
  s.fire('document', 'visibilitychange')
  assert.equal(s.went(), 1)
})

test('lab stage start: a hidden value that is not true, or that cannot be read, counts as visible', () => {
  for (const hidden of ['yes', 1, {}, undefined]) {
    const s = idleWindow({ readyState: 'complete', hidden })
    s.tick(200)
    assert.equal(s.went(), 1, String(hidden))
  }
  const s = idleWindow({ readyState: 'complete' })
  Object.defineProperty(s.document, 'hidden', { get() { throw new Error('fault') } })
  s.tick(200)
  assert.equal(s.went(), 1)
})

test('lab stage start: the listeners are removed once the stage has started', () => {
  const s = idleWindow({ hidden: true })
  s.document.readyState = 'complete'
  s.fire('window', 'load')
  s.tick(200)
  assert.deepEqual(s.listening(), ['document visibilitychange'])
  s.document.hidden = false
  s.fire('document', 'visibilitychange')
  assert.equal(s.went(), 1)
  assert.deepEqual(s.listening(), [])
})

test('lab stage start: a page whose listeners cannot be added still gets the stage, through a timer', () => {
  const s = idleWindow({ listenThrows: true, idle: 'records' })
  s.tick(0)
  assert.equal(s.idles.length, 1, 'no load listener: the wait for load ends at once')
  s.idles[0].fn()
  assert.equal(s.went(), 1)
  const hidden = idleWindow({ readyState: 'complete', hidden: true, listenThrows: true })
  hidden.tick(200)
  assert.equal(hidden.went(), 1, 'a hidden page that cannot be listened to runs rather than waits forever')
})

test('each turn given to the page is a message channel of its own, closed when its message arrives', () => {
  const h = harness({ readyState: 'complete' })
  let made = 0
  let closed = 0
  const Real = h.w.MessageChannel
  h.w.MessageChannel = function () {
    made++
    const channel = new Real()
    channel.port1.close = () => closed++
    return channel
  }
  const session = start(h.w, h.core, labStage(h.probes))
  h.flush()
  h.tick(250)
  assert.ok(made > 3)
  assert.equal(closed, made)
  assert.deepEqual(session.reading().flags.partial, [])
})

test('a port whose close throws still delivers each turn once', () => {
  const h = harness({ readyState: 'complete' })
  const Real = h.w.MessageChannel
  h.w.MessageChannel = function () {
    const channel = new Real()
    channel.port1.close = () => { throw new Error('fault') }
    return channel
  }
  const session = start(h.w, h.core, labStage(h.probes))
  h.flush()
  h.tick(250)
  assert.deepEqual(h.calls, { textSize: 1, hints: 1, intl: 1, math: 1, canvas: 1, audio: 1, privateWindow: 0 })
  assert.deepEqual(session.reading().flags.partial, [])
})

test('readings carry id version 3, and the schema refuses a reading of version 2 as malformed for this build', () => {
  const r = settled()
  assert.equal(r.v, 3)
  assert.deepEqual(problems(r), [])
  assert.ok(problems({ ...r, v: 2 }).includes('v'))
})

test('a reading cached by an id version 2 build is not replayed: the page view reads again', () => {
  const local = storageArea()
  const first = harness({ localStorage: local })
  start(first.w, first.core)
  first.fire('DOMContentLoaded')
  const key = '_visito_c'
  const saved = JSON.parse(local.getItem(key))
  assert.equal(saved.v, 3)
  local.setItem(key, JSON.stringify({ ...saved, v: 2 }))
  const second = harness({ localStorage: local })
  const session = start(second.w, second.core)
  assert.equal(session.reading().id, null, 'nothing replayed at script start')
  second.fire('DOMContentLoaded')
  assert.equal(second.calls.textSize, 1)
})
