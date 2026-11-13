import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deferred } from '../build/esm/api.js'
import { start as startSession } from '../build/esm/stages.js'
import { inMemory } from '../build/esm/private.js'
import { fakeWindow, cookieJar, storageArea, UA, BROWSERS, dress } from './fake-window.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'

/**
 * Wraps an object so that every operation on it, and on every object or function reached through it, is logged with its path.
 * A function reached this way is called on the unwrapped object, so a built-in that checks its receiver still works. One object
 * always gets the same wrapper, named by the first path that reached it, so identity checks such as `top === self` still hold.
 */
function recorder(root, name = 'window') {
  const log = []
  const raw = new WeakMap()
  const wrapped = new WeakMap()
  const wrap = (value, path) => {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
    if (raw.has(value)) return value
    if (wrapped.has(value)) return wrapped.get(value)
    const handler = {}
    for (const trap of ['get', 'set', 'has', 'defineProperty', 'deleteProperty', 'getOwnPropertyDescriptor', 'ownKeys', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions']) {
      handler[trap] = (target, key, ...rest) => {
        const at = key === undefined || typeof key === 'symbol' ? path : `${path}.${String(key)}`
        log.push(`${trap} ${at}`)
        if (trap === 'get') return wrap(Reflect.get(target, key), at)
        return Reflect[trap](target, key, ...rest)
      }
    }
    handler.apply = (target, self, args) => {
      log.push(`call ${path}`)
      return wrap(Reflect.apply(target, raw.get(self) || self, args), `${path}()`)
    }
    handler.construct = (target, args) => {
      log.push(`new ${path}`)
      return wrap(Reflect.construct(target, args), `new ${path}`)
    }
    const proxy = new Proxy(value, handler)
    raw.set(proxy, value)
    wrapped.set(value, proxy)
    return proxy
  }
  return { proxy: wrap(root, name), log }
}

// the same 16 bytes every time, so two sessions on identical windows create the same stored id
const fixedCrypto = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 255; return b } }

/** A window whose events, timers and clock the test drives, as in session.test.mjs. */
function harness(options = {}) {
  let time = options.time || 1000
  const timers = []
  const messages = []
  const listeners = {}
  const on = (type, fn) => (listeners[type] = listeners[type] || []).push(fn)
  const document = Object.assign(options.document || cookieJar(), { readyState: options.readyState || 'loading', addEventListener: on })
  const w = fakeWindow({ ...options, document })
  Object.assign(w, {
    crypto: fixedCrypto,
    addEventListener: on,
    performance: { now: () => time },
    setTimeout: (fn, ms) => timers.push({ fn, at: time + (ms || 0) }) && timers.length,
    clearTimeout: (id) => void (timers[id - 1] = null),
    MessageChannel: function () {
      const channel = { port1: {}, port2: { postMessage: () => messages.push(() => channel.port1.onmessage()) } }
      return channel
    },
  })
  w.self = w.top = w
  if (options.features) dress(w, options.features)
  Object.assign(w, options.extra || {})
  const calls = { textSize: 0, hints: 0, privateWindow: 0 }
  const probes = {
    textSize: () => { calls.textSize++; return { 'x.txt.env': 1.15, 'x.txt.fs': 100, 'x.txt.w': 600.2, 'x.txt.apple': '!na' } },
    hints: (_w, done) => { calls.hints++; if (!options.hintsHang) done(options.hints || { 'x.ch.model': '!na' }) },
    privateWindow: options.realPrivate ? inMemory : (_w, _env, done) => { calls.privateWindow++; done({ 'x.private': options.isPrivate === undefined ? false : options.isPrivate }) },
  }
  const flush = () => { for (let guard = 0; messages.length && guard < 1000; guard++) messages.shift()() }
  const tick = (ms) => {
    time += ms
    for (let guard = 0; guard < 100; guard++) {
      const due = timers.findIndex((t) => t && t.at <= time)
      if (due < 0) break
      const { fn } = timers[due]
      timers[due] = null
      fn()
      flush()
    }
  }
  return {
    w, calls, probes, document, timers, flush, tick,
    fire: (type) => { (listeners[type] || []).splice(0).forEach((fn) => fn()); flush() },
    listening: (type) => (listeners[type] || []).length,
    advance: (ms) => { time += ms },
  }
}

/** Runs `fn` with `window` set to `w`, as a page would have it, and removes it afterwards. */
function inWindow(w, fn) {
  const had = 'window' in globalThis
  const before = globalThis.window
  globalThis.window = w
  try {
    return fn()
  } finally {
    if (had) globalThis.window = before
    else delete globalThis.window
  }
}
const drain = () => new Promise((resolve) => setTimeout(resolve, 20))
/** Parses the document and lets every turn run, so the session finishes. */
const settle = (h) => { h.fire('DOMContentLoaded'); h.tick(1); h.tick(1) }
/** Starts a deferred session on a harness window and lets it finish; returns the api and the reading. */
function started(h, options) {
  const api = deferred(h.probes)
  inWindow(h.w, () => api.start(options))
  settle(h)
  return { api, reading: api.getSync() }
}
const without = (reading, ...keys) => {
  const copy = JSON.parse(JSON.stringify(reading))
  for (const key of keys) delete copy[key]
  return copy
}
const stored = (h) => ({ cookie: { ...h.document.values }, local: { ...h.w.localStorage.values } })
const NOTHING = { cookie: {}, local: {} }

test('creating the api, getSync() and get() before start() touch nothing on the window, not even window itself', async () => {
  const { proxy, log } = recorder(harness().w)
  let called = 0
  // a getter on the global, so that looking the name up at all, `typeof window` included, is logged too
  Object.defineProperty(globalThis, 'window', { configurable: true, get: () => (log.push('lookup window'), proxy) })
  let api
  try {
    api = deferred({ textSize: () => ({}), hints: () => {}, privateWindow: () => {} })
    assert.equal(api.getSync(), null)
    api.get(() => called++)
    api.get(() => called++)
    await drain()
  } finally {
    delete globalThis.window
  }
  assert.deepEqual(log, [])
  assert.equal(called, 0, 'get() before start() waits, however long the page waits')
  assert.equal(api.getSync(), null)
  assert.deepEqual(Object.keys(api).sort(), ['get', 'getSync', 'start'])
})

test('start() stores as the core does and gives the core session reading on an identical window, apart from timings', () => {
  const a = harness()
  const b = harness()
  const api = deferred(a.probes)
  const seen = []
  api.get((r) => seen.push(r))
  inWindow(a.w, () => api.start())
  assert.equal(seen.length, 0, 'queued callbacks never run inside start()')
  const sync = api.getSync()
  assert.match(sync.did, /^[0-9a-f-]{36}$/, 'the stored id is there straight after start()')
  assert.equal(sync.didNew, true)
  assert.deepEqual(stored(a), { cookie: { _visito: sync.did }, local: { _visito: sync.did } })

  const core = startSession(b.w, b.probes)
  settle(a)
  settle(b)
  assert.deepEqual(without(api.getSync(), 'ms', 't'), without(core.reading(), 'ms', 't'))
  assert.match(api.getSync().id, HEX64)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], api.getSync())
  // the cache's own time stamp comes from the real clock, which moved between the two sessions
  const withoutTime = (h) => {
    const s = stored(h)
    s.local._visito_c = { ...JSON.parse(s.local._visito_c), t: 0 }
    return s
  }
  assert.deepEqual(withoutTime(a), withoutTime(b), 'the same cookie, stored id and cache as the core session')
  a.tick(40000)
  assert.equal(seen.length, 1, 'each queued callback runs exactly once')
})

test('start() after the document has parsed runs stage B on the next turn', () => {
  for (const readyState of ['interactive', 'complete']) {
    const h = harness({ readyState })
    const api = deferred(h.probes)
    inWindow(h.w, () => api.start())
    assert.equal(h.calls.textSize, 0, 'nothing of stage B inside start()')
    assert.equal(h.listening('DOMContentLoaded'), 0)
    h.flush()
    assert.equal(h.calls.textSize, 1, readyState)
    assert.match(api.getSync().id, HEX64)
  }
})

test('start() while the document parses waits for DOMContentLoaded, and the 10-second and 30-second limits count from start()', () => {
  const h = harness({ readyState: 'loading' })
  const api = deferred(h.probes)
  h.advance(60000)
  inWindow(h.w, () => api.start())
  assert.equal(h.listening('DOMContentLoaded'), 1)
  h.tick(9999)
  assert.equal(h.calls.textSize, 0, 'the parse wait counts from start(), not from load')
  h.tick(1)
  assert.equal(h.calls.textSize, 1)

  // a read that never answers: only the watchdog ends the session, 30 seconds after start()
  const slow = harness({ ua: UA.chromeAndroidReduced, hintsHang: true })
  const late = deferred(slow.probes)
  const seen = []
  late.get((r) => seen.push(r))
  slow.advance(60000)
  inWindow(slow.w, () => late.start())
  slow.fire('DOMContentLoaded')
  slow.tick(29990)
  assert.equal(seen.length, 0)
  slow.tick(20)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].c['x.ch.model'], '!to')
})

test('start({ store: false }) reads the device but no cookie, no storage and no file system', () => {
  for (const [label, ua, features] of [['Android', UA.facebookAndroid, null], ['WebKit', SAFARI, BROWSERS.safari17], ['Gecko', FIREFOX, BROWSERS.firefoxDesktop]]) {
    let directory = 0
    const storage = { getDirectory: () => { directory++; return Promise.reject({ name: 'UnknownError' }) } }
    const h = harness({ ua, features, realPrivate: true })
    h.w.navigator.storage = storage
    const { proxy, log } = recorder(h.w)
    const api = deferred(h.probes)
    inWindow(proxy, () => api.start({ store: false }))
    settle(h)
    const touched = log.filter((entry) => /\b(cookie|localStorage|sessionStorage|getItem|setItem|storage|getDirectory|indexedDB)\b/.test(entry))
    assert.deepEqual(touched, [], label)
    assert.equal(directory, 0, label)
    assert.ok(log.some((entry) => entry === 'get window.navigator.userAgent'), `${label}: the device is read`)
    const r = api.getSync()
    assert.deepEqual([r.did, r.didNew, r.didSrc], [null, false, ''], label)
    assert.ok(!('x.private' in r.c), label)
    assert.equal(r.flags.private, null, label)
    assert.deepEqual(stored(h), NOTHING, label)

    const other = harness({ ua, features, isPrivate: true })
    const kept = started(other).reading
    assert.match(r.id, HEX64, label)
    assert.equal(r.id, kept.id, `${label}: the same id as the stored mode`)
    assert.equal(r.idStrict, kept.idStrict, `${label}: the same strict id as the stored mode`)
  }
})

test('start({ store: false }) neither loads a valid cache nor overwrites it', () => {
  const first = harness()
  started(first)
  const cache = first.w.localStorage.values._visito_c
  assert.ok(cache, 'a stored-mode view saves the cache')
  const local = storageArea({ _visito_c: cache })
  const h = harness({ localStorage: local })
  const api = deferred(h.probes)
  inWindow(h.w, () => api.start({ store: false }))
  assert.equal(api.getSync().id, null, 'no id at start(): the cache was not read')
  settle(h)
  assert.ok(!('cache' in api.getSync().t))
  assert.equal(h.calls.textSize, 1, 'read fresh')
  assert.deepEqual(local.values, { _visito_c: cache })
})

test('a second view in stored mode within 24 hours is served from the cache at start(); in store: false mode it is not', () => {
  const local = storageArea()
  const document = cookieJar()
  started(harness({ localStorage: local, document }))
  const h = harness({ localStorage: local, document, time: 5000 })
  const api = deferred(h.probes)
  inWindow(h.w, () => api.start())
  const r = api.getSync()
  assert.equal(r.t.cache, 0)
  assert.match(r.id, HEX64, 'both ids straight after start()')
  assert.equal(r.didNew, false)

  const fresh = harness({ localStorage: storageArea({ ...local.values }), document: cookieJar({ ...document.values }) })
  const bare = deferred(fresh.probes)
  inWindow(fresh.w, () => bare.start({ store: false }))
  assert.equal(bare.getSync().id, null)
  assert.ok(!('cache' in bare.getSync().t))
})

test('the first start() decides: false then true stores nothing, true then false stores once, and the reading stays the same object', () => {
  const h = harness()
  const api = deferred(h.probes)
  inWindow(h.w, () => { api.start({ store: false }); api.start({ store: true }); api.start() })
  settle(h)
  assert.deepEqual(stored(h), NOTHING)
  assert.equal(api.getSync().did, null)

  let writes = 0
  const jar = cookieJar()
  const counted = { get cookie() { return jar.cookie }, set cookie(text) { writes++; jar.cookie = text }, values: jar.values }
  const k = harness({ document: counted })
  const twice = deferred(k.probes)
  const reading = inWindow(k.w, () => {
    twice.start()
    const first = twice.getSync()
    twice.start({ store: false })
    return first
  })
  settle(k)
  assert.equal(writes, 1)
  assert.ok(reading.did)
  assert.equal(twice.getSync(), reading, 'the same live object')
  assert.equal(k.calls.textSize, 1, 'one session')
})

test('only an absent store or store: true stores; any other option stores nothing, and none of them throws', () => {
  const STORE = [undefined, {}, null, { store: true }, { store: undefined }]
  const BARE = [
    { store: false }, { store: 0 }, { store: 'no' }, { store: 1 }, { store: 'true' }, { store: null },
    { get store() { throw new Error('page') } },
    false, true, 0, 'no', function () {},
    new Proxy({}, { get: () => { throw new Error('page') } }),
  ]
  const run = (options) => {
    const h = harness()
    const api = deferred(h.probes)
    assert.doesNotThrow(() => inWindow(h.w, () => api.start(options)))
    settle(h)
    return { h, r: api.getSync() }
  }
  for (const options of STORE) {
    const { h, r } = run(options)
    assert.ok(r.did, `stores with ${JSON.stringify(options)}`)
    assert.deepEqual(stored(h).cookie, { _visito: r.did })
  }
  for (const options of BARE) {
    const { h, r } = run(options)
    assert.equal(r.did, null, `stores nothing with ${String(options && typeof options === 'object' ? JSON.stringify(Object.getOwnPropertyDescriptors(options)) : options)}`)
    assert.deepEqual(stored(h), NOTHING)
    assert.match(r.id, HEX64)
  }
  Object.prototype.store = false
  try {
    const { h, r } = run({})
    assert.equal(r.did, null, 'a store: false a page put on Object.prototype counts')
    assert.deepEqual(stored(h), NOTHING)
  } finally {
    delete Object.prototype.store
  }
})

test('VisitoConfig is read at start(): a name set after load is used, an invalid one falls back to _visito', () => {
  const h = harness()
  const api = deferred(h.probes)
  h.w.VisitoConfig = { did: 'shop_1' }
  inWindow(h.w, () => api.start())
  assert.deepEqual(Object.keys(h.document.values), ['shop_1'])

  const k = harness()
  const other = deferred(k.probes)
  k.w.VisitoConfig = { did: 'no spaces allowed' }
  inWindow(k.w, () => other.start())
  assert.deepEqual(Object.keys(k.document.values), ['_visito'])
})

test('in a frame start() gives null and stores nothing, and queued callbacks receive null', () => {
  const h = harness()
  h.w.top = {}
  const api = deferred(h.probes)
  const seen = []
  api.get((r) => seen.push(r))
  inWindow(h.w, () => api.start())
  assert.equal(api.getSync(), null)
  h.tick(1)
  assert.deepEqual(seen, [null])
  assert.deepEqual(stored(h), NOTHING)
})

test('with no window at all, start() does not throw and queued callbacks receive null', async () => {
  assert.ok(!('window' in globalThis))
  const api = deferred(harness().probes)
  const seen = []
  api.get((r) => seen.push(r))
  assert.doesNotThrow(() => api.start())
  assert.equal(seen.length, 0)
  await drain()
  assert.deepEqual(seen, [null])
  api.get((r) => seen.push(r))
  await drain()
  assert.deepEqual(seen, [null, null])
  assert.equal(api.getSync(), null)
})

test('get() with something that is not a function, before or after start(), does not throw and is not queued', () => {
  const h = harness()
  const api = deferred(h.probes)
  for (const value of [undefined, null, 'nope', 1, {}]) assert.doesNotThrow(() => api.get(value))
  inWindow(h.w, () => api.start())
  for (const value of [undefined, 'nope']) assert.doesNotThrow(() => api.get(value))
  assert.doesNotThrow(() => { settle(h); h.tick(40000) })
  assert.match(api.getSync().id, HEX64)
})

test('the core api is untouched: open() has no start and still starts at once', async () => {
  const { open } = await import('../build/esm/api.js')
  const h = harness()
  const api = inWindow(h.w, () => open(h.probes))
  assert.deepEqual(Object.keys(api).sort(), ['get', 'getSync'])
  assert.ok(api.getSync().did)
})
