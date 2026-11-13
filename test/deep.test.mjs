import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fakeAudio, fakeDocument } from './fake-render.mjs'
import { BROWSERS, dress, fakeWindow } from './fake-window.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
// docs/SIGNALS.md: r.audio and r.cg, then the fixed line r.ct=!ex, after "visito-deep:1"
const recipe = (c) => sha(`visito-deep:1\nr.audio=${c['r.audio']}\nr.cg=${c['r.cg']}\nr.ct=!ex`)
// the geometry scene only: no font step, no text drawing, no text digest
const STEPS = ['pattern', 'geometry', 'geometry2', 'hash-geometry'].map((s) => 'canvas:' + s)
/** Every text call the pretend canvases saw: drawing, measuring, and the lang attribute the text scene needs. */
const textCalls = (h) => h.canvas.made.reduce((n, element) => n + element.ops.filter((op) => /^\["(fillText|strokeText)"/.test(op)).length + (element.getAttribute('lang') !== null ? 1 : 0), 0) + h.canvas.measured.length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Each test gets the entry fresh: its session lives in the module, one per page, as in a browser.
let loads = 0
const entry = () => import(`../build/esm/deep.js?fresh=${++loads}`)
afterEach(() => {
  delete globalThis.window
})

/** A window whose clock, timers, messages, idle callbacks, load and visibility are driven by the test, with pretend canvas and audio. */
function harness(o = {}) {
  let time = 1000
  const timers = []
  const messages = []
  const idle = []
  const on = {}
  const onDoc = {}
  const errors = []
  const canvas = fakeDocument(o.canvas || {})
  const sound = fakeAudio(o.audio || {})
  const document = Object.assign(canvas.document, {
    readyState: o.readyState || 'complete',
    hidden: !!o.hidden,
    addEventListener: (type, fn) => (onDoc[type] = onDoc[type] || []).push(fn),
  })
  const w = fakeWindow({ document })
  const run = (fn, ...args) => {
    try {
      fn(...args)
    } catch (e) {
      errors.push(e)
    }
  }
  Object.assign(w, {
    addEventListener: (type, fn) => (on[type] = on[type] || []).push(fn),
    performance: { now: () => time },
    setTimeout: (fn, ms) => timers.push({ fn, at: time + (ms || 0) }),
    clearTimeout: (id) => void (timers[id - 1] = null),
    MessageChannel: function () {
      const channel = { port1: {}, port2: { postMessage: () => messages.push(() => channel.port1.onmessage({ data: 0 })) } }
      return channel
    },
    requestIdleCallback: (fn) => idle.push(fn),
    OfflineAudioContext: sound.Context,
  })
  dress(w, BROWSERS[o.browser || 'chromeDesktop'])
  const h = {
    w, canvas, sound, document, errors, timers, messages,
    spend: (ms) => void (time += ms),
    /** Runs pending messages one at a time; `each` is told after every one. */
    flush: (each) => {
      for (let guard = 0; messages.length && guard < 10000; guard++) {
        run(messages.shift())
        if (each) each()
      }
    },
    /** Runs pending idle callbacks, then the messages they posted unless told not to. */
    idle: (flushAfter = true) => {
      idle.splice(0).forEach((fn) => run(fn, { didTimeout: false, timeRemaining: () => 50 }))
      if (flushAfter) h.flush()
    },
    fire: (type) => {
      ;(on[type] || []).splice(0).forEach((fn) => run(fn))
      h.flush()
    },
    show: () => {
      document.hidden = false
      ;(onDoc.visibilitychange || []).forEach((fn) => run(fn))
      h.flush()
    },
    tick: (ms = 0) => {
      time += ms
      for (let guard = 0; guard < 10000; guard++) {
        let due = -1
        for (let i = 0; i < timers.length; i++) if (timers[i] && timers[i].at <= time && (due < 0 || timers[i].at < timers[due].at)) due = i
        if (due < 0) break
        const { fn } = timers[due]
        timers[due] = null
        run(fn)
        h.flush()
      }
    },
    /** Lets the pretend audio render, which settles on Node's own timers, and delivers what follows. */
    settle: async () => {
      for (let i = 0; i < 20; i++) {
        h.idle()
        h.flush()
        h.tick(0)
        await sleep(2)
      }
    },
    reads: () => canvas.made.reduce((n, c) => n + c.reads, 0),
  }
  return h
}

/** Calls get() and records each delivery, and whether it came before get() returned. */
const ask = (deep) => {
  const calls = []
  let returned = false
  deep.get((reading) => calls.push({ reading, early: !returned }))
  returned = true
  return calls
}

test('importing the entry touches nothing: no window, no canvas, no timer', async () => {
  const touched = []
  globalThis.window = new Proxy({}, { get: (_t, key) => { touched.push(String(key)); throw new Error('touched') }, has: (_t, key) => { touched.push(String(key)); return false } })
  const deep = await entry()
  assert.deepEqual(touched, [])
  assert.deepEqual(Object.keys(deep).sort(), ['DEEP_VERSION', 'get'])
  assert.equal(deep.DEEP_VERSION, 1)
})

test('get() with something that is not a function does nothing and does not throw', async () => {
  const h = harness()
  globalThis.window = h.w
  const deep = await entry()
  assert.doesNotThrow(() => deep.get(undefined))
  assert.doesNotThrow(() => deep.get('nope'))
  await h.settle()
  assert.equal(h.canvas.made.length, 0, 'no session was started')
})

test('outside a browser get() calls back null, after it has returned', async () => {
  const deep = await entry()
  const calls = ask(deep)
  assert.equal(calls.length, 0)
  await sleep(5)
  assert.deepEqual(calls, [{ reading: null, early: false }])
})

test('in a frame, or without Object.keys or Date.now, get() calls back null after it has returned, and reads nothing', async () => {
  const cases = {
    frame: (w) => { w.top = {}; w.self = w },
    'a frame whose parent throws': (w) => { Object.defineProperty(w, 'top', { get() { throw new Error('cross-origin') } }) },
    'no Object.keys': () => { Object.keys = undefined },
    'no Date.now': () => { Date.now = undefined },
  }
  for (const name of Object.keys(cases)) {
    const h = harness()
    const keys = Object.keys
    const clock = Date.now
    let calls
    try {
      cases[name](h.w)
      globalThis.window = h.w
      const deep = await entry()
      calls = ask(deep)
    } finally {
      Object.keys = keys
      Date.now = clock
    }
    assert.equal(calls.length, 0, name)
    await h.settle()
    assert.deepEqual(calls, [{ reading: null, early: false }], name)
    assert.equal(h.canvas.made.length, 0, name)
    assert.equal(h.sound.log.constructed.length, 0, name)
  }
})

test('Blink desktop: nothing runs before load, then the reads run once idle, one step per task, and each caller hears back once with the same reading', async () => {
  const h = harness({ readyState: 'loading' })
  globalThis.window = h.w
  const deep = await entry()
  const first = ask(deep)
  const second = ask(deep)
  h.flush()
  h.tick(0)
  assert.equal(h.canvas.made.length, 0, 'nothing is drawn before load')
  h.document.readyState = 'complete'
  h.fire('load')
  assert.equal(h.canvas.made.length, 0, 'nor before an idle moment')
  // one task at most per canvas read: the idle callback runs the first step, each message one more
  let before = h.reads()
  let most = 0
  const tasks = []
  const measure = () => {
    const now = h.reads()
    most = Math.max(most, now - before)
    tasks.push(now - before)
    before = now
  }
  h.idle(false)
  measure()
  h.flush(measure)
  assert.ok(most <= 1, `at most one canvas read per task, saw ${most}`)
  assert.ok(tasks.length >= 4, `the canvas read took ${tasks.length} tasks`)
  await h.settle()
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(first[0].early, false)
  const r = first[0].reading
  assert.equal(second[0].reading, r, 'the same object for every caller')
  assert.equal(r.v, 1)
  assert.match(r.c['r.cg'], HEX16)
  assert.equal(r.c['r.ct'], '!ex')
  assert.match(r.c['r.audio'], HEX16)
  assert.deepEqual([r.c['r.cchk'], r.c['r.achk'], r.c['x.rule']], ['ok', 'ok', ''])
  assert.match(r.id, HEX64)
  assert.equal(r.id, recipe(r.c), 'a server recomputes the id from c')
  assert.deepEqual(r.flags, { partial: [], noise: [], excluded: [], weak: false })
  assert.deepEqual(Object.keys(r.t), [...STEPS, 'audio', 'check'], 'each step, the audio render, then the self-test of the digest')
  assert.equal(textCalls(h), 0, 'no text is drawn or measured, and no canvas is given a language')
  assert.equal(typeof r.ms, 'number')
  assert.deepEqual(Object.keys(r).sort(), ['c', 'flags', 'id', 'ms', 't', 'v'])
  assert.equal(h.sound.log.constructed.length, 1)
  // a caller after the reading is done gets the same object, later
  const late = ask(deep)
  assert.equal(late.length, 0)
  h.tick(0)
  assert.deepEqual(late, [{ reading: r, early: false }])
  assert.deepEqual(h.errors, [])
})

test('every engine that reads draws the geometry scene and renders the audio, and no text: Blink and Gecko give the same reading for the same pixels', async () => {
  const seen = {}
  for (const browser of ['chromeDesktop', 'firefoxDesktop', 'emulatedAndroid']) {
    const h = harness({ browser })
    globalThis.window = h.w
    const calls = ask(await entry())
    await h.settle()
    seen[browser] = { r: calls[0].reading, text: textCalls(h) }
  }
  for (const browser of Object.keys(seen)) {
    const { r, text } = seen[browser]
    assert.equal(text, 0, `${browser}: no text step ran`)
    assert.equal(r.c['x.rule'], '', browser)
    assert.deepEqual(Object.keys(r.t), [...STEPS, 'audio', 'check'], browser)
    assert.deepEqual([r.c['r.ct'], r.c['r.cchk'], r.c['r.achk']], ['!ex', 'ok', 'ok'], browser)
    assert.equal(r.id, recipe(r.c), browser)
    assert.deepEqual(r.flags, { partial: [], noise: [], excluded: [], weak: false }, browser)
  }
  // the pretend canvas draws the same in every engine, so the parts and the id are the same too
  assert.equal(seen.firefoxDesktop.r.id, seen.chromeDesktop.r.id)
})

test('the canvas check rests on the pattern and the geometry strips and pair: an alteration of text-sized canvases cannot happen, one of the geometry is noise', async () => {
  const run = async (alter) => {
    const h = harness({ canvas: { alter } })
    globalThis.window = h.w
    const calls = ask(await entry())
    await h.settle()
    return { r: calls[0].reading, widths: h.canvas.made.map((element) => element.readSize && element.readSize[0]).filter(Boolean) }
  }
  const plain = await run(undefined)
  assert.ok(plain.widths.indexOf(236) < 0, 'no text-sized canvas is read')
  // the first of the two geometry drawings only, so the pair differs below the strips
  let drawn = 0
  const geometry = await run((data, element) => { if (element.width === 200 && drawn++ === 0) data[2000] ^= 1 })
  assert.equal(geometry.r.id, null)
  assert.deepEqual([geometry.r.c['r.cg'], geometry.r.c['r.ct'], geometry.r.c['r.cchk']], ['!noise', '!ex', 'geometry'])
})

test('a page whose String.fromCharCode returns nothing, without throwing, gets no id: the digest fails its known-answer test and every part read is "!err"', async () => {
  const h = harness()
  globalThis.window = h.w
  const calls = ask(await entry())
  const saved = String.fromCharCode
  try {
    String.fromCharCode = () => ''
    await h.settle()
  } finally {
    String.fromCharCode = saved
  }
  const r = calls[0].reading
  assert.equal(r.id, null)
  assert.deepEqual([r.c['r.audio'], r.c['r.cg'], r.c['r.ct'], r.c['x.id']], ['!err', '!err', '!ex', '!err'])
  assert.deepEqual(r.flags.partial, ['r.audio', 'r.cg'])
})

test('Android, WebKit, Brave and an unknown engine: every part "!ex", no canvas and no audio context, and the answer on the next turn without waiting for load', async () => {
  const shapes = { chromeAndroid: 'android', firefoxAndroid: 'android', braveAndroid: 'android', safari17: 'webkit', webkitWindows: 'webkit', braveDesktop: 'brave', edgeHtml: 'other' }
  for (const browser of Object.keys(shapes)) {
    const h = harness({ browser, readyState: 'loading' })
    globalThis.window = h.w
    const calls = ask(await entry())
    assert.equal(calls.length, 0, browser)
    h.tick(0)
    assert.equal(calls.length, 1, browser)
    const r = calls[0].reading
    assert.equal(r.c['x.rule'], shapes[browser], browser)
    assert.deepEqual([r.c['r.audio'], r.c['r.cg'], r.c['r.ct'], r.c['r.cchk'], r.c['r.achk']], ['!ex', '!ex', '!ex', '!ex', '!ex'], browser)
    assert.equal(r.id, null, browser)
    assert.deepEqual(r.flags, { partial: [], noise: [], excluded: ['r.audio', 'r.cg'], weak: false }, browser)
    assert.equal(h.canvas.made.length, 0, browser)
    assert.equal(h.sound.log.constructed.length, 0, browser)
    assert.equal(h.timers.filter(Boolean).length, 0, `${browser}: no timer left behind`)
  }
})

test('a canvas alteration gives no id: the canvas part is noise and r.cchk names the check; the audio part is still read', async () => {
  const randomFlips = (data) => { for (let i = 0; i < 20; i++) data[(i * 7919) % data.length] ^= 1 }
  const h = harness({ canvas: { alter: randomFlips } })
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  const r = calls[0].reading
  assert.deepEqual([r.c['r.cg'], r.c['r.ct'], r.c['r.cchk']], ['!noise', '!ex', 'pattern'])
  assert.match(r.c['r.audio'], HEX16)
  assert.equal(r.id, null)
  assert.deepEqual(r.flags, { partial: [], noise: ['r.cg'], excluded: [], weak: false })
  assert.ok(!('canvas:geometry' in r.t), 'a check that fires ends the canvas read')
})

test('a refused readback is noise ("blocked"), and audio noise is noise too ("pattern")', async () => {
  const refused = new Error('blocked')
  refused.name = 'SecurityError'
  const h = harness({ canvas: { readThrows: refused }, audio: { alter: (_ch0, ch1) => { for (let i = 0; i < 256; i++) ch1[i] *= 1 + 1e-6 } } })
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  const r = calls[0].reading
  assert.deepEqual([r.c['r.cg'], r.c['r.cchk'], r.c['r.audio'], r.c['r.achk']], ['!noise', 'blocked', '!noise', 'pattern'])
  assert.deepEqual(r.flags.noise, ['r.audio', 'r.cg'])
  assert.equal(r.id, null)
})

test('no 2D canvas and no offline audio: every part "!na", no id; one of them alone gives a weak id', async () => {
  const bare = harness({ canvas: { noContext: true } })
  delete bare.w.OfflineAudioContext
  globalThis.window = bare.w
  const none = ask(await entry())
  await bare.settle()
  assert.deepEqual(none[0].reading.flags, { partial: [], noise: [], excluded: [], weak: false })
  assert.equal(none[0].reading.id, null)
  const h = harness()
  delete h.w.OfflineAudioContext
  globalThis.window = h.w
  const some = ask(await entry())
  await h.settle()
  const r = some[0].reading
  assert.deepEqual([r.c['r.audio'], r.c['r.achk']], ['!na', '!na'])
  assert.equal(r.id, recipe(r.c))
  assert.equal(r.flags.weak, true)
})

test('a used-up page-busy budget of 1,000 ms leaves the remaining steps "!to" and no id', async () => {
  const slow = {}
  const h = harness({ canvas: slow })
  slow.alter = () => h.spend(400)
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  const r = calls[0].reading
  assert.deepEqual([r.c['r.cg'], r.c['r.ct'], r.c['r.cchk'], r.c['r.audio'], r.c['r.achk']], ['!to', '!ex', '!to', '!to', '!to'])
  assert.deepEqual(r.flags.partial, ['r.audio', 'r.cg'])
  assert.equal(r.id, null)
  assert.equal(h.reads(), 3, 'three reads of 400 ms each use the budget up')
  assert.equal(h.sound.log.constructed.length, 0, 'the audio read never starts')
  assert.ok(r.ms >= 1200)
})

test('a page hidden the whole time: nothing is read, and the watchdog answers at 30 s with both parts "!to"', async () => {
  const h = harness({ hidden: true })
  globalThis.window = h.w
  const calls = ask(await entry())
  h.idle()
  h.tick(29999)
  assert.equal(calls.length, 0)
  h.tick(1)
  assert.equal(calls.length, 1)
  const r = calls[0].reading
  assert.deepEqual(r.flags.partial, ['r.audio', 'r.cg'])
  assert.equal(r.id, null)
  assert.equal(h.canvas.made.length, 0)
  h.show()
  await h.settle()
  assert.equal(h.canvas.made.length, 0, 'once answered, nothing starts')
  assert.equal(calls.length, 1)
})

test('a hidden page waits for visibilitychange, then reads', async () => {
  const h = harness({ hidden: true })
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  h.tick(3000)
  assert.equal(h.canvas.made.length, 0)
  h.show()
  await h.settle()
  assert.match(calls[0].reading.id, HEX64)
})

test('without requestIdleCallback the reads start 200 ms after load; without MessageChannel the steps go on timers', async () => {
  const h = harness({ readyState: 'loading' })
  delete h.w.requestIdleCallback
  delete h.w.MessageChannel
  globalThis.window = h.w
  const calls = ask(await entry())
  h.document.readyState = 'complete'
  h.fire('load')
  h.tick(199)
  assert.equal(h.canvas.made.length, 0)
  h.tick(1)
  assert.ok(h.canvas.made.length > 0)
  await h.settle()
  assert.equal(calls.length, 1)
  assert.match(calls[0].reading.id, HEX64)
})

test('a load event that never comes: the wait for it ends 3 s after the call, and the reads still wait for an idle moment', async () => {
  const h = harness({ readyState: 'loading' })
  globalThis.window = h.w
  ask(await entry())
  h.tick(2999)
  h.idle()
  assert.equal(h.canvas.made.length, 0, 'no idle moment is asked for before the 3 s')
  h.tick(1)
  assert.equal(h.canvas.made.length, 0, 'the 3 s end the wait for load, not the wait for an idle moment')
  h.idle()
  assert.ok(h.canvas.made.length > 0)
})

test('a load event that never comes and an idle callback that never fires: the reads start 2.5 s after the 3 s', async () => {
  const h = harness({ readyState: 'loading' })
  globalThis.window = h.w
  ask(await entry())
  h.tick(3000)
  h.tick(2499)
  assert.equal(h.canvas.made.length, 0)
  h.tick(1)
  assert.ok(h.canvas.made.length > 0)
})

test('a setTimeout that throws: no watchdog and no audio limit, and the answer still comes after get() returns, by message', async () => {
  const h = harness()
  h.w.setTimeout = () => { throw new Error('page broke it') }
  globalThis.window = h.w
  const calls = ask(await entry())
  for (let i = 0; i < 20 && !calls.length; i++) {
    h.idle()
    h.flush()
    await sleep(2)
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].early, false)
  assert.match(calls[0].reading.id, HEX64)
})

test('a setTimeout that schedules and then throws still calls back once', async () => {
  const h = harness()
  const schedule = h.w.setTimeout
  h.w.setTimeout = (fn, ms) => { schedule(fn, ms); throw new Error('wrapped') }
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].early, false)
})

test('sorting replaced after get() changes nothing: the same id as an untouched page', async () => {
  const clean = harness()
  globalThis.window = clean.w
  const base = ask(await entry())
  await clean.settle()
  const h = harness()
  globalThis.window = h.w
  const calls = ask(await entry())
  const sort = Array.prototype.sort
  try {
    Array.prototype.sort = () => { throw new Error('page replaced it') }
    await h.settle()
  } finally {
    Array.prototype.sort = sort
  }
  assert.equal(calls[0].reading.id, base[0].reading.id)
})

test('the audio limit racing the render: a render that ends after 1,000 ms is "!to", ignored when it lands, and the caller hears back once', async () => {
  const h = harness({ audio: { delay: 40 } })
  globalThis.window = h.w
  const calls = ask(await entry())
  h.idle()
  h.flush()
  h.tick(1000)
  h.tick(0)
  await sleep(80)
  h.flush()
  h.tick(0)
  assert.equal(calls.length, 1)
  const r = calls[0].reading
  assert.deepEqual([r.c['r.audio'], r.c['r.achk']], ['!to', '!to'])
  assert.deepEqual(r.flags.partial, ['r.audio'])
  assert.equal(r.id, null)
  assert.equal(h.sound.log.renders, 1)
})

test('a fault installed after get(): a readback that starts throwing is "!err" and leaves no id', async () => {
  const canvas = {}
  const h = harness({ canvas, readyState: 'loading' })
  globalThis.window = h.w
  const calls = ask(await entry())
  canvas.readThrows = new Error('broken later')
  h.document.readyState = 'complete'
  h.fire('load')
  await h.settle()
  const r = calls[0].reading
  assert.deepEqual([r.c['r.cg'], r.c['r.ct'], r.c['r.cchk']], ['!err', '!ex', '!err'])
  assert.deepEqual(r.flags.partial, ['r.cg'])
  assert.equal(r.id, null)
})

test('the entry never touches cookies, localStorage or sessionStorage', async () => {
  const h = harness()
  const touched = []
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(h.w, name, { get() { touched.push(name); throw new Error(name) } })
  Object.defineProperty(h.document, 'cookie', { get() { touched.push('cookie'); return '' }, set() { touched.push('cookie') } })
  globalThis.window = h.w
  const calls = ask(await entry())
  await h.settle()
  assert.match(calls[0].reading.id, HEX64)
  assert.deepEqual(touched, [])
})

test('a callback that throws does not stop the next caller from hearing back', async () => {
  const h = harness()
  globalThis.window = h.w
  const deep = await entry()
  deep.get(() => { throw new Error('caller bug') })
  const calls = ask(deep)
  await h.settle()
  assert.equal(calls.length, 1)
  assert.equal(h.errors.length, 1, "the caller's own error surfaces as the caller's, once")
})
