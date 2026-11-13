// Proves in a real engine what the deferred build (dist/visito.defer.min.js and .esm.js) promises: loading it, and calling getSync() and
// get() before start(), reads and stores nothing; start() is the product build's session, from whenever it is called; start({ store: false })
// reads the device but no cookie, no storage and no file system, and gives the same ids. Rows (a) to (h) of research/designs/consent.md;
// (i) the withdrawal lines of docs/LEGAL.md; (j) the one console message the run skips, Firefox's own font-visibility warning, shown
// to come from the browser with a page that loads no library. Every other console message and every page error fails the run.
// Usage: node lab/defer.mjs [chromium|firefox|webkit]
//
// An init script wraps, before any page script runs, every accessor and method of the browser objects the library could reach
// (Navigator, Document, Node, EventTarget, Storage, StorageManager, Crypto, Performance, Screen, IDBFactory, the client hints, CSS)
// and the window's own properties that are not built-in constructors, and logs each use. A MutationObserver logs every element added
// after the page's own. What the browser does not let a page redefine (document, location, top, window) cannot be wrapped: the run
// names those, and the reads behind them (document.cookie, readyState, createElement) are on the wrapped prototypes. The same
// instrument on the product build is the control: it must see the reads.
import http from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as playwright from 'playwright'
import { blockedFont, fontsNotInControl } from './notices.mjs'
import { problems } from './schema.mjs'
import { loadPage, stopOnPageLoad } from './launch.mjs'

const engineName = process.argv[2] || 'chromium'
const DIST = new URL('../dist/', import.meta.url)
const FILES = {
  '/visito.defer.min.js': readFileSync(new URL('visito.defer.min.js', DIST)),
  '/visito.defer.esm.js': readFileSync(new URL('visito.defer.esm.js', DIST)),
  '/visito.min.js': readFileSync(new URL('visito.min.js', DIST)),
  '/visito.esm.js': readFileSync(new URL('visito.esm.js', DIST)),
  '/empty.js': '',
}
const WAIT_MS = 3000

// Runs in the page before anything else. Logging is on from the first line of the page and stops only when the harness says so.
const INSTRUMENT = `(() => {
  const log = [], skipped = [], define = Object.defineProperty, getOwn = Object.getOwnPropertyDescriptor, names = Object.getOwnPropertyNames
  let on = true
  const note = (what) => { if (on) log.push(what) }
  const original = { cookie: getOwn(Document.prototype, 'cookie').get, estimate: window.StorageManager && StorageManager.prototype.estimate }
  // the harness closes the log with a key press, which runs no script of its own in the page (an evaluate would: it reads globalThis,
  // performance and more before the function it is given), and the log leaves over the console
  const print = console.log.bind(console)
  EventTarget.prototype.addEventListener.call(window, 'keydown', (event) => {
    if (event.key !== 'F9' || !on) return
    on = false
    print('LAB_LOG ' + JSON.stringify(log))
  }, true)
  const wrapFn = (fn, label) => {
    const wrapper = function () {
      note('call ' + label)
      return new.target ? Reflect.construct(fn, arguments, new.target) : Reflect.apply(fn, this, arguments)
    }
    // an instance made through the wrapper keeps the real prototype, so a port or a buffer works as before
    wrapper.prototype = fn.prototype
    return wrapper
  }
  const wrap = (holder, label, key) => {
    const d = getOwn(holder, key)
    if (!d) return
    if (!d.configurable) { skipped.push(label + '.' + key); return }
    if (d.get || d.set) {
      define(holder, key, {
        configurable: true, enumerable: d.enumerable,
        get: d.get && function () { note('get ' + label + '.' + key); return d.get.call(this) },
        set: d.set && function (v) { note('set ' + label + '.' + key); return d.set.call(this, v) },
      })
    } else if (typeof d.value === 'function' && key !== 'constructor') {
      define(holder, key, { configurable: true, enumerable: d.enumerable, writable: d.writable, value: wrapFn(d.value, label + '.' + key) })
    } else {
      // a plain value: read through a getter that logs, written through a setter that keeps the value
      let value = d.value
      define(holder, key, { configurable: true, enumerable: d.enumerable, get: () => { note('get ' + label + '.' + key); return value }, set: (v) => { note('set ' + label + '.' + key); value = v } })
    }
  }
  const PROTOS = ['Navigator', 'Document', 'Node', 'EventTarget', 'Storage', 'StorageManager', 'Crypto', 'Performance', 'Screen', 'IDBFactory', 'NavigatorUAData', 'CookieStore', 'MessagePort', 'MediaQueryList']
  for (const name of PROTOS) {
    const proto = window[name] && window[name].prototype
    if (proto) for (const key of names(proto)) wrap(proto, name + '.prototype', key)
  }
  if (window.CSS) for (const key of names(CSS)) wrap(CSS, 'CSS', key)
  // the window's own properties, built-in constructors and namespaces apart (they are not the browser's state), plus the names
  // the library could look up that the window does not have: its configuration, and engine features some builds lack
  const own = names(window).filter((key) => !/^[A-Z]/.test(key) && !['Intl', 'Math', 'JSON', 'Reflect', 'Atomics', 'WebAssembly', 'console'].includes(key))
  for (const key of own) wrap(window, 'window', key)
  for (const key of ['VisitoConfig', 'msCrypto', 'requestIdleCallback', 'cookieStore']) if (!(key in window)) { define(window, key, { configurable: true, writable: true, value: undefined }); wrap(window, 'window', key) }
  for (const key of ['MessageChannel', 'MutationObserver', 'Worker', 'XMLHttpRequest', 'WebSocket', 'Image', 'BroadcastChannel', 'OfflineAudioContext', 'Intl']) if (key in window) wrap(window, 'window', key)
  // elements the page did not write: anything added that is not one of the page's own script, iframe, meta or title tags
  new MutationObserver((records) => {
    // the observer's own reads of the nodes are not logged
    const was = on
    on = false
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && !/^(SCRIPT|IFRAME|META|TITLE|HEAD|BODY|HTML)$/.test(n.nodeName)) log.push('element ' + n.nodeName)
    on = was
  }).observe(document, { childList: true, subtree: true })
  log.length = 0
  Object.defineProperty(window, '__lab', { value: { log, skipped, stop: () => { on = false }, original } })
})()`

// the nodes the text-size read (src/probes.ts, textSize) adds to the body, with its declarations in its order, as markup
const PROBE_BASE = 'position: absolute !important; white-space: nowrap !important; letter-spacing: 0 !important; word-spacing: 0 !important; text-transform: none !important; font-style: normal !important; font-weight: 400 !important; '
const PLAIN_PROBE = '<div aria-hidden="true" style="position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important">' +
  `<span style="${PROBE_BASE}line-height: calc(env(preferred-text-scale, 1) * 100px) !important"></span>` +
  `<span id="fixed" style="${PROBE_BASE}font-family: monospace !important; font-size: 100px !important">mmmmmmmmmm</span>` +
  (engineName === 'webkit' ? `<span style="${PROBE_BASE}font: -apple-system-body !important"></span>` : '') + '</div>'
const SCRIPT = (src, body = '') => `<script src="${src}"></script>${body ? `<script>${body}</script>` : ''}`
const PAGE = (head) => `<!doctype html><meta charset="utf-8"><title>defer</title>${head}<body>`
// the page's own calls; the cookie is read with the unwrapped getter right before and after start()
const START = (options) => `window.__cookieBefore = __lab.original.cookie.call(document); Visito.start(${options || ''}); window.__cookieAfter = __lab.original.cookie.call(document)`
// the callback says it ran over the console, so the harness waits without polling the page
const QUEUE = "window.__early = Visito.getSync(); Visito.get(function (r) { window.__got = r; window.__calls = (window.__calls || 0) + 1; console.log('VISITO_DONE') })"
const pages = {
  '/a': PAGE(SCRIPT('/visito.defer.min.js', QUEUE)),
  '/a-core': PAGE(SCRIPT('/visito.min.js', QUEUE)),
  '/b': PAGE(`<script type="module">import { get, getSync, start } from '/visito.defer.esm.js'; window.Visito = { start: start, get: get, getSync: getSync }; ${QUEUE}</script>`),
  '/b-core': PAGE(`<script type="module">import { get, getSync } from '/visito.esm.js'; window.Visito = { get: get, getSync: getSync }; ${QUEUE}</script>`),
  '/blank': PAGE(SCRIPT('/empty.js')),
  // /c-parse with no script: text in the default font, and what the text-size read adds to the page as plain markup, the same
  // nodes, styles and text
  '/c-parse-plain': PAGE('') + '<p>mmmmmmmmmm</p>' + PLAIN_PROBE,
  '/core': PAGE(SCRIPT('/visito.min.js', QUEUE)),
  '/c-parse': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + ';' + START())),
  '/c-ready': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + `; document.addEventListener('DOMContentLoaded', function () { ${START()} })`)),
  '/c-load': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + `; addEventListener('load', function () { ${START()} })`)),
  '/c-late': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + `; addEventListener('load', function () { setTimeout(function () { ${START()} }, 5000) })`)),
  '/d': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + ';' + START('{ store: false }'))),
  '/e-false-true': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + '; Visito.start({ store: false }); Visito.start({ store: true }); Visito.start()')),
  '/e-true-false': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + '; Visito.start(); Visito.start({ store: false })')),
  '/g': PAGE('<iframe src="/g-frame"></iframe>'),
  '/g-frame': PAGE(SCRIPT('/visito.defer.min.js', QUEUE + '; Visito.start()')),
}
const server = http.createServer((request, response) => {
  const path = request.url.split('?')[0]
  if (FILES[path] !== undefined) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[path])
  if (pages[path]) return response.writeHead(200, { 'content-type': 'text/html' }).end(pages[path])
  response.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
// localhost: a secure context, as docs/DECISIONS.md measured the file-system check
const origin = `http://localhost:${server.address().port}`

const checks = []
const notes = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: ok ? '' : detail })
const browser = await playwright[engineName].launch()
const errors = []
// Firefox's font-visibility warnings (lab/notices.mjs), by page and font: skipped by the console check, and row (j) shows they are the browser's
const ignored = []

/** A page that reports the library's callback and the closed log; `done` resolves when the callback has run. */
async function openPage(context, path) {
  const page = await context.newPage()
  let logged
  let done
  const log = new Promise((resolve) => (logged = resolve))
  const finished = new Promise((resolve) => (done = resolve))
  page.on('pageerror', (error) => errors.push(`${path}: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    const font = blockedFont(engineName, `${message.type()}: ${text}`)
    if (text === 'VISITO_DONE') done()
    else if (text.indexOf('LAB_LOG ') === 0) logged(JSON.parse(text.slice(8)))
    else if (font) ignored.push({ path, font })
    else errors.push(`${path}: console ${message.type()}: ${text}`)
  })
  await loadPage(page, origin + path, { waitUntil: 'load' })
  return { page, log, finished }
}
/**
 * The fonts Firefox warns about in a private launch where no page loads the library: /c-parse-plain in fresh contexts, at least
 * three and, while `needed` (the fonts the library's pages were warned about) is not covered yet, up to six. The listener is on
 * each context before its first page, so the initial about:blank is heard too, and it takes warnings from every document. More
 * than one context, because each warning comes once per content process, from whichever document asks first, and that can be a
 * document the listener does not hear in time; each fresh context is another chance, and the union is what any of them saw. A
 * font that only the library makes Firefox look up is never in the union, however many contexts run.
 */
async function controlFonts(needed) {
  const alone = await playwright.firefox.launch({ firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } })
  const fonts = []
  let contexts = 0
  try {
    for (; contexts < 6 && (contexts < 3 || fontsNotInControl(needed, fonts).length); contexts++) {
      const context = await alone.newContext()
      context.on('console', (message) => {
        const font = blockedFont(engineName, `${message.type()}: ${message.text()}`)
        if (font && fonts.indexOf(font) < 0) fonts.push(font)
        else if (!font) errors.push(`/c-parse-plain (control): console ${message.type()}: ${message.text()}`)
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(`/c-parse-plain (control): ${error.message}`))
      await loadPage(page, origin + '/c-parse-plain', { waitUntil: 'load' })
      // the harness reads what the library reads, so layout resolves the same families
      await page.evaluate(() => { const n = document.getElementById('fixed'); return [getComputedStyle(n).fontSize, n.getBoundingClientRect().width, document.body.getBoundingClientRect().width] })
      await page.waitForTimeout(500)
      await context.close()
    }
  } finally {
    await alone.close()
  }
  return { fonts, contexts }
}
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))])

/** One fresh context (with `init` run after the instrument): loads `path`, waits for the callback (`done`) or for `ms`, closes the log and returns what the page saw. */
async function visit(path, { ms = WAIT_MS, done = false, frame, init } = {}) {
  const context = await browser.newContext()
  await context.addInitScript(INSTRUMENT)
  if (init) await context.addInitScript(init)
  const { page, log, finished } = await openPage(context, path)
  if (done) await within(finished, 15000)
  else await page.waitForTimeout(ms)
  await page.keyboard.press('F9')
  const closed = await within(log, 5000)
  const target = frame ? page.frames().find((f) => f.url().endsWith(frame)) : page
  const seen = await target.evaluate(async () => {
    __lab.stop()
    const usage = __lab.original.estimate ? (await __lab.original.estimate.call(navigator.storage)).usage : null
    let session = null
    try { session = sessionStorage.length } catch (e) { session = 'throws' }
    return {
      skipped: __lab.skipped.slice(), early: window.__early, got: window.__got, calls: window.__calls, usage, session,
      cookieBefore: window.__cookieBefore, cookieAfter: window.__cookieAfter, start: typeof (window.Visito && window.Visito.start),
      sync: window.Visito && window.Visito.getSync ? window.Visito.getSync() : undefined,
    }
  })
  // what the key press closed; anything logged after it is the harness's own
  seen.log = closed || ['(the log never arrived)']
  const cookies = await context.cookies()
  const state = await context.storageState()
  seen.stored = { cookies: cookies.map((c) => c.name), origins: state.origins.map((o) => `${o.origin}: ${o.localStorage.map((e) => e.name).join(',')}`) }
  return { seen, context, page }
}
const nothingStored = (seen) => !seen.stored.cookies.length && !seen.stored.origins.length && (seen.session === 0)
const STORAGE_TRAFFIC = /cookie|Storage\.prototype|window\.(localStorage|sessionStorage|indexedDB)|StorageManager|IDBFactory|CookieStore|window\.cookieStore/
// the withdrawal snippet of docs/LEGAL.md, word for word: run after get() has called back, it must leave nothing behind
const WITHDRAW = `var name = '_visito' // or the name set in VisitoConfig.did
document.cookie = name + '=; Path=/; Max-Age=0' + (location.protocol === 'https:' ? '; Secure' : '')
try { localStorage.removeItem(name); localStorage.removeItem(name + '_c') } catch (e) {}
try { sessionStorage.removeItem(name + '_c') } catch (e) {}`
// storage the browser denies: reading localStorage throws, so the library keeps its cache in sessionStorage
const NO_LOCAL = "Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new DOMException('denied', 'SecurityError') } })"

// a harness page that does not load ends the run with a FAIL line, after the checks so far (lab/launch.mjs)
let stopped = null
try {
  // the instrument, the empty page and the product build: what the rows below are compared with
  const blank = await visit('/blank')
  check('control: an empty page logs nothing and stores nothing', !blank.seen.log.length && nothingStored(blank.seen), blank.seen.log.slice(0, 5).join(', '))
  notes.push(`not wrappable here (the reads behind them are on the wrapped prototypes): ${blank.seen.skipped.filter((k) => !/\.[A-Z_]+$/.test(k)).join(', ') || 'none'}`)
  const usage0 = blank.seen.usage
  await blank.context.close()
  const core = await visit('/core', { done: true })
  const coreReading = core.seen.got
  check('control: the product build is seen reading the cookie, storage and navigator at load', ['get Document.prototype.cookie', 'call Storage.prototype.getItem', 'get Navigator.prototype.userAgent'].every((e) => core.seen.log.includes(e)), core.seen.log.slice(0, 8).join(', '))
  check('control: the product build stores a cookie', core.seen.stored.cookies.includes('_visito'))
  check('control: the product build gives a complete reading', coreReading && coreReading.id && coreReading.idStrict && coreReading.did && !problems(coreReading).length, JSON.stringify(coreReading && coreReading.flags))
  if (engineName === 'firefox') notes.push(`Firefox origin usage: empty page ${usage0} bytes, product build on a new visitor ${core.seen.usage} bytes`)
  await core.context.close()

  // (a) and (b): loaded, getSync() and get() called, never started
  for (const [row, path, label] of [['a', '/a', 'script tag'], ['b', '/b', 'ES module']]) {
    const { seen, context } = await visit(path)
    check(`(${row}) ${label}, no start(), load + 3 s: no access to any instrumented object, no element, no timer, no listener`, !seen.log.length, seen.log.slice(0, 10).join(', '))
    check(`(${row}) ${label}: no cookie, no localStorage, no sessionStorage`, nothingStored(seen), JSON.stringify(seen.stored) + ' session ' + seen.session)
    check(`(${row}) ${label}: getSync() is null, get() has not called back, start is there`, seen.early === null && seen.got === undefined && seen.start === 'function', `${seen.early} ${seen.got} ${seen.start}`)
    if (engineName === 'firefox') check(`(${row}) ${label}: Firefox origin usage as on an empty page`, seen.usage === usage0, `${seen.usage} vs ${usage0}`)
    await context.close()
    const control = await visit(`${path}-core`, { done: true })
    check(`(${row}) control: the same instrument on the product ${label} build sees reads at load`, control.seen.log.includes('get Document.prototype.cookie') && control.seen.stored.cookies.includes('_visito'), control.seen.log.slice(0, 5).join(', '))
    await control.context.close()
  }

  // (c) start() at four moments: a complete reading, the product build's ids, the cookie only from start() on
  for (const [path, label] of [['/c-parse', 'during parse'], ['/c-ready', 'at DOMContentLoaded'], ['/c-load', 'after load'], ['/c-late', '5 s after load']]) {
    const { seen, context } = await visit(path, { done: true })
    const r = seen.got
    check(`(c) start() ${label}: one callback with a complete reading`, r && r.id && r.idStrict && r.did && seen.calls === 1 && !problems(r).length, JSON.stringify(r && r.flags) + ' calls ' + seen.calls)
    check(`(c) start() ${label}: the product build's ids`, r && coreReading && r.id === coreReading.id && r.idStrict === coreReading.idStrict, `${r && r.id} vs ${coreReading && coreReading.id}`)
    check(`(c) start() ${label}: no cookie before start(), the stored id right after it`, seen.cookieBefore === '' && /_visito=/.test(seen.cookieAfter || '') && seen.stored.cookies.includes('_visito'), `before "${seen.cookieBefore}" after "${seen.cookieAfter}"`)
    await context.close()
  }

  // (d) store: false
  const d = await visit('/d', { done: true })
  const bare = d.seen.got
  check('(d) store: false: no cookie, no localStorage, no sessionStorage', nothingStored(d.seen) && d.seen.cookieAfter === '', JSON.stringify(d.seen.stored))
  check('(d) store: false: the cookie, every storage, the file system and IndexedDB are never touched', !d.seen.log.some((e) => STORAGE_TRAFFIC.test(e)), d.seen.log.filter((e) => STORAGE_TRAFFIC.test(e)).slice(0, 8).join(', '))
  check('(d) store: false: the device is read', d.seen.log.includes('get Navigator.prototype.userAgent'))
  check('(d) store: false: no stored id, no private-window answer', bare && bare.did === null && bare.didNew === false && bare.didSrc === '' && bare.flags.private === null && !('x.private' in bare.c), JSON.stringify(bare && { did: bare.did, private: bare.flags.private }))
  check('(d) store: false: the ids of the stored mode', bare && coreReading && bare.id && bare.id === coreReading.id && bare.idStrict === coreReading.idStrict, `${bare && bare.id} vs ${coreReading && coreReading.id}`)
  if (engineName === 'firefox') check('(d) store: false: Firefox origin usage as on an empty page', d.seen.usage === usage0, `${d.seen.usage} vs ${usage0}`)
  await d.context.close()

  // (e) start() twice
  const e1 = await visit('/e-false-true', { done: true })
  check('(e) store: false, then store: true, then no options: nothing stored, one session', nothingStored(e1.seen) && e1.seen.got && e1.seen.got.did === null && e1.seen.calls === 1, JSON.stringify(e1.seen.stored))
  await e1.context.close()
  const e2 = await visit('/e-true-false', { done: true })
  const writes = e2.seen.log.filter((e) => e === 'set Document.prototype.cookie').length
  check('(e) start(), then store: false: the cookie written once, the reading kept', writes === 1 && e2.seen.stored.cookies.includes('_visito') && e2.seen.got.did, `cookie writes ${writes}`)
  await e2.context.close()

  // (f) a second view: from the cache in stored mode, read fresh with store: false
  for (const [path, label, cached] of [['/c-parse', 'stored mode', true], ['/d', 'store: false', false]]) {
    const first = await visit(path, { done: true })
    const view = await openPage(first.context, path)
    await within(view.finished, 15000)
    const second = await view.page.evaluate(() => window.__got)
    const fromCache = !!second && 't' in second && second.t.cache === 0
    check(`(f) ${label}: the second view ${cached ? 'is' : 'is not'} served from the cache, with the same ids`, fromCache === cached && second.id === first.seen.got.id && second.idStrict === first.seen.got.idStrict, JSON.stringify(second && second.t))
    if (!cached) check('(f) store: false: still nothing stored after two views', !(await first.context.cookies()).length && !(await first.context.storageState()).origins.length)
    await first.context.close()
  }

  // (i) consent withdrawn: the documented snippet, after the callback, removes the cookie, the stored id and the cache
  // and again where reading localStorage throws, so the cache is in sessionStorage
  for (const [init, label] of [[undefined, 'localStorage'], [NO_LOCAL, 'sessionStorage, localStorage throwing']]) {
    const withdrawn = await visit('/c-parse', { done: true, init })
    const before = await withdrawn.context.storageState()
    const cached = await withdrawn.page.evaluate(() => sessionStorage.getItem('_visito_c') !== null)
    await withdrawn.page.evaluate(WITHDRAW)
    const after = await withdrawn.context.storageState()
    const left = after.origins.flatMap((o) => o.localStorage.map((e) => e.name))
    const session = await withdrawn.page.evaluate(() => sessionStorage.length)
    const stored = before.cookies.length && (init ? cached : before.origins.length)
    check(`(i) cache in ${label}: the withdrawal snippet in docs/LEGAL.md leaves no cookie, no stored id and no cache`, stored && !after.cookies.length && !left.length && session === 0, `before: cookies ${before.cookies.length} cached ${init ? cached : before.origins.length}; after: cookies ${after.cookies.map((c) => c.name)} localStorage ${left} sessionStorage ${session}`)
    await withdrawn.context.close()
  }

  // (g) a same-origin frame
  const g = await visit('/g', { frame: '/g-frame', done: true })
  check('(g) a same-origin frame: start() gives null, get() calls back null, nothing stored', g.seen.got === null && g.seen.sync === null && g.seen.calls === 1 && !g.seen.stored.cookies.length && !g.seen.stored.origins.length, JSON.stringify({ got: g.seen.got, calls: g.seen.calls, stored: g.seen.stored }))
  await g.context.close()

  // (h) a private session: WebKit's default context is ephemeral; Firefox needs its private-browsing preference, in its own launch
  const privateRuns = engineName === 'webkit' ? [[browser, 'the default ephemeral context']] : engineName === 'firefox' ? [[await playwright.firefox.launch({ firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } }), 'private browsing (autostart)']] : []
  for (const [where, label] of privateRuns) {
    for (const [path, expect] of [['/c-parse', true], ['/d', null]]) {
      const context = await where.newContext()
      await context.addInitScript(INSTRUMENT)
      const view = await openPage(context, path)
      await within(view.finished, 15000)
      const r = await view.page.evaluate(() => window.__got)
      check(`(h) ${label}, ${expect ? 'stored mode' : 'store: false'}: flags.private is ${expect}`, r && r.flags.private === expect && (expect || !('x.private' in r.c)), JSON.stringify(r && { private: r.flags.private, x: r.c['x.private'] }))
      await context.close()
    }
    if (where !== browser) await where.close()
  }
  if (engineName === 'chromium') notes.push('(h) not applicable: Blink gives no private-window answer, so flags.private is null in both modes')

  // (j) Firefox lowers font visibility in private browsing (its fingerprinting protection, on there by default), so that is where it
  // warns. It warns once per content process and generic family, against whichever document asks first, so which of the library's
  // pages carries a warning is a race. The control is therefore a private launch of its own in which no page ever loads the library:
  // every font it is warned about, from any document, is the set the library's fonts must fall in. A font warned about only with
  // the library still fails the row.
  if (engineName === 'firefox') {
    const fonts = ignored.map((i) => i.font)
    const { fonts: control, contexts } = await controlFonts(fonts)
    const only = fontsNotInControl(fonts, control)
    check('(j) every font-visibility warning skipped on a library page names a font a private launch that never loads the library is warned about too', !only.length, `only with the library: ${only.join(', ')}; without it: ${control.join(', ') || 'none'}`)
    notes.push(`ignored ${ignored.length} Firefox font-visibility warnings (${[...new Set(fonts)].join(', ') || 'none'}) on ${[...new Set(ignored.map((i) => i.path))].join(', ') || 'no page'}; a private launch without the library, ${contexts} contexts: ${control.join(', ') || 'none'}`)
  }

  check("nothing written to the console beyond Firefox's font-visibility warnings, and no page error", !errors.length, errors.slice(0, 5).join(' | '))
} catch (error) {
  stopped = error
} finally {
  await browser.close()
  server.close()
}

for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : '  <- ' + c.detail}`)
for (const note of notes) console.log(`note ${note}`)
if (stopped) stopOnPageLoad(stopped)
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${engineName} ${browser.version()}: ${checks.length - failed} of ${checks.length} deferred-build checks pass`)
mkdirSync(new URL('./report/raw/', import.meta.url), { recursive: true })
writeFileSync(new URL(`./report/raw/defer-${engineName}.json`, import.meta.url), JSON.stringify({ engine: engineName, version: browser.version(), platform: process.platform, checks, notes }, null, 1))
process.exit(failed ? 1 : 0)
