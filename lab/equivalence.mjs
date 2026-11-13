// Runs a reference build and a candidate build of the product bundle in the same synthetic windows and compares whole outcomes:
// the readings at script start and in every callback, what was stored, every call the library made on the window, and which
// built-ins it called. Each window runs intact, then with one built-in broken before the script starts and again after it.
// A size change must give the same outcome on intact built-ins; under a broken one it may differ only where it is no worse.
// Where the reference itself throws, hangs or miscounts callbacks, that failure is the reference's: the candidate fails the
// run only by adding a kind of failure. It exits 1 on any intact difference, new built-in call or worse run, else 0.
// A build with start() (dist/visito.defer.min.js) is started right after it loads, so it can be compared with the core build.
// Usage: node lab/equivalence.mjs <reference bundle> [candidate bundle, default dist/visito.min.js] [--show]
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { BROWSERS, UA } from '../test/fake-window.mjs'

const [referencePath, candidatePath = new URL('../dist/visito.min.js', import.meta.url)] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!referencePath) {
  console.error('usage: node lab/equivalence.mjs <reference bundle> [candidate bundle]')
  process.exit(2)
}
const SHOW = process.argv.includes('--show')
// --window=<text> and --tamper=<text> run only the entries whose name contains the text
const only = (flag) => (process.argv.find((a) => a.startsWith(flag + '=')) || '').slice(flag.length + 1)
const BUNDLES = { reference: readFileSync(referencePath, 'utf8'), candidate: readFileSync(candidatePath, 'utf8') }
const END_MS = 40000
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const DID = '11111111-2222-4333-8444-555555555555'

// Synthetic windows: each entry changes the default (a Facebook in-app browser on Android that names its model).
const WINDOWS = {
  'named model': {},
  'reduced, hints name a model': { ua: UA.chromeAndroidReduced, hints: { model: 'Pixel 99', platformVersion: '16.0.0' } },
  'reduced, hints name no model': { ua: UA.chromeAndroidReduced, hints: { model: '', platformVersion: '15.0.0' } },
  'reduced, hints refused': { ua: UA.chromeAndroidReduced, hints: 'reject' },
  'reduced, hints throw': { ua: UA.chromeAndroidReduced, hints: 'throw' },
  'reduced, hints never answer': { ua: UA.chromeAndroidReduced, hints: 'hang' },
  'reduced, no client hints': { ua: UA.chromeAndroidReduced, hints: 'none' },
  'iPhone, private window': { ua: SAFARI, features: BROWSERS.safari17, directory: 'UnknownError' },
  'iPhone, normal window': { ua: SAFARI, features: BROWSERS.safari17, directory: 'open' },
  'iPhone, check never answers': { ua: SAFARI, features: BROWSERS.safari16, directory: 'hang' },
  'Firefox, private window': { ua: FIREFOX, features: BROWSERS.firefoxDesktop, directory: 'SecurityError' },
  'Brave on Android': { ua: UA.chromeAndroidReduced, features: BROWSERS.braveAndroid, hints: { model: 'Pixel 99', platformVersion: '16.0.0' } },
  'desktop Chrome, no model': { ua: DESKTOP, features: BROWSERS.chromeDesktop, hints: { model: '', platformVersion: '10.0.0' } },
  'stored id in the cookie': { cookie: { _visito: DID } },
  // what a lost or rewritten stored id leaves for the page view after it
  'stored id in the cookie, second visit': { cookie: { _visito: DID }, visits: 2 },
  'stored id in localStorage': { local: { _visito: DID } },
  'invalid stored id': { cookie: { _visito: 'zz' }, local: { _visito: 'not-an-id' } },
  'storage blocked': { localStorage: 'throw', sessionStorage: 'throw' },
  'cookies blocked': { cookies: 'blocked' },
  'second visit (cache)': { visits: 2 },
  'second visit, reduced': { visits: 2, ua: UA.chromeAndroidReduced, hints: { model: 'Pixel 99', platformVersion: '16.0.0' } },
  'second visit, stale cache': { visits: 2, staleCache: true },
  'config name': { config: { did: 'shop_1' } },
  'config name invalid': { config: { did: 'no spaces allowed' } },
  framed: { framed: true },
  'top throws': { framed: 'throw' },
  'no crypto': { crypto: false },
  'no performance': { performance: false },
  'no MessageChannel': { channel: false },
  'no timers': { timers: false },
  'document complete': { readyState: 'complete' },
  'no body': { body: false },
  'computed style throws': { computed: 'throw' },
  'line height normal': { lineHeight: 'normal' },
  'computed style garbage': { computed: 'garbage' },
  'insecure page': { protocol: 'http:' },
}

// Breaks one built-in: source run in the window. Each is applied before the script starts and again after it, before the document has parsed.
const THROW = 'function () { throw new Error("tampered") }'
const GARBAGE = '{ toString: ' + THROW + ', valueOf: ' + THROW + ' }'
const define = (target, key, descriptor) => `Object.defineProperty(${target}, ${key}, { configurable: true, ${descriptor} })`
const value = (target, key, v) => define(target, key, `writable: true, value: ${v}`)
const METHODS = [
  ['Object', 'keys'], ['Object.prototype', 'hasOwnProperty'], ['Function.prototype', 'call'], ['Array', 'isArray'],
  ['Array.prototype', 'push'], ['Array.prototype', 'join'], ['Array.prototype', 'sort'], ['Array.prototype', 'concat'], ['Array.prototype', 'slice'],
  ['String.prototype', 'replace'], ['String.prototype', 'charAt'], ['String.prototype', 'charCodeAt'], ['String.prototype', 'slice'],
  ['String.prototype', 'substring'], ['String.prototype', 'indexOf'], ['String.prototype', 'lastIndexOf'], ['String.prototype', 'split'],
  ['Number.prototype', 'toString'], ['RegExp.prototype', 'test'], ['RegExp.prototype', 'exec'], ['Math', 'round'], ['Math', 'floor'],
  ['Math', 'random'], ['Math', 'max'], ['Math', 'min'], ['Math', 'abs'], ['Date', 'now'], ['JSON', 'parse'], ['JSON', 'stringify'],
  ['globalThis', 'parseFloat'], ['globalThis', 'parseInt'], ['globalThis', 'String'], ['globalThis', 'Number'], ['globalThis', 'Uint8Array'],
  ['globalThis', 'setTimeout'], ['globalThis', 'clearTimeout'], ['globalThis', 'MessageChannel'], ['performance', 'now'],
]
const TAMPERS = []
for (const [target, key] of METHODS) {
  const k = JSON.stringify(key)
  TAMPERS.push({ name: `${target}.${key} throws`, src: value(target, k, THROW) })
  TAMPERS.push({ name: `${target}.${key} removed`, src: value(target, k, 'undefined') })
  TAMPERS.push({ name: `${target}.${key} returns garbage`, src: value(target, k, `function () { return ${GARBAGE} }`) })
}
const indexAccessors = (where, descriptor) => `for (var i = 0; i < 64; i++) ${define(where, 'String(i)', descriptor)}`
TAMPERS.push(
  { name: 'Array.prototype index setters swallow', src: indexAccessors('Array.prototype', 'get: function () { return 7 }, set: function () {}') },
  { name: 'Array.prototype index setters throw', src: indexAccessors('Array.prototype', 'get: function () {}, set: ' + THROW) },
  { name: 'Object.prototype index setters swallow', src: indexAccessors('Object.prototype', 'get: function () { return 7 }, set: function () {}') },
  { name: 'Object.prototype polluted', src: ['polluted', 'hw.evil', 'p.evil', 'x.txt.env', 'did', 'font-size'].map((k) => value('Object.prototype', JSON.stringify(k), '"!err"').replace('writable: true', 'writable: true, enumerable: true')).join(';') },
  { name: 'Object.prototype polluted, hasOwnProperty always true', src: value('Object.prototype', '"font-size"', '"9px"').replace('writable: true', 'writable: true, enumerable: true') + ';' + value('Object.prototype', '"hasOwnProperty"', 'function () { return true }') },
  // a shorthand: declared after a probe's own font properties, it would reset them
  { name: 'Object.prototype gains an enumerable font, hasOwnProperty always true', src: value('Object.prototype', '"font"', '"10px serif"').replace('writable: true', 'writable: true, enumerable: true') + ';' + value('Object.prototype', '"hasOwnProperty"', 'function () { return true }') },
  { name: 'String.prototype.slice returns ""', src: value('String.prototype', '"slice"', 'function () { return "" }') },
  { name: 'Number.prototype.toString returns "zz"', src: value('Number.prototype', '"toString"', 'function () { return "zz" }') },
  { name: 'Number.prototype.toString returns "a"', src: value('Number.prototype', '"toString"', 'function () { return "a" }') },
  { name: 'Array.prototype.join returns ""', src: value('Array.prototype', '"join"', 'function () { return "" }') },
  { name: 'Math.round returns 5', src: value('Math', '"round"', 'function () { return 5 }') },
  { name: 'Math.round returns a string', src: value('Math', '"round"', 'function () { return "x" }') },
  { name: 'RegExp.prototype.test always true', src: value('RegExp.prototype', '"test"', 'function () { return true }') },
  { name: 'String.prototype.indexOf returns 0', src: value('String.prototype', '"indexOf"', 'function () { return 0 }') },
  { name: 'performance.now returns NaN', src: value('performance', '"now"', 'function () { return NaN }') },
  { name: 'performance.now returns garbage', src: value('performance', '"now"', `function () { return ${GARBAGE} }`) },
  { name: 'performance.now returns a Symbol', src: value('performance', '"now"', 'function () { return Symbol() }') },
  // no usable fine clock and a coarse clock whose value cannot become a number
  ...[['garbage', GARBAGE], ['a Symbol', 'Symbol()'], ['a BigInt', 'BigInt(1)'], ['NaN', 'NaN']].map(([label, v]) => ({
    name: `performance.now removed, Date.now returns ${label}`,
    src: value('performance', '"now"', 'undefined') + ';' + value('Date', '"now"', `function () { return ${v} }`),
  })),
  { name: 'setTimeout schedules, then throws', src: value('globalThis', '"setTimeout"', 'function (f, ms) { __timer(f, ms); throw new Error("tampered") }') },
  {
    name: 'MessageChannel removed, setTimeout schedules then throws',
    src: value('globalThis', '"MessageChannel"', 'undefined') + ';' + value('globalThis', '"setTimeout"', 'function (f, ms) { __timer(f, ms); throw new Error("tampered") }'),
  },
  { name: 'MessageChannel delivers, then throws', src: value('globalThis', '"MessageChannel"', 'function () { var c = new __Channel(); var post = c.port2.postMessage; c.port2.postMessage = function (m) { post(m); throw new Error("tampered") }; return c }') },
)

// Every built-in method the library can reach, wrapped to record that it was called. Runs in the window before anything else.
const COUNT = `(function () {
  var apply = Reflect.apply, called = globalThis.__called = {}, define = Object.defineProperty, getOwn = Object.getOwnPropertyDescriptor, names = Object.getOwnPropertyNames
  var wrap = function (holder, label) {
    var keys = names(holder)
    for (var i = 0; i < keys.length; i++) {
      var d = getOwn(holder, keys[i])
      if (!d || typeof d.value !== 'function' || keys[i] === 'constructor') continue
      ;(function (fn, name) {
        define(holder, keys[i], { configurable: true, writable: true, enumerable: d.enumerable, value: function () { called[name] = 1; return apply(fn, this, arguments) } })
      })(d.value, label + '.' + keys[i])
    }
  }
  var holders = [[Object, 'Object'], [Object.prototype, 'Object.prototype'], [Function.prototype, 'Function.prototype'], [Array, 'Array'], [Array.prototype, 'Array.prototype'],
    [String, 'String'], [String.prototype, 'String.prototype'], [Number, 'Number'], [Number.prototype, 'Number.prototype'], [RegExp.prototype, 'RegExp.prototype'], [Math, 'Math'],
    [JSON, 'JSON'], [Date, 'Date'], [Date.prototype, 'Date.prototype'], [Uint8Array.prototype, 'Uint8Array.prototype'], [Object.getPrototypeOf(Uint8Array.prototype), 'TypedArray.prototype']]
  for (var h = 0; h < holders.length; h++) wrap(holders[h][0], holders[h][1])
  var globals = ['String', 'Number', 'Boolean', 'Object', 'Array', 'RegExp', 'Uint8Array', 'parseFloat', 'parseInt', 'isNaN', 'isFinite']
  for (var g = 0; g < globals.length; g++) {
    ;(function (name) {
      var fn = globalThis[name]
      globalThis[name] = new Proxy(fn, {
        apply: function (t, self, args) { called[name + '()'] = 1; return apply(t, self, args) },
        construct: function (t, args, nt) { called['new ' + name] = 1; return Reflect.construct(t, args, nt === globalThis[name] ? t : nt) },
      })
    })(globals[g])
  }
})()`

/** Runs one window through every visit with one bundle. Returns everything the page could observe. */
async function run(bundle, spec, tamper, when) {
  const log = []
  const out = { threw: [], visits: [] }
  const stored = { local: { ...(spec.local || {}) }, session: {}, cookie: { ...(spec.cookie || {}) } }
  if (spec.staleCache) stored.local._visito_c = JSON.stringify({ v: 3, u: 'x', t: 0, c: {} })
  for (let visit = 0; visit < (spec.visits || 1); visit++) out.visits.push(await visitOnce(bundle, spec, tamper, when, stored, log, out, 1000 + visit * 100000))
  out.stored = stored
  out.log = log
  return out
}

async function visitOnce(bundle, spec, tamper, when, stored, log, out, startAt) {
  let clock = startAt
  let seq = 0
  const queue = []
  const note = (entry) => log.push(entry)
  const ctx = vm.createContext({})
  const enter = (fn, label) => {
    ctx.__fn = fn
    try {
      vm.runInContext('__fn()', ctx, { timeout: 1500 })
    } catch (e) {
      out.threw.push(`${label}: ${e && e.message}`)
    }
  }
  const setTimer = (fn, ms) => {
    note(`setTimeout ${typeof fn} ${ms}`)
    queue.push({ at: clock + (Number(ms) || 0), seq: seq++, fn })
    return seq
  }
  const Channel = function () {
    const channel = { port1: {}, port2: { postMessage: () => { note('postMessage'); queue.push({ at: clock, seq: seq++, message: true, fn: () => channel.port1.onmessage && channel.port1.onmessage({ data: 0 }) }) } } }
    return channel
  }
  // as in a browser, the font shorthand resets the longhands declared before it, so the order of the declarations counts
  const fontSize = (own) => own['font-size'] || (own.font === '-apple-system-body' ? '17px' : own.font ? `${parseFloat(own.font)}px` : '16px')
  const node = (tag) => {
    const props = {}
    const style = {
      setProperty: (p, v, i) => {
        note(`setProperty ${tag} ${p} ${v} ${i}`)
        if (p === 'font') for (const longhand of ['font-size', 'font-family', 'line-height']) delete props[longhand]
        props[p] = v
      },
    }
    let css = ''
    Object.defineProperty(style, 'cssText', { get: () => css, set: (v) => { css = v; note(`cssText ${tag} ${v}`) } })
    const el = {
      tagName: tag, style, props, parentNode: null,
      setAttribute: (a, b) => note(`setAttribute ${tag} ${a} ${b}`),
      appendChild: (child) => { note(`appendChild ${tag} ${child.tagName}`); child.parentNode = el; return child },
      removeChild: (child) => { note(`removeChild ${tag} ${child.tagName}`); child.parentNode = null; return child },
      getBoundingClientRect: () => { note('getBoundingClientRect'); return { width: 6.002 * parseFloat(fontSize(props)) } },
    }
    Object.defineProperty(el, 'textContent', { set: (v) => note(`textContent ${tag} ${v}`) })
    return el
  }
  const listeners = {}
  const document = {
    readyState: spec.readyState || 'loading',
    createElement: (tag) => { note(`createElement ${tag}`); return node(tag) },
    addEventListener: (type, fn) => { note(`document.addEventListener ${type}`); (listeners[type] = listeners[type] || []).push(fn) },
  }
  Object.defineProperty(document, 'cookie', {
    get: () => { note('cookie get'); return Object.keys(stored.cookie).map((k) => `${k}=${stored.cookie[k]}`).join('; ') },
    set: (text) => {
      note(`cookie set ${text}`)
      if (spec.cookies === 'blocked') return
      const pair = String(text).split(';')[0]
      stored.cookie[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1)
    },
  })
  if (spec.body !== false) document.body = node('body')
  const area = (name, values) => ({
    get length() { note(`${name}.length`); return Object.keys(values).length },
    getItem: (k) => { note(`${name}.getItem ${k}`); return k in values ? values[k] : null },
    setItem: (k, v) => { note(`${name}.setItem ${k}`); values[k] = String(v) },
  })
  const computed = (el) => {
    note('getComputedStyle')
    if (spec.computed === 'throw') throw new Error('computed')
    if (spec.computed === 'garbage') return { lineHeight: {}, fontSize: [] }
    const own = (el && el.props) || {}
    return { lineHeight: own['line-height'] ? spec.lineHeight || '115px' : 'normal', fontSize: fontSize(own) }
  }
  const hints = spec.hints
  const userAgentData = hints === 'none' ? undefined : {
    brands: [{ brand: 'Not A Brand' }, { brand: 'Chromium' }], mobile: true,
    getHighEntropyValues: (names) => {
      note(`getHighEntropyValues ${names}`)
      if (hints === 'throw') throw new Error('hints')
      const P = vm.runInContext('Promise', ctx)
      if (hints === 'hang') return new P(() => {})
      if (hints === 'reject') return P.reject(new Error('policy'))
      return P.resolve(hints || { model: '', platformVersion: '14.0.0' })
    },
  }
  const navigator = {
    userAgent: spec.ua || UA.facebookAndroid, language: 'fr-FR', languages: ['fr-FR'], deviceMemory: 4, hardwareConcurrency: 8, maxTouchPoints: 5,
    platform: 'Linux armv81', cookieEnabled: true, webdriver: false, userAgentData,
    storage: spec.directory ? {
      getDirectory: () => {
        note('getDirectory')
        const P = vm.runInContext('Promise', ctx)
        if (spec.directory === 'hang') return new P(() => {})
        if (spec.directory === 'open') return P.resolve({})
        return P.reject({ name: spec.directory })
      },
    } : undefined,
  }
  const props = {
    navigator, document, location: { protocol: spec.protocol || 'https:' },
    screen: { width: 393, height: 873, availWidth: 393, availHeight: 849, colorDepth: 24 }, devicePixelRatio: 2.75,
    matchMedia: () => ({ matches: false }), getComputedStyle: computed, VisitoConfig: spec.config,
    addEventListener: (type) => note(`addEventListener ${type}`),
    __timer: setTimer, __Channel: Channel,
  }
  if (spec.crypto !== false) props.crypto = { getRandomValues: (b) => { note('getRandomValues'); for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 255; return b } }
  if (spec.performance !== false) props.performance = { now: () => { const t = clock; clock += 0.25; return t } }
  if (spec.channel !== false) props.MessageChannel = Channel
  if (spec.timers !== false) {
    props.setTimeout = setTimer
    props.clearTimeout = (id) => { note(`clearTimeout ${id}`); const t = queue.find((q) => q.seq === id - 1); if (t) t.cancelled = true }
  }
  Object.assign(ctx, props)
  vm.runInContext('globalThis.window = globalThis; window.self = window', ctx)
  if (spec.framed === true) vm.runInContext('window.top = {}', ctx)
  else if (spec.framed === 'throw') vm.runInContext('Object.defineProperty(window, "top", { get: function () { throw new Error("cross-origin") } })', ctx)
  else vm.runInContext('window.top = window', ctx)
  for (const [name, mode] of [['localStorage', spec.localStorage], ['sessionStorage', spec.sessionStorage]]) {
    if (mode === 'throw') vm.runInContext(`Object.defineProperty(window, "${name}", { get: function () { throw new Error("blocked") } })`, ctx)
    else ctx[name] = area(name, name === 'localStorage' ? stored.local : stored.session)
  }
  // a fixed coarse clock that follows the virtual one
  ctx.__clock = () => 1700000000000 + Math.floor(clock)
  vm.runInContext('Date.now = function () { return __clock() }', ctx)
  // and a seeded random source, for the stored id of a window without crypto
  vm.runInContext('Math.random = (function () { var s = 7; return function () { s = (s * 16807) % 2147483647; return s / 2147483647 } })()', ctx)
  if (spec.features) {
    // the engine features as the detection tests them; done here, not with the test helper, so every object is the window's own
    ctx.__features = spec.features
    vm.runInContext(`(function () {
      var conditions = []
      for (var f = 0; f < __features.length; f++) {
        var feature = __features[f]
        if (feature === 'insecure') { window.isSecureContext = false; continue }
        if (feature.indexOf('(') >= 0) { conditions[conditions.length] = feature; continue }
        var names = feature.split('.'), holder = window
        for (var i = 0; i < names.length - 1; i++) {
          if (holder[names[i]] == null) holder[names[i]] = /^[A-Z]/.test(names[i]) ? function () {} : {}
          holder = holder[names[i]]
        }
        var last = names[names.length - 1]
        if (!(last in holder)) holder[last] = /^[A-Z]/.test(last) ? function () {} : null
      }
      window.CSS = { supports: function (t) { return conditions.indexOf(t) >= 0 } }
    })()`, ctx)
  }
  vm.runInContext(COUNT, ctx)
  // a tamper that cannot be installed in this window (no performance object) is skipped, not counted as a throw
  const apply = () => { if (tamper) vm.runInContext('try { ' + tamper.src + ' } catch (e) {}', ctx) }
  const unhandled = []
  const onRejection = (reason) => unhandled.push(String(reason && reason.message ? reason.message : reason))
  process.on('unhandledRejection', onRejection)
  const result = { atStart: null, callbacks: [], final: null }
  try {
    if (when === 'early') apply()
    enter(() => vm.runInContext(bundle, ctx, { timeout: 1500 }), 'load')
    // serialised here, with this realm's JSON: the window's own may be the broken built-in
    const show = (r) => JSON.stringify(r, (k, x) => (typeof x === 'number' && !isFinite(x) ? String(x) : typeof x === 'bigint' || typeof x === 'symbol' ? String(x) : x))
    ctx.__seen = (r) => result.callbacks.push(show(r))
    ctx.__start = (r) => (result.atStart = show(r))
    // a deferred build is started at once, so its session is compared with the core's from the same moment; the core has no start()
    enter(() => vm.runInContext('typeof Visito !== "undefined" && (typeof Visito.start === "function" && Visito.start(), __start(Visito.getSync()), Visito.get(function (r) { __seen(r) }))', ctx), 'page')
    if (when === 'late') apply()
    const fire = (type) => (listeners[type] || []).splice(0).forEach((fn) => enter(fn, type))
    const drain = async (timers) => {
      for (let guard = 0; guard < 2000; guard++) {
        await new Promise((resolve) => setImmediate(resolve))
        const live = queue.filter((q) => !q.cancelled && !q.done && (timers || q.message))
        if (!live.length) return
        live.sort((a, b) => a.at - b.at || (b.message ? 1 : 0) - (a.message ? 1 : 0) || a.seq - b.seq)
        const next = live[0]
        if (next.at > startAt + END_MS) return
        next.done = true
        clock = Math.max(clock, next.at)
        enter(next.fn, next.message ? 'message' : 'timer')
      }
    }
    // the document parses before any timer is due
    await drain(false)
    if (document.readyState === 'loading') {
      document.readyState = 'interactive'
      fire('DOMContentLoaded')
    }
    await drain(true)
    result.final = vm.runInContext('typeof Visito !== "undefined"', ctx) ? show(vm.runInContext('Visito.getSync()', ctx)) : 'no bundle'
  } finally {
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onRejection)
  }
  result.unhandled = unhandled
  // a tamper of a counted name replaces the counting wrapper, so built-ins are compared only on intact runs
  result.called = Object.keys(vm.runInContext('__called', ctx)).sort()
  return result
}

const outcome = (o) => JSON.stringify({ threw: o.threw, visits: o.visits.map(({ called, ...v }) => v), stored: o.stored, log: o.log })
const escaped = (o) => o.threw.concat(...o.visits.map((v) => v.unhandled))
// vm's time limit stopped a script: in a browser the page would stay frozen, so nothing after it could be observed
const HUNG = /Script execution timed out/
/** What R18 forbids, as found in a run: a hang, each error let through to the page, and callbacks other than one per visit. */
function failures(o) {
  const found = []
  if (escaped(o).some((e) => HUNG.test(e))) found.push('hangs')
  for (const e of escaped(o)) if (!HUNG.test(e) && found.indexOf(`throws ${e}`) < 0) found.push(`throws ${e}`)
  if (o.visits.some((v) => v.callbacks.length !== 1)) found.push(`callbacks ${o.visits.map((v) => v.callbacks.length).join(',')}`)
  return found
}
const describe = (o) => `callbacks ${o.visits.map((v) => v.callbacks.length).join(',')}${escaped(o).length ? ', let through ' + escaped(o).join('; ') : ''}`
const STORED_ID = ['did', 'didNew', 'didSrc']
/** Field-by-field comparison against the clean candidate outcome: better, worse, or both wrong. */
function judge(ref, cur, clean) {
  const fields = {
    threw: (o) => JSON.stringify(o.threw.concat(...o.visits.map((v) => v.unhandled))),
    callbacks: (o) => JSON.stringify(o.visits.map((v) => v.callbacks.length)),
    stored: (o) => JSON.stringify(o.stored),
  }
  const parse = (s) => { try { return JSON.parse(s) } catch (e) { return null } }
  const verdicts = []
  for (const [name, get] of Object.entries(fields)) {
    if (get(ref) === get(cur)) continue
    verdicts.push({ field: name, kind: get(cur) === get(clean) ? 'better' : get(ref) === get(clean) ? 'worse' : 'both wrong', ref: get(ref), cur: get(cur) })
  }
  for (let v = 0; v < cur.visits.length; v++) {
    const a = parse(ref.visits[v] && ref.visits[v].final)
    const b = parse(cur.visits[v].final)
    const c = parse(clean.visits[v] && clean.visits[v].final)
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
    if (!a || !b) {
      if (JSON.stringify(a) !== JSON.stringify(b)) verdicts.push({ field: `visit ${v} reading`, kind: b ? 'better' : 'worse', ref: JSON.stringify(a), cur: JSON.stringify(b) })
      continue
    }
    // the stored id, whether it is new and where it was found describe one outcome: kept, or lost
    const storedId = (r) => r && JSON.stringify(STORED_ID.map((key) => r[key]))
    if (storedId(a) !== storedId(b)) {
      verdicts.push({ field: `visit ${v} stored id`, kind: storedId(b) === storedId(c) ? 'better' : storedId(a) === storedId(c) ? 'worse' : 'both wrong', ref: storedId(a), cur: storedId(b) })
    }
    for (const key of keys) {
      if (key === 't' || key === 'ms' || key === 'c' || STORED_ID.indexOf(key) >= 0) continue
      const x = JSON.stringify(a[key])
      const y = JSON.stringify(b[key])
      if (x === y) continue
      const z = JSON.stringify(c && c[key])
      verdicts.push({ field: `visit ${v} ${key}`, kind: y === z ? 'better' : x === z ? 'worse' : 'both wrong', ref: x, cur: y })
    }
    const ck = new Set([...Object.keys(a.c || {}), ...Object.keys(b.c || {})])
    for (const key of ck) {
      const x = JSON.stringify(a.c && a.c[key])
      const y = JSON.stringify(b.c && b.c[key])
      if (x === y) continue
      const z = JSON.stringify(c && c.c && c.c[key])
      verdicts.push({ field: `visit ${v} c.${key}`, kind: y === z ? 'better' : x === z ? 'worse' : 'both wrong', ref: x, cur: y })
    }
  }
  return verdicts
}

let intactDiffs = 0
let worse = 0
let newBuiltins = 0
let tamperDiffs = 0
let referenceFails = 0
let runs = 0
const notes = []
// --shard=<i>/<n> runs every n-th window from the i-th, so several processes can share the work
const [shard, shards] = (only('--shard') || '0/1').split('/').map(Number)
for (const [label, spec] of Object.entries(WINDOWS).filter(([name], i) => name.includes(only('--window')) && i % shards === shard)) {
  const ref = await run(BUNDLES.reference, spec, null, null)
  const cur = await run(BUNDLES.candidate, spec, null, null)
  runs += 2
  if (process.argv.includes('--dump')) console.log(label, JSON.stringify(cur.visits.map((v) => ({ cb: v.callbacks.length, final: JSON.parse(v.final) }))), cur.threw)
  if (outcome(ref) !== outcome(cur)) {
    intactDiffs++
    notes.push(`DIFF  ${label}, intact`)
    if (SHOW) notes.push('  ref ' + outcome(ref), '  cur ' + outcome(cur))
  }
  if (cur.threw.length || cur.visits.some((v) => v.callbacks.length !== 1)) notes.push(`FAIL  ${label}, intact: threw ${cur.threw} / callbacks ${cur.visits.map((v) => v.callbacks.length)}`)
  const refCalled = new Set(ref.visits.flatMap((v) => v.called))
  const extra = [...new Set(cur.visits.flatMap((v) => v.called))].filter((n) => !refCalled.has(n))
  if (extra.length) {
    newBuiltins++
    notes.push(`NEW   ${label}: built-ins the reference never calls here: ${extra.join(', ')}`)
  }
  for (const tamper of TAMPERS.filter((t) => t.name.includes(only('--tamper')))) {
    for (const when of ['early', 'late']) {
      const a = await run(BUNDLES.reference, spec, tamper, when)
      const b = await run(BUNDLES.candidate, spec, tamper, when)
      runs += 2
      const where = `${label} / ${tamper.name} ${when === 'early' ? 'before start' : 'after start'}`
      const fa = failures(a)
      const fb = failures(b)
      if (fa.length) {
        referenceFails++
        // the reference itself throws, hangs or miscounts callbacks here: that failure is its own. The candidate is worse only by
        // adding a kind of failure the reference does not have; what either reports after it has failed is shown, not judged
        const added = fb.filter((kind) => fa.indexOf(kind) < 0)
        if (added.length) {
          worse++
          notes.push(`FAIL  ${where}: candidate ${fb.join(', ')} (${describe(b)}), reference ${fa.join(', ')} (${describe(a)})`)
        } else notes.push(`${fb.length ? 'old  ' : 'better'} ${where}: reference ${fa.join(', ')} (${describe(a)}); candidate ${fb.length ? fb.join(', ') : 'none'}${outcome(a) === outcome(b) ? ', same outcome' : ', outcome differs'}`)
        if (outcome(a) !== outcome(b)) tamperDiffs++
        continue
      }
      if (fb.length) {
        worse++
        notes.push(`FAIL  ${where}: candidate ${fb.join(', ')} (${describe(b)}) where the reference does not fail`)
        tamperDiffs++
        continue
      }
      if (outcome(a) === outcome(b)) continue
      tamperDiffs++
      const verdicts = judge(a, b, cur)
      const bad = verdicts.filter((v) => v.kind === 'worse')
      if (bad.length) worse++
      const summary = verdicts.length ? verdicts.map((v) => `${v.field} ${v.kind}: ${v.ref} -> ${v.cur}`).join(' | ') : 'calls on the window only'
      notes.push(`${bad.length ? 'WORSE' : 'diff '} ${where}: ${summary}`)
    }
  }
}
for (const line of notes) console.log(line)
console.log(`\n${runs} runs over ${Object.keys(WINDOWS).length} windows and ${TAMPERS.length} broken built-ins (each before and after start)`)
console.log(`intact windows that differ: ${intactDiffs}; windows where the candidate calls a built-in the reference does not: ${newBuiltins}`)
console.log(`tampered runs that differ: ${tamperDiffs}; runs where the reference itself fails: ${referenceFails}`)
console.log(`runs where the candidate is worse, or fails in a way the reference does not: ${worse}`)
process.exit(intactDiffs || newBuiltins || worse ? 1 : 0)
