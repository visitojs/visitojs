// Breaks one browser API at a time, before the library loads or right after it, and checks that nothing escapes. With the
// lab build it also checks what each rendering row must report: which status, which check, value or noise.
// Usage: node lab/fault-matrix.mjs [chromium|firefox|webkit] [--gpu | --private]   (the options are in lab/launch.mjs)
//        BUNDLE=dist/visito.defer.min.js node lab/fault-matrix.mjs ...   the deferred build, started by the page
// BUNDLE=dist/deep.min.js runs the deep entry instead, on a page of its own: every row must give no page error and exactly one
// callback per get() call, after it returned, and a well-formed reading; rendering rows must give the outcome stated for the deep entry.
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { readingProblems, rowState } from './fault-rows.mjs'
import { launchFrom, loadPage } from './launch.mjs'
import { problems } from './schema.mjs'
import { deepProblems } from './deep-schema.mjs'

const engineName = process.argv[2] || 'chromium'
const launch = launchFrom(engineName, process.argv)
// BUNDLE points the harness at another build: the lab build, or a broken one to prove the harness fails on it
const DEEP = /deep/.test(process.env.BUNDLE || '')
const LAB = !DEEP && /lab/.test(process.env.BUNDLE || '')
// the deferred build (dist/visito.defer.min.js): the page starts it, and the rows below add faults installed between load and start()
const DEFER = /defer/.test(process.env.BUNDLE || '')
// the lab build's automation mark candidates, as src/botlab.ts records them
const BOT_KEYS = ['own-value', 'frame-window', 'frame-srcdoc', 'no-webdriver', 'app-version', 'plain-getter', 'plugins-type', 'ua-version', 'no-platform-hint', 'runtime-constructible'].map((mark) => 'x.bot.' + mark)
const bundle = readFileSync(process.env.BUNDLE || new URL('../dist/visito.min.js', import.meta.url))
const SETTLE_MS = 5000
const ENGINE = { chromium: 'blink', firefox: 'gecko', webkit: 'webkit' }
// what a fault in a built-in the library never calls must not move: did is new in every context, ms and t are timings,
// and the values of c that differ between two fresh contexts with no fault are left out
const SAME = ['id', 'idStrict', 'model', 'os', 'osVer', 'app', 'appVer', 'engineVer', 'flags']
const perSession = new Set()
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]'
// a user agent that hides the model, as Chrome on Android sends it
const REDUCED_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'

// The page calls both entry points while the fault is active, then lifts the fault so the harness can read the result.
// A late fault is installed between the library and the page's calls: after stage A, before the document has parsed and stage B runs.
// A build with start() is started right after it loads (the product build has none, so that line does nothing there); a fault "between
// load and start()" is installed just before that call, and a row can replace the call itself. The page compiles that replacement
// from its source, so it is the page's own code: WebKit hides the message of an error thrown by a function the init script defined.
const PAGE = `<!doctype html><meta charset="utf-8"><title>fault</title>
<script src="/visito.min.js"></script>
<script>window.__between && window.__between()</script>
<script>try { if (Visito.start) window.__start ? Function(window.__start)() : Visito.start() } catch (e) { window.__threw = 'start: ' + e }</script>
<script>window.__late && window.__late()</script>
<script>
(function () {
  try { window.__sync = [Visito.getSync()] } catch (e) { window.__threw = 'getSync: ' + e }
  try { Visito.get(function (r) { var got = window.__got = window.__got || []; got[got.length] = r; window.__restore(); console.log('VISITO_DONE') }) } catch (e) { window.__threw = 'get: ' + e }
})()
</script>`

// The deep page calls get() twice, each time noting whether the callback came before that call returned. Late faults go in after
// both calls, so they hit the reads that start only once the page has loaded and is idle.
const DEEP_PAGE = `<!doctype html><meta charset="utf-8"><title>fault</title>
<script src="/visito.min.js"></script>
<script>
(function () {
  var got = window.__got = []
  var answer = function (which, r, early) { got[got.length] = { which: which, early: early, reading: r }; if (got.length === 2) { window.__restore(); console.log('VISITO_DONE') } }
  try {
    var first = false, second = false
    VisitoDeep.get(function (r) { answer(1, r, !first) })
    first = true
    VisitoDeep.get(function (r) { answer(2, r, !second) })
    second = true
  } catch (e) { window.__threw = 'get: ' + e }
})()
</script>
<script>window.__late && window.__late()</script>`

const THROW = 'function () { throw new Error("fault") }'
const GARBAGE = '{ toString: ' + THROW + ', valueOf: ' + THROW + ' }'
const getter = { missing: 'get: function () {}', throws: 'get: ' + THROW, garbage: 'get: function () { return ' + GARBAGE + ' }' }
const method = { missing: 'value: undefined', throws: 'value: ' + THROW, garbage: 'value: function () { return ' + GARBAGE + ' }' }

// APIs a browser build is known to lack, with the reason. A fault whose target does not resolve anywhere else is a harness
// error and fails its row: a mistyped or renamed target must not pass as "not applicable".
const KNOWN_ABSENT = [
  { engine: 'webkit', platform: 'win32', target: 'OfflineAudioContext.prototype', reason: "Playwright's Windows WebKit build has no Web Audio: no OfflineAudioContext" },
  { engine: 'webkit', platform: 'win32', target: 'AudioBuffer.prototype', reason: "Playwright's Windows WebKit build has no Web Audio: no AudioBuffer" },
]
const absentHere = (target) => KNOWN_ABSENT.find((a) => a.engine === engineName && a.platform === process.platform && a.target === target)

// What the engine detection must report in each browser here, as the reading shows it: the engine, the Android build, and whether
// memory, screen and cores are excluded ('!ex'). Firefox 155 is at the Firefox 143 level and WebKit 26.6 at the Safari 17 level.
const EXPECTED = {
  chromium: { engine: 'blink', android: false, mem: false, scr: false, cores: false },
  firefox: { engine: 'gecko', android: false, mem: false, scr: true, cores: true },
  webkit: { engine: 'webkit', android: false, mem: false, scr: true, cores: false },
}
// Faults that change the classification on purpose, each with its reason (docs/DECISIONS.md, "Engine detection"). Anything else that changes it fails,
// and so does a documented outcome that stops happening. A fault that leaves no reading at all (the broken built-ins below) has no classification to check.
const OLDER_FIREFOX = { engines: ['firefox'], changes: { scr: false, cores: false }, reason: 'Firefox 143 has no test outside CSS.supports but its one removal, so a page that breaks CSS.supports reads as an older Firefox' }
const OUTCOMES = {}
for (const name of ['window.CSS missing', 'window.CSS throws', 'window.CSS garbage', 'CSS.supports missing', 'CSS.supports throws', 'CSS.supports garbage', 'CSS.supports truthy', 'CSS.supports answers true to everything']) OUTCOMES[name] = OLDER_FIREFOX

/** The classification as the reading shows it. Screen and cores are id parts only when the user agent names no model. */
function classification(reading) {
  const c = reading.c
  const seen = { engine: c['x.engine'], android: c['x.android'], mem: c['hw.mem'] === '!ex' }
  if ('hw.scr' in c) Object.assign(seen, { scr: c['hw.scr'] === '!ex', cores: c['hw.cores'] === '!ex' })
  return seen
}

// Three baselines: the harness's user agent, the same again in a fresh context to learn which values of c differ between sessions
// anyway, and the browser's own user agent. "The baseline" below is the first; the other two are compared with it or checked on their own.
const faults = [
  { name: 'baseline (no fault)', edits: [] },
  { name: 'baseline again, a fresh context', edits: [], again: true },
  { name: 'baseline, the browser\'s own user agent', edits: [], own: true },
]
// own: the browser's own user agent, which names no model, so the screen and core exclusions show in the id parts
const each = (label, target, prop, kinds, own) => {
  for (const mode of Object.keys(kinds)) faults.push({ name: `${label} ${mode}`, edits: [[target, prop, kinds[mode]]], own })
}
each('navigator.userAgent', 'Navigator.prototype', 'userAgent', getter)
each('navigator.language', 'Navigator.prototype', 'language', getter)
each('navigator.deviceMemory', 'Navigator.prototype', 'deviceMemory', getter)
each('document.cookie', 'Document.prototype', 'cookie', {
  missing: 'get: function () {}, set: function () {}',
  throws: 'get: ' + THROW + ', set: ' + THROW,
  garbage: 'get: function () { return ' + GARBAGE + ' }, set: function () {}',
})
each('window.localStorage', 'window', 'localStorage', getter)
each('Storage.getItem', 'Storage.prototype', 'getItem', method)
each('Storage.setItem', 'Storage.prototype', 'setItem', method)
each('window.Intl', 'window', 'Intl', getter)
each('Intl.DateTimeFormat', 'Intl', 'DateTimeFormat', method)
each('window.crypto', 'window', 'crypto', getter)
each('crypto.getRandomValues', 'Crypto.prototype', 'getRandomValues', method)
each('window.performance', 'window', 'performance', getter)
each('performance.now', 'Performance.prototype', 'now', method)
each('navigator.languages', 'Navigator.prototype', 'languages', getter)
each('navigator.hardwareConcurrency', 'Navigator.prototype', 'hardwareConcurrency', getter)
each('navigator.platform', 'Navigator.prototype', 'platform', getter)
each('navigator.userAgentData', 'Navigator.prototype', 'userAgentData', getter)
each('window.screen', 'window', 'screen', getter)
each('window.matchMedia', 'window', 'matchMedia', method)
each('window.getComputedStyle', 'window', 'getComputedStyle', method)
each('window.requestIdleCallback', 'window', 'requestIdleCallback', method)
each('window.MessageChannel', 'window', 'MessageChannel', method)
faults.push({ name: 'window.MessageChannel never delivers', settle: 33000, edits: [['window', 'MessageChannel', 'value: function () { return { port1: {}, port2: { postMessage: function () {} } } }']] })
// a channel whose port cannot post falls back to a timer; one whose port cannot be closed still delivers (never delivering is the row above)
each('MessagePort.postMessage', 'MessagePort.prototype', 'postMessage', { missing: method.missing, throws: method.throws })
each('MessagePort.close', 'MessagePort.prototype', 'close', method)
// the lab stage's start: an idle callback that never calls back, a visibility answer that is not a boolean, listeners that cannot be removed
faults.push({ name: 'window.requestIdleCallback never calls back', edits: [['window', 'requestIdleCallback', 'value: function () { return 1 }']] })
each('document.hidden', 'Document.prototype', 'hidden', getter)
each('removeEventListener', 'EventTarget.prototype', 'removeEventListener', method)
// the screen as the browser reports it, with the browser's own user agent so the screen is an id part
each('screen.width', 'Screen.prototype', 'width', { ...getter, infinite: 'get: function () { return Infinity }', 'a string': 'get: function () { return "852" }' }, true)
each('screen.height', 'Screen.prototype', 'height', getter, true)
each('style.setProperty', 'CSSStyleDeclaration.prototype', 'setProperty', method)
each('window.sessionStorage', 'window', 'sessionStorage', getter)
// the deep entry waits for an idle moment and a visible page: an idle callback that never comes, and a page that never shows
faults.push({ name: 'window.requestIdleCallback never calls back', deepOnly: true, edits: [['window', 'requestIdleCallback', 'value: function () { return 1 }']] })
faults.push({ name: 'document.hidden stuck at true', deepOnly: true, settle: 33000, edits: [['Document.prototype', 'hidden', 'get: function () { return true }']] })
// the in-memory-session check: its one read, a promise that never settles, and a refusal whose name cannot be read
each('navigator.storage', 'Navigator.prototype', 'storage', getter)
each('storage.getDirectory', 'StorageManager.prototype', 'getDirectory', {
  ...method,
  hangs: 'value: function () { return { then: function () {} } }',
  unnamed: 'value: function () { return Promise.reject({ get name() { throw new Error("fault") } }) }',
})
each('document.createElement', 'Document.prototype', 'createElement', method)
each('document.body', 'Document.prototype', 'body', getter)
each('Element.getBoundingClientRect', 'Element.prototype', 'getBoundingClientRect', method)
each('canvas.getContext', 'HTMLCanvasElement.prototype', 'getContext', method)
// reads of the lab build's automation mark candidates: the plug-in list's length, a list whose traps throw, and window.chrome
each('PluginArray.prototype.length', 'PluginArray.prototype', 'length', getter)
faults.push({ name: 'navigator.plugins is a Proxy whose get and getPrototypeOf traps throw', edits: [['Navigator.prototype', 'plugins', 'get: function () { return new Proxy({}, { get: ' + THROW + ', getPrototypeOf: ' + THROW + ' }) }']] })
each('window.chrome', 'window', 'chrome', getter)
// wraps the real method: `body` sees `real`, `self` and `args`
const wrap = (target, prop, body) => `value: (function (real) { return function () { var self = this, args = arguments; ${body} } })(${target}.${prop})`
// The canvases' language is the lang content attribute, set and read back through Element's own methods. The lang property, which
// a page can replace, is never used, so breaking it changes nothing. A setAttribute or getAttribute that is missing, throws or
// answers garbage, or a setAttribute that writes another language, is caught by the read-back.
for (const [mode, descriptor] of Object.entries({
  ...getter,
  'setter throws': 'get: function () { return "en" }, set: ' + THROW,
  'setter writes another language': 'get: function () { return "en" }, set: function () { this.setAttribute("lang", "ja") }',
})) faults.push({ name: `element.lang ${mode}`, same: true, edits: [['HTMLElement.prototype', 'lang', descriptor]] })
const otherLanguage = wrap('Element.prototype', 'setAttribute', 'return real.call(self, args[0], args[0] === "lang" ? "ja" : args[1])')
each('element.setAttribute', 'Element.prototype', 'setAttribute', { ...method, 'writes another language': otherLanguage })
each('element.getAttribute', 'Element.prototype', 'getAttribute', method)
// what the read-back cannot see: a setAttribute and a getAttribute that lie together. The text is then drawn in the page's language,
// with every check passing (docs/SIGNALS.md, "What no check sees"). Whether that moves the text value depends on the fonts the
// platform has for that language: it did on Windows and did not on the Linux CI machine. So the row asserts a well-formed reading
// with a value and every check ok, and reports whether r.ct moved
faults.push({
  name: 'element.setAttribute writes another language and getAttribute answers "en"',
  reports: 'r.ct',
  edits: [
    ['Element.prototype', 'setAttribute', otherLanguage],
    ['Element.prototype', 'getAttribute', wrap('Element.prototype', 'getAttribute', 'return args[0] === "lang" && self instanceof HTMLCanvasElement ? "en" : real.apply(self, args)')],
  ],
})
// one text value unreadable while the others read (id version 3): the id is withheld and p.txt named as failed, never built from the
// value that would otherwise stand in. On WebKit the system text style alone decides, so a lost line height costs nothing there.
const computed = (fields) => wrap('window', 'getComputedStyle', `var s = real.apply(self, args); return { ${fields} }`)
faults.push({ name: 'getComputedStyle: the line height throws, the font size reads', text: { chromium: ['p.txt'], firefox: ['p.txt'], webkit: [] }, edits: [['window', 'getComputedStyle', computed('get lineHeight() { throw new Error("fault") }, fontSize: s.fontSize')]] })
faults.push({ name: 'getComputedStyle: the font size is empty, the line height reads', text: { chromium: ['p.txt'], firefox: ['p.txt'], webkit: ['p.txt'] }, edits: [['window', 'getComputedStyle', computed('lineHeight: s.lineHeight, fontSize: ""')]] })
// an engine without env() (Chrome before 69, Firefox before 65) drops the scale declaration; on a page with its own line height the
// probe must then read no number, never the page's value, so the id is the one every other site gets
const noEnv = wrap('CSSStyleDeclaration.prototype', 'setProperty', 'if (!window.__lineHeight && document.body) { window.__lineHeight = 1; document.body.style.lineHeight = "1.5" } if (String(args[1]).indexOf("env(") >= 0) return; return real.apply(self, args)')
faults.push({ name: 'no env(): the scale declaration is dropped, on a page whose body has line-height 1.5', values: { 'x.txt.env': '!na' }, sameId: true, edits: [['CSSStyleDeclaration.prototype', 'setProperty', noEnv]] })
const IMAGE = 'CanvasRenderingContext2D.prototype'
each('context.getImageData', IMAGE, 'getImageData', {
  ...method,
  refused: 'value: function () { throw new DOMException("fault", "SecurityError") }',
  'wrong size': 'value: function () { return { data: new Uint8ClampedArray(4) } }',
  'altered every read': wrap(IMAGE, 'getImageData', 'var d = real.apply(self, args); d.data[0] ^= 1; return d'),
  'altered from the second read': wrap(IMAGE, 'getImageData', 'var d = real.apply(self, args); window.__reads = (window.__reads || 0) + 1; if (window.__reads > 1) d.data[5] ^= 2; return d'),
  'altered on the first read only': wrap(IMAGE, 'getImageData', 'var d = real.apply(self, args); if (!window.__readOnce) { window.__readOnce = 1; d.data[0] ^= 1 } return d'),
})

// Alterations shaped like the ones browsers describe, written from those descriptions (docs/DECISIONS.md), run in the page.
// Each is deterministic for the page, so two drawings of a scene get the same change and only the known cells can show it.
/** An offset in -3 to 3 keyed by salt and colour on every pixel unlike one of its eight neighbours, kept within their range. */
function colourKeyed(d, salt, minWidth) {
  if (d.width <= minWidth) return
  var w = d.width, h = d.height, src = new Uint8ClampedArray(d.data), out = d.data
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var at = (y * w + x) * 4, lo = [src[at], src[at + 1], src[at + 2]], hi = lo.slice(), unlike = false
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx, ny = y + dy
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          var n = (ny * w + nx) * 4
          for (var k = 0; k < 4; k++) if (src[n + k] !== src[at + k]) unlike = true
          for (k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], src[n + k]); hi[k] = Math.max(hi[k], src[n + k]) }
        }
      }
      if (!unlike) continue
      var hash = salt
      for (k = 0; k < 4; k++) hash = Math.imul(hash ^ src[at + k], 16777619) >>> 0
      for (k = 0; k < 3; k++) out[at + k] = Math.max(lo[k], Math.min(hi[k], src[at + k] + (hash % 7) - 3))
    }
  }
}
/** `count` pixels (20 to 255 when not given) chosen from a hash of key and contents, one channel XORed with 1 or 2; a canvas of one colour is left alone. */
function contentsKeyed(d, key, minWidth, count) {
  if (d.width <= minWidth) return
  var data = d.data, hash = key, flat = true
  for (var i = 0; i < data.length; i++) {
    hash = Math.imul(hash ^ data[i], 16777619) >>> 0
    if (data[i] !== data[i & 3]) flat = false
  }
  if (flat) return
  var n = count ? count(data.length / 4) : 20 + (hash % 236)
  for (var p = 0; p < n; p++) {
    hash = Math.imul(hash ^ p, 16777619) >>> 0
    data[(hash % (data.length / 4)) * 4 + (hash >>> 8) % 3] ^= 1 + ((hash >>> 16) & 1)
  }
}
/**
 * The second review's alteration: a canvas of `fewest` colours or fewer is left alone; on any other, 20 different pixels chosen
 * from a hash of the session's salt and the contents get one channel XORed with 1 or 2. Two identical drawings get the same change.
 */
function sparseKeyed(d, salt, fewest) {
  var data = d.data, seen = {}, colours = 0, hash = salt
  for (var i = 0; i < data.length && colours <= fewest; i += 4) {
    var colour = data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ',' + data[i + 3]
    if (!seen[colour]) { seen[colour] = 1; colours++ }
  }
  if (colours <= fewest) return
  for (i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0
  var pixels = data.length / 4, chosen = {}, left = 20
  for (var p = 1; left; p++) {
    var h = (hash + p) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
    h = (h ^ (h >>> 16)) >>> 0
    hash = h
    if (chosen[h % pixels]) continue
    chosen[h % pixels] = 1
    left--
    data[(h % pixels) * 4 + ((h >>> 24) % 3)] ^= 1 + ((h >>> 20) & 1)
  }
}
const alter = (call) => wrap(IMAGE, 'getImageData', `var d = real.apply(self, args); (${call}); return d`)
each('context.getImageData', IMAGE, 'getImageData', {
  'colour-keyed offsets on pixels unlike a neighbour': alter(`(${colourKeyed})(d, 3, 0)`),
  'colour-keyed offsets, sparing 16 by 16 reads': alter(`(${colourKeyed})(d, 3, 16)`),
  'alters 20 to 255 pixels keyed by contents, sparing one-colour canvases': alter(`(${contentsKeyed})(d, 17, 0)`),
  'alters one pixel in eight keyed by contents, on reads wider than 16': alter(`(${contentsKeyed})(d, 17, 16, function (pixels) { return pixels >> 3 })`),
})
// three salts each: which pixels are hit, and so which check fires, depends on the salt
const SALTS = [5, 23, 101]
for (const fewest of [16, 256]) {
  for (const salt of SALTS) {
    faults.push({ name: `context.getImageData XORs 20 pixels keyed by contents, sparing canvases of ${fewest} colours or fewer, salt ${salt}`, edits: [[IMAGE, 'getImageData', alter(`(${sparseKeyed})(d, ${salt}, ${fewest})`)]] })
  }
}
// late faults on the rendering reads: they run in the lab stage, long after the library loaded, and must not rely on what it saw then
faults.push({ name: 'context.getImageData throws after start', late: true, edits: [[IMAGE, 'getImageData', method.throws]] })
faults.push({ name: 'window.OfflineAudioContext removed after start', late: true, edits: [['window', 'OfflineAudioContext', method.missing]] })
each('context.fillText', IMAGE, 'fillText', method)
each('context.createLinearGradient', IMAGE, 'createLinearGradient', method)
each('context.drawImage', IMAGE, 'drawImage', method)
each('window.OfflineAudioContext', 'window', 'OfflineAudioContext', getter)
faults.push({ name: 'OfflineAudioContext constructor throws', edits: [['window', 'OfflineAudioContext', method.throws]] })
const OFFLINE = 'OfflineAudioContext.prototype'
each('audio.startRendering', OFFLINE, 'startRendering', {
  ...method,
  hangs: 'value: function () {}',
  rejects: 'value: function () { return Promise.reject(new Error("fault")) }',
  'completes twice': wrap(OFFLINE, 'startRendering', 'var p = real.apply(self, args), h = self.oncomplete; p.then(function (b) { if (h) { h({ renderedBuffer: b }); h({ renderedBuffer: b }) } }); return p'),
  'completes after the time limit': wrap(OFFLINE, 'startRendering', 'setTimeout(function () { real.apply(self, args) }, 1500)'),
})
each('AudioBuffer.getChannelData', 'AudioBuffer.prototype', 'getChannelData', {
  ...method,
  noise: wrap('AudioBuffer.prototype', 'getChannelData', 'var d = new Float32Array(real.apply(self, args)); for (var i = 0; i < d.length; i++) d[i] += 1e-7 * ((i % 5) - 2); return d'),
})
// noise written into the buffer itself, once per buffer and channel, so the copy path returns it too, as a browser that
// alters the samples a page reads would
const inPlace = (change) =>
  wrap('AudioBuffer.prototype', 'getChannelData', `var d = real.apply(self, args), seen = window.__noised = window.__noised || new WeakMap(), done = seen.get(self) || {}; seen.set(self, done); if (!done[args[0]]) { done[args[0]] = 1; for (var i = 0; i < d.length; i++) ${change} } return d`)
each('AudioBuffer.getChannelData', 'AudioBuffer.prototype', 'getChannelData', {
  'adds 1e-9 to every sample, in place': inPlace('d[i] += 1e-9'),
  'scales every sample by 1 + 1e-7, in place': inPlace('d[i] *= 1 + 1e-7'),
})
each('AudioBuffer.copyFromChannel', 'AudioBuffer.prototype', 'copyFromChannel', method)
each('Intl.resolvedOptions', 'Intl.DateTimeFormat.prototype', 'resolvedOptions', method)
// the engine detection: holders it reads through, CSS.supports, the secure-context flag, and pages that add a tested name
each('window.navigator', 'window', 'navigator', getter, true)
each('window.CSS', 'window', 'CSS', getter, true)
each('CSS.supports', 'CSS', 'supports', { ...method, truthy: 'value: function () { return 1 }' }, true)
// a stub that says yes to every condition, the never-valid one included: the conditions count for nothing, as when CSS.supports is broken
faults.push({ name: 'CSS.supports answers true to everything', own: true, edits: [['CSS', 'supports', 'value: function () { return true }']] })
each('window.ShadowRoot', 'window', 'ShadowRoot', { ...getter, primitive: 'value: 1' }, true)
each('window.HTMLMediaElement', 'window', 'HTMLMediaElement', getter, true)
each('window.SVGFEGaussianBlurElement', 'window', 'SVGFEGaussianBlurElement', getter, true)
each('window.HTMLCanvasElement', 'window', 'HTMLCanvasElement', getter, true)
each('window.HTMLInputElement', 'window', 'HTMLInputElement', getter, true)
each('window.Event', 'window', 'Event', getter, true)
each('window.CSSContainerRule', 'window', 'CSSContainerRule', getter, true)
each('window.URL', 'window', 'URL', getter, true)
each('window.RegExp', 'window', 'RegExp', getter, true)
// RegExp.prototype cannot be redefined, so the page replaces RegExp with an object whose prototype throws
faults.push({ name: 'window.RegExp.prototype throws', own: true, edits: [['window', 'RegExp', 'value: { get prototype() { throw new Error("fault") } }']] })
each('window.CompositionEvent', 'window', 'CompositionEvent', getter, true)
each('window.isSecureContext', 'window', 'isSecureContext', { ...getter, insecure: 'get: function () { return false }' }, true)
each('navigator.brave', 'Navigator.prototype', 'brave', getter, true)
faults.push({ name: 'window.performance is a Proxy whose has trap throws', own: true, edits: [['window', 'performance', 'value: new Proxy({}, { has: ' + THROW + ' })']] })
faults.push({ name: 'page globals named like other engines\' features', own: true, edits: [['window', 'GestureEvent', 'value: function () {}'], ['window', 'TimeEvent', 'value: 1']] })
faults.push({ name: 'a page global named like a mobile feature', own: true, edits: [['window', 'onorientationchange', 'value: null, writable: true']] })
faults.push({ name: 'Object.prototype gains a tested name', own: true, edits: [['Object.prototype', 'getSelection', 'value: function () {}, writable: true']] })
each('JSON.parse', 'JSON', 'parse', method)
each('JSON.stringify', 'JSON', 'stringify', method)
// a hostile page: merchants inject their own scripts, some of them rewrite built-ins
for (const [target, prop] of [
  ['String.prototype', 'split'], ['String.prototype', 'replace'], ['String.prototype', 'slice'], ['String.prototype', 'indexOf'],
  ['RegExp.prototype', 'exec'], ['RegExp.prototype', 'test'], ['Array.prototype', 'push'], ['Array.prototype', 'join'],
  ['Array.prototype', 'sort'], ['Object', 'keys'], ['Date', 'now'], ['Math', 'random'], ['Math', 'floor'], ['window', 'parseInt'],
  ['String.prototype', 'charCodeAt'], ['Math', 'sin'], ['Math', 'expm1'], ['Math', 'hypot'],
]) {
  faults.push({ name: `${target}.${prop} throws`, edits: [[target, prop, method.throws]] })
  faults.push({ name: `${target}.${prop} removed`, edits: [[target, prop, method.missing]] })
}
// both hashes loop over charCodeAt: values no string gives must still let them end
faults.push({ name: 'String.prototype.charCodeAt garbage', edits: [['String.prototype', 'charCodeAt', method.garbage]] })
faults.push({ name: 'String.prototype.charCodeAt returns -1', edits: [['String.prototype', 'charCodeAt', 'value: function () { return -1 }']] })
// What the rendering digest calls, broken without throwing. The deep entry's self-test of the digest must see each one; otherwise
// every machine would share one constant deep id, or get a new one on every visit, or a value only this page gives.
const DIGEST_TAMPERS = {
  'String.fromCharCode returns an empty string': [['String', 'fromCharCode', 'value: function () { return "" }']],
  'String.fromCharCode appends randomness': [['String', 'fromCharCode', wrap('String', 'fromCharCode', 'return real.apply(String, args) + Math.random()')]],
  'Function.prototype.apply ignores its arguments': [['Function.prototype', 'apply', 'value: (function (call) { return function (self) { return call.call(this, self) } })(Function.prototype.call)']],
  'Uint8ClampedArray.prototype.subarray truncated': [['Uint8ClampedArray.prototype', 'subarray', wrap('Uint8ClampedArray.prototype', 'subarray', 'return real.call(self, args[0], args[1] - 1)')]],
  'Uint8Array.prototype.subarray truncated': [['Uint8Array.prototype', 'subarray', wrap('Uint8Array.prototype', 'subarray', 'return real.call(self, args[0], args[1] - 1)')]],
  'DataView.prototype.setFloat32 writes nothing': [['DataView.prototype', 'setFloat32', 'value: function () {}']],
}
for (const name of Object.keys(DIGEST_TAMPERS)) faults.push({ name, edits: DIGEST_TAMPERS[name] })
// built-ins the library never calls: breaking one must leave the reading exactly as it is
for (const [target, prop] of [['String.prototype', 'trim']]) {
  faults.push({ name: `${target}.${prop} throws`, same: true, edits: [[target, prop, method.throws]] })
  faults.push({ name: `${target}.${prop} removed`, same: true, edits: [[target, prop, method.missing]] })
  faults.push({ name: `${target}.${prop} garbage`, same: true, edits: [[target, prop, method.garbage]] })
}
faults.push({ name: 'window.JSON replaced', edits: [['window', 'JSON', 'value: {}']] })
faults.push({ name: 'window.Math replaced', edits: [['window', 'Math', 'value: {}']] })
// the replacement above stops the whole library at its start; these pass that guard and reach the Math read itself
faults.push({ name: 'Math.sin, cos and tan return garbage', edits: ['sin', 'cos', 'tan'].map((name) => ['Math', name, method.garbage]) })
faults.push({ name: 'window.setTimeout removed', edits: [['window', 'setTimeout', 'value: undefined']] })
faults.push({ name: 'window.setTimeout throws', edits: [['window', 'setTimeout', method.throws]] })
// a wrapper that still schedules the function before it throws: each fallback must not run the callback again
const scheduleThenThrow = 'value: function (f, ms) { timer.call(window, f, ms); throw new Error("fault") }'
faults.push({ name: 'window.setTimeout schedules, then throws', edits: [['window', 'setTimeout', scheduleThenThrow]] })
faults.push({ name: 'window.Uint8Array removed', edits: [['window', 'Uint8Array', 'value: undefined']] })
faults.push({
  name: 'Object.prototype and Array.prototype polluted',
  edits: [
    ['Object.prototype', 'polluted', 'value: 1, enumerable: true, writable: true'],
    ['Object.prototype', 'did', 'value: "x", enumerable: true, writable: true'],
    ['Array.prototype', 'polluted', 'value: function () {}, enumerable: true, writable: true'],
  ],
})
// every object gains a font shorthand that each own-key check lets through: the text-size probes must declare it before their own
// font properties, which it would otherwise reset, so the reading is the one an intact page gives
faults.push({
  name: 'Object.prototype gains an enumerable font, hasOwnProperty always true',
  sameAs: 'baseline (no fault)',
  edits: [
    ['Object.prototype', 'font', 'value: "10px serif", enumerable: true, writable: true'],
    ['Object.prototype', 'hasOwnProperty', 'value: function () { return true }, writable: true'],
  ],
})
// The faults above are in place before stage A runs; these break what the code after it calls: settling, the task runner, the watchdog,
// the cache save, the callback dispatch and the answers of reads that wait on the browser.
// Not Promise.prototype.then: without it ES5 code cannot handle the promise getDirectory() returns, so WebKit reports its rejection as unhandled.
const late = [
  ['Object', 'keys'], ['Object.prototype', 'hasOwnProperty'], ['Function.prototype', 'call'],
  ['Array.prototype', 'sort'], ['Array.prototype', 'join'], ['Array.prototype', 'push'], ['Array.prototype', 'concat'],
  ['String.prototype', 'replace'], ['String.prototype', 'charAt'], ['String.prototype', 'charCodeAt'], ['String.prototype', 'slice'],
  ['String.prototype', 'indexOf'], ['Number.prototype', 'toString'], ['RegExp.prototype', 'test'], ['Math', 'round'], ['Math', 'floor'],
  ['Date', 'now'], ['JSON', 'stringify'], ['window', 'parseFloat'], ['Storage.prototype', 'setItem'], ['window', 'setTimeout'],
  ['window', 'clearTimeout'], ['window', 'MessageChannel'], ['MessagePort.prototype', 'postMessage'], ['MessagePort.prototype', 'close'], ['Performance.prototype', 'now'], ['StorageManager.prototype', 'getDirectory'],
]
// the second pass hides the model in the user agent, so the client-hints answer and the reduced-user-agent branch of settling run as well
for (const [suffix, userAgent] of [['', USER_AGENT], [', model hidden', REDUCED_USER_AGENT]]) {
  for (const [target, prop] of late) {
    faults.push({ name: `${target}.${prop} throws after start${suffix}`, late: true, userAgent, edits: [[target, prop, method.throws]] })
    faults.push({ name: `${target}.${prop} removed after start${suffix}`, late: true, userAgent, edits: [[target, prop, method.missing]] })
  }
  // both clocks at once: the coarse one is the fallback for the fine one
  for (const mode of ['throws', 'removed']) {
    const descriptor = mode === 'throws' ? method.throws : method.missing
    faults.push({
      name: `performance.now and Date.now ${mode} after start${suffix}`,
      late: true,
      userAgent,
      edits: [['Performance.prototype', 'now', descriptor], ['Date', 'now', descriptor]],
    })
  }
  faults.push({ name: `window.setTimeout schedules, then throws after start${suffix}`, late: true, userAgent, edits: [['window', 'setTimeout', scheduleThenThrow]] })
  // no message channel either: each step must still run once, so the reading is the one the timer fault alone gives
  faults.push({
    name: `window.MessageChannel removed, window.setTimeout schedules, then throws after start${suffix}`,
    late: true,
    userAgent,
    sameAs: `window.setTimeout schedules, then throws after start${suffix}`,
    edits: [['window', 'MessageChannel', method.missing], ['window', 'setTimeout', scheduleThenThrow]],
  })
  // no fine clock, and a coarse one whose answer cannot become a number: the clock still gives a finite number and the reading is complete
  for (const [label, answer] of [['an object whose conversion throws', GARBAGE], ['a Symbol', 'Symbol()'], ['a BigInt', 'BigInt(1)']]) {
    faults.push({
      name: `performance.now removed, Date.now answers ${label} after start${suffix}`,
      late: true,
      userAgent,
      complete: true,
      edits: [['Performance.prototype', 'now', method.missing], ['Date', 'now', `value: function () { return ${answer} }`]],
    })
  }
  // the client-hints answer replaced; engines without client hints get the edit on a throwaway object
  const uaData = 'window.NavigatorUAData ? NavigatorUAData.prototype : {}'
  const brandLists = {
    missing: 'undefined',
    null: 'null',
    'an object that is not a list': '{ 0: { brand: "Chromium" } }',
    'a list of numbers': '[1, 2, 3]',
    'an entry whose brand throws': '[{ get brand() { throw new Error("fault") } }, { brand: "Chromium" }]',
    frozen: 'Object.freeze([Object.freeze({ brand: "Not)A;Brand" }), Object.freeze({ brand: "Chromium" })])',
    '1000 entries': '(function () { var a = []; for (var i = 0; i < 1000; i++) a[i] = { brand: i % 2 ? "Chromium " + i : "Not_A Brand" }; return a })()',
    'an enormous length': '{ length: Infinity, 0: { brand: "Chromium" } }',
  }
  for (const label of Object.keys(brandLists)) {
    faults.push({ name: `client-hint brands: ${label}${suffix}`, userAgent, edits: [[uaData, 'brands', `get: function () { return ${brandLists[label]} }`]] })
  }
  for (const [label, answer] of [['nothing', ''], ['a model that throws', '{ get model() { throw new Error("fault") } }']]) {
    faults.push({
      name: `getHighEntropyValues answers ${label} after start${suffix}`,
      late: true,
      userAgent,
      edits: [[uaData, 'getHighEntropyValues', `value: function () { return Promise.resolve(${answer}) }`]],
    })
  }
}

// What the lab build must report for each rendering row (lab/fault-rows.mjs has the vocabulary). A canvas status covers both
// scenes and both readback variants, since a fired check settles them all; an audio status covers the value and its two diagnostics.
const canvasIs = (status, check = status) => ({ 'r.cg': status, 'r.ct': status, 'r.cchk': check, 'r.cgcpu': status, 'r.ctcpu': status })
const audioIs = (status, check = status) => ({ 'r.audio': status, 'r.achk': check, 'r.arms': status })
const CANVAS_SAME = { 'r.cg': 'same', 'r.ct': 'same', 'r.cchk': 'ok' }
const AUDIO_SAME = { 'r.audio': 'same', 'r.achk': 'ok' }
const NO_AUDIO = absentHere('OfflineAudioContext.prototype')
const EXPECT = {
  'baseline (no fault)': {
    'r.cg': 'value', 'r.ct': 'value', 'r.cchk': 'ok', 'r.cgcpu': 'value', 'r.ctcpu': 'value', 'r.math': 'value',
    ...(NO_AUDIO ? audioIs('!na') : { 'r.audio': 'value', 'r.achk': 'ok' }),
  },
  'document.createElement missing': canvasIs('!err'),
  'document.createElement throws': canvasIs('!err'),
  // an object that is not an element has no getContext: the same answer as a browser without 2D canvas
  'document.createElement garbage': canvasIs('!na'),
  'canvas.getContext missing': canvasIs('!na'),
  'canvas.getContext throws': canvasIs('!err'),
  'canvas.getContext garbage': canvasIs('!err'),
  'context.getImageData missing': canvasIs('!err'),
  'context.getImageData throws': canvasIs('!err'),
  'context.getImageData garbage': canvasIs('!err'),
  'context.getImageData refused': canvasIs('!noise', 'blocked'),
  'context.getImageData wrong size': canvasIs('!err'),
  'context.getImageData altered every read': canvasIs('!noise', 'pattern'),
  'context.getImageData altered from the second read': canvasIs('!noise', 'geometry-patch'),
  'context.getImageData altered on the first read only': canvasIs('!noise', 'pattern'),
  'context.getImageData colour-keyed offsets on pixels unlike a neighbour': canvasIs('!noise', 'pattern'),
  'context.getImageData colour-keyed offsets, sparing 16 by 16 reads': canvasIs('!noise', 'geometry-patch'),
  'context.getImageData alters 20 to 255 pixels keyed by contents, sparing one-colour canvases': canvasIs('!noise', 'pattern'),
  'context.getImageData alters one pixel in eight keyed by contents, on reads wider than 16': canvasIs('!noise', 'geometry-patch'),
  // the pattern holds 256 colours, so a "few colours" threshold of 16 does not spare it; one of 256 spares it, and then the
  // strips or the two drawings, whose strips differ, catch it
  ...Object.fromEntries(SALTS.map((salt) => [`context.getImageData XORs 20 pixels keyed by contents, sparing canvases of 16 colours or fewer, salt ${salt}`, canvasIs('!noise', 'pattern')])),
  ...Object.fromEntries(SALTS.map((salt) => [`context.getImageData XORs 20 pixels keyed by contents, sparing canvases of 256 colours or fewer, salt ${salt}`, canvasIs('!noise', ['geometry-patch', 'geometry'])])),
  'context.getImageData throws after start': canvasIs('!err'),
  'context.fillText missing': canvasIs('!err'),
  'context.fillText throws': canvasIs('!err'),
  // a fillText that draws nothing: the text value moves, the geometry value cannot
  'context.fillText garbage': { ...CANVAS_SAME, 'r.ct': 'changed' },
  'context.createLinearGradient missing': canvasIs('!err'),
  'context.createLinearGradient throws': canvasIs('!err'),
  'context.createLinearGradient garbage': canvasIs('!err'),
  'context.drawImage missing': canvasIs('!err'),
  'context.drawImage throws': canvasIs('!err'),
  'context.drawImage garbage': { ...CANVAS_SAME, 'r.cg': 'changed' },
  'element.setAttribute missing': canvasIs('!err'),
  'element.setAttribute throws': canvasIs('!err'),
  'element.setAttribute garbage': canvasIs('!err'),
  'element.setAttribute writes another language': canvasIs('!err'),
  'element.getAttribute missing': canvasIs('!err'),
  'element.getAttribute throws': canvasIs('!err'),
  'element.getAttribute garbage': canvasIs('!err'),
  // the text is drawn in the language the page wrote; whether r.ct moves depends on the platform's fonts, so it must be a value and
  // the row reports whether it equals the baseline (on Windows it moved in Chromium and Firefox, not in WebKit 26.6)
  'element.setAttribute writes another language and getAttribute answers "en"': { ...CANVAS_SAME, 'r.ct': 'value' },
  'window.OfflineAudioContext missing': audioIs('!na'),
  'window.OfflineAudioContext throws': audioIs('!err'),
  'window.OfflineAudioContext garbage': audioIs('!err'),
  'window.OfflineAudioContext removed after start': audioIs('!na'),
  'OfflineAudioContext constructor throws': audioIs('!err'),
  'audio.startRendering missing': audioIs('!err'),
  'audio.startRendering throws': audioIs('!err'),
  // an answer that is neither a promise nor a started render: only the time limit ends the read
  'audio.startRendering garbage': audioIs('!to'),
  'audio.startRendering hangs': audioIs('!to'),
  'audio.startRendering rejects': audioIs('!err'),
  'audio.startRendering completes twice': AUDIO_SAME,
  'audio.startRendering completes after the time limit': audioIs('!to'),
  'AudioBuffer.getChannelData missing': audioIs('!err'),
  'AudioBuffer.getChannelData throws': audioIs('!err'),
  'AudioBuffer.getChannelData garbage': audioIs('!err'),
  'AudioBuffer.getChannelData noise': audioIs('!noise', 'pattern'),
  'AudioBuffer.getChannelData adds 1e-9 to every sample, in place': audioIs('!noise', 'pattern'),
  'AudioBuffer.getChannelData scales every sample by 1 + 1e-7, in place': audioIs('!noise', 'pattern'),
  'AudioBuffer.copyFromChannel missing': AUDIO_SAME,
  'AudioBuffer.copyFromChannel throws': audioIs('!err'),
  // a copy that copies nothing disagrees with the channel
  'AudioBuffer.copyFromChannel garbage': audioIs('!noise', 'copy'),
  'Math.sin throws': { 'r.math': 'changed' },
  'Math.sin removed': { 'r.math': 'changed' },
  'Math.expm1 throws': { 'r.math': 'changed' },
  'Math.expm1 removed': { 'r.math': 'changed' },
  'Math.hypot throws': { 'r.math': 'changed' },
  'Math.hypot removed': { 'r.math': 'changed' },
  'Math.sin, cos and tan return garbage': { 'r.math': 'changed' },
}
// The automation mark candidates of the lab build (x.bot.*, src/botlab.ts): every read they make, missing, throwing and garbage,
// installed before the scripts load and again after stage A (late), with the browser's own user agent. Each must leave every x.bot.*
// key true, false or "!na", and the reading well formed.
if (LAB) {
  const both = (label, target, prop, kinds) => {
    for (const mode of Object.keys(kinds)) {
      faults.push({ name: `bot: ${label} ${mode}`, own: true, edits: [[target, prop, kinds[mode]]] })
      faults.push({ name: `bot: ${label} ${mode} after load`, own: true, late: true, edits: [[target, prop, kinds[mode]]] })
    }
  }
  both('Object.getOwnPropertyDescriptor', 'Object', 'getOwnPropertyDescriptor', { ...method, 'answers for everything': 'value: function () { return { value: 1, get: function () {} } }' })
  both('Object.getPrototypeOf', 'Object', 'getPrototypeOf', method)
  both('document.createElement', 'Document.prototype', 'createElement', method)
  both('iframe.contentWindow', 'HTMLIFrameElement.prototype', 'contentWindow', getter)
  both('iframe.srcdoc', 'HTMLIFrameElement.prototype', 'srcdoc', { missing: 'get: function () {}, set: function () {}', throws: 'get: ' + THROW + ', set: ' + THROW })
  both('document.createElement', 'Document.prototype', 'createElement', { 'returns a Proxy that throws on every trap': 'value: function () { return new Proxy({}, { get: ' + THROW + ', has: ' + THROW + ', getOwnPropertyDescriptor: ' + THROW + ' }) }' })
  for (const prop of ['webdriver', 'userAgent', 'appVersion', 'plugins', 'platform', 'hardwareConcurrency', 'vendor', 'maxTouchPoints']) both(`navigator.${prop}`, 'Navigator.prototype', prop, getter)
  both('screen.width', 'Screen.prototype', 'width', getter)
  both('window.navigator', 'window', 'navigator', { ...getter, 'a Proxy that throws on every trap': 'value: new Proxy({}, { get: ' + THROW + ', has: ' + THROW + ', getOwnPropertyDescriptor: ' + THROW + ', getPrototypeOf: ' + THROW + ' })' })
  both('window.screen', 'window', 'screen', getter)
  for (const name of ['Navigator', 'Screen', 'PluginArray', 'Plugin']) both(`window.${name}`, 'window', name, getter)
  both('CSS.supports', 'CSS', 'supports', { ...method, 'answers true to everything': 'value: function () { return true }' })
  both('window.CSS', 'window', 'CSS', getter)
  both('Array.prototype.push', 'Array.prototype', 'push', { throws: method.throws, missing: method.missing })
  both('window.chrome', 'window', 'chrome', { ...getter, 'with a runtime.sendMessage that throws on every read': 'value: { runtime: new Proxy({}, { get: ' + THROW + ' }) }' })
  both('String.prototype.indexOf', 'String.prototype', 'indexOf', method)
}
// the classification each candidate row must keep: the core's own reads are untouched by most, and the CSS rows are documented above
for (const name of ['bot: CSS.supports missing', 'bot: CSS.supports throws', 'bot: CSS.supports garbage', 'bot: CSS.supports answers true to everything', 'bot: window.CSS missing', 'bot: window.CSS throws', 'bot: window.CSS garbage']) OUTCOMES[name] = OLDER_FIREFOX
// the core reads every feature test through indexOf: broken before it runs, no engine is established and nothing is excluded
const NO_ENGINE = { engines: ['chromium', 'firefox', 'webkit'], changes: { engine: 'other', scr: false, cores: false }, reason: 'the engine detection reads each feature test through String.prototype.indexOf, so with it broken no engine is established and nothing is excluded' }
for (const mode of ['missing', 'throws', 'garbage']) OUTCOMES[`bot: String.prototype.indexOf ${mode}`] = NO_ENGINE
// The deep entry's outcome for a row: the lab outcome for its five keys, where the lab outcome names any; the flag lists and the
// id then follow from c, which deepProblems() checks on every row. Rows where the deep entry differs from the lab build say why.
const DEEP_KEYS = ['r.cg', 'r.ct', 'r.cchk', 'r.audio', 'r.achk']
const ALL_TO = { 'r.cg': '!to', 'r.ct': '!to', 'r.cchk': '!to', 'r.audio': '!to', 'r.achk': '!to' }
const DEEP_EXPECT = {
  // the steps run one per message: none is delivered, so only the watchdog answers, with nothing read
  'window.MessageChannel never delivers': ALL_TO,
  // nothing runs while the page is hidden; the watchdog answers at 30 s
  'document.hidden stuck at true': ALL_TO,
  'window.requestIdleCallback never calls back': { 'r.cg': 'same', 'r.ct': 'same', 'r.cchk': 'ok', 'r.audio': 'same', 'r.achk': 'ok' },
  // the checks pass on what was drawn and rendered; the digest fails its self-test, so no part is a value and x.id says why
  ...Object.fromEntries(Object.keys(DIGEST_TAMPERS).map((name) => [name, { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': 'ok', 'r.audio': NO_AUDIO ? '!na' : '!err', 'r.achk': NO_AUDIO ? '!na' : 'ok', 'x.id': '!err' }])),
}
// The deep entry draws no text and gives no canvas a language, so a fault in text drawing or in the lang attribute leaves its
// reading as an untouched page's, in every engine
const TEXT_ONLY = [
  'context.fillText missing', 'context.fillText throws', 'context.fillText garbage',
  'element.setAttribute missing', 'element.setAttribute throws', 'element.setAttribute garbage', 'element.setAttribute writes another language',
  'element.getAttribute missing', 'element.getAttribute throws', 'element.getAttribute garbage',
  'element.setAttribute writes another language and getAttribute answers "en"',
]
const UNTOUCHED = { 'r.cg': 'same', 'r.ct': '!ex', 'r.cchk': 'ok' }
const deepExpect = (name) => {
  if (TEXT_ONLY.indexOf(name) >= 0) return UNTOUCHED
  let out = DEEP_EXPECT[name]
  if (!out) {
    const lab = EXPECT[name]
    if (!lab) return null
    out = {}
    for (const key of DEEP_KEYS) if (key in lab) out[key] = lab[key]
    if (!Object.keys(out).length) return null
  }
  // the deep entry never reads the text scene: r.ct is "!ex" whatever the lab build gives for it
  return 'r.ct' in out ? { ...out, 'r.ct': '!ex' } : out
}
// WebKit is excluded whole: every row that leaves a reading must show it so, and nothing is read
const EXCLUDED_ALL = { 'r.cg': '!ex', 'r.ct': '!ex', 'r.cchk': '!ex', 'r.audio': '!ex', 'r.achk': '!ex', 'x.rule': 'webkit' }
const DEEP_RULE = { chromium: '', firefox: '', webkit: 'webkit' }
// the rules that leave out every part, so that nothing is read
const WHOLE = ['webkit', 'android', 'brave', 'other']
// a page that broke what the engine detection splits and searches with: no engine can be named, so the rule 'other' excludes everything
const DEEP_NO_ENGINE = ['String.prototype.split throws', 'String.prototype.split removed', 'String.prototype.indexOf throws', 'String.prototype.indexOf removed']
const ruleFor = (name) => (DEEP_NO_ENGINE.indexOf(name) >= 0 ? 'other' : DEEP_RULE[engineName])
for (const name of Object.keys(EXPECT)) {
  const fault = faults.find((f) => f.name === name)
  // a renamed row must not leave its expectation silently unused
  if (!fault) throw new Error(`EXPECT names a row that does not exist: ${name}`)
  fault.expect = EXPECT[name]
}

// The deferred build: every fault that is in place before the script loads is installed again between load and start(), when
// stage A has not yet run; and three rows that only a page calling start() can have.
if (DEFER) {
  for (const fault of faults.slice()) {
    if (fault.late || fault.settle || !fault.edits.length || fault.expect) continue
    faults.push({ ...fault, name: `${fault.name}, between load and start()`, of: fault.name, between: true })
  }
  faults.push({ name: 'start() options whose store getter throws', bare: true, start: 'Visito.start({ get store() { throw new Error("fault") } })', edits: [] })
  faults.push({ name: 'Object.prototype.store is false, start({})', bare: true, start: 'Visito.start({})', edits: [['Object.prototype', 'store', 'value: false, enumerable: true, writable: true']] })
  faults.push({
    name: 'start() called from a click handler that then throws',
    stores: true,
    pageThrows: 'thrown by the handler of the page',
    start: 'var b = document.createElement("button"); b.onclick = function () { Visito.start(); throw new Error("thrown by the handler of the page") }; b.click()',
    edits: [],
  })
}
// Runs before any page script: records errors with untouched built-ins, applies the edits (or, when late, leaves them for the page to apply), exposes the undo.
function initScript(edits, settle, late, between, start) {
  const apply = edits
    .map(
      ([target, prop, descriptor]) => `
    (function () {
      var target; try { target = ${target} } catch (e) { target = null }
      // an API this browser lacks cannot be broken: recorded, and the row fails unless KNOWN_ABSENT names it
      if (!target) { missing[missing.length] = ${JSON.stringify(target)}; return }
      var saved = Object.getOwnPropertyDescriptor(target, ${JSON.stringify(prop)});
      undo[undo.length] = function () { if (saved) define(target, ${JSON.stringify(prop)}, saved); else delete target[${JSON.stringify(prop)}] };
      define(target, ${JSON.stringify(prop)}, { configurable: true, ${descriptor} });
    })();`,
    )
    .join('')
  return `(function () {
    var define = Object.defineProperty, timer = window.setTimeout, undo = [], errors = [], missing = [];
    window.__errors = errors;
    window.__missing = missing;
    window.addEventListener('error', function (e) { errors[errors.length] = 'error: ' + e.message });
    window.addEventListener('unhandledrejection', function (e) { errors[errors.length] = 'rejection: ' + e.reason });
    window.__restore = function () { for (var i = undo.length - 1; i >= 0; i--) undo[i](); undo.length = 0 };
    timer.call(window, function () { window.__restore(); console.log('VISITO_DONE') }, ${settle - 1000});
    ${start ? `window.__start = ${JSON.stringify(start)};` : ''}
    ${late ? `window.__late = function () { ${apply} };` : between ? `window.__between = function () { ${apply} };` : apply}
  })()`
}

/** For a row that reports a key rather than asserting it: whether that key moved from the baseline on this run, or '' when it holds no value. */
function reportFor(fault, reading, base) {
  const key = fault.reports
  if (!key || !reading || !reading.c || !/^[0-9a-f]{16}$/.test(reading.c[key] || '')) return ''
  return reading.c[key] !== (base && base.c ? base.c[key] : undefined)
    ? `${key}: the text value changed: this platform shows the blind spot`
    : `${key}: the text value did not change on this platform's fonts`
}

let deepBaseline = null
/** One row of the deep run: each call answered once and after it returned, the same reading for both, well formed, and the stated outcome. */
function judgeDeep(fault, seen, failures) {
  const got = Array.isArray(seen.got) ? seen.got : []
  for (const which of [1, 2]) {
    const calls = got.filter((g) => g.which === which)
    if (calls.length !== 1) failures.push(`get() call ${which} was answered ${calls.length} times`)
    if (calls.some((g) => g.early)) failures.push(`get() call ${which} was answered before it returned`)
  }
  const reading = got.length ? got[0].reading : undefined
  if (got.length === 2 && JSON.stringify(got[0].reading) !== JSON.stringify(got[1].reading)) failures.push('the two calls got different readings')
  if (reading) failures.push(...deepProblems(reading).map((p) => `schema: ${p}`))
  if (reading && reading.c['x.rule'] !== ruleFor(fault.name)) failures.push(`x.rule is ${JSON.stringify(reading.c['x.rule'])}, expected ${JSON.stringify(ruleFor(fault.name))}`)
  const baseline = !fault.edits.length && !fault.own && !fault.again
  if (baseline) {
    deepBaseline = reading || null
    if (engineName !== 'webkit' && !(reading && reading.id)) failures.push('baseline has no deep id')
  }
  if (fault.again && reading && deepBaseline && reading.id !== deepBaseline.id) failures.push('a fresh context gave another deep id')
  if (fault.same && !(reading && deepBaseline && reading.id === deepBaseline.id && JSON.stringify(reading.c) === JSON.stringify(deepBaseline.c))) failures.push('differs from the baseline')
  const { state, unknown } = rowState(fault.edits.map((edit) => edit[0]), seen.missing || [], absentHere)
  for (const target of unknown) failures.push(`target ${target} does not resolve in this browser and is not a known absence`)
  const reason = (seen.missing || []).filter(absentHere).map((t) => `${t}: ${absentHere(t).reason}`).join('; ')
  const absent = state === 'absent' && !unknown.length ? reason : null
  const partly = state === 'partial' && !unknown.length ? reason : null
  const expect = WHOLE.indexOf(ruleFor(fault.name)) >= 0 ? (reading === null ? null : { ...EXCLUDED_ALL, 'x.rule': ruleFor(fault.name) }) : deepExpect(fault.name)
  const judged = !!(expect && state === 'applied')
  if (judged) failures.push(...readingProblems(expect, reading, deepBaseline).map((p) => `outcome: ${p}`))
  const rendering = reading ? `r.cchk=${reading.c['r.cchk']} r.achk=${reading.c['r.achk']} noise=[${reading.flags.noise}]` : ''
  const observed = judged ? reportFor(fault, reading, deepBaseline) : ''
  return { fault: fault.name, ok: !failures.length, absent, partly, judged, failures, rendering, observed, classification: null, reading: reading ? { id: !!reading.id, did: false, partial: reading.flags.partial } : null }
}

const server = http.createServer((request, response) => {
  if (request.url === '/visito.min.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end(DEEP ? DEEP_PAGE : PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await playwright[engineName].launch(launch.options)
const rows = []
let baseline = null
// readings by fault, for a fault whose outcome is the one another fault gives
const seenBy = {}
/**
 * A reading without what differs between two page views of one browser: the stored id, the timings, the lab build's rendering
 * values, which Firefox varies per page view, and the values the two fresh baselines disagreed on.
 */
const comparable = (r) => {
  if (!r) return r
  const c = {}
  for (const key of Object.keys(r.c)) if (!key.startsWith('r.') && !perSession.has(key)) c[key] = r.c[key]
  return JSON.stringify({ ...r, c, did: null, didNew: null, ms: null, t: null })
}
try {
  for (const fault of faults) {
    if (fault.deepOnly && !DEEP) continue
    const context = await browser.newContext(fault.own ? {} : { userAgent: fault.userAgent || USER_AGENT })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    const settle = fault.settle || SETTLE_MS
    await page.addInitScript(initScript(fault.edits, settle, fault.late, fault.between, fault.start))
    const failures = []
    try {
      // the page lifts the fault and says so; the harness never runs code in the page while the fault is active
      const finished = new Promise((resolve) => page.on('console', (message) => message.text() === 'VISITO_DONE' && resolve()))
      await loadPage(page, url, { waitUntil: 'load' })
      await Promise.race([finished, page.waitForTimeout(settle)])
      // a page stuck in a loop never answers, and evaluate has no time limit of its own
      let frozen
      const seen = await Promise.race([
        page.evaluate(() => ({ sync: window.__sync, got: window.__got, threw: window.__threw, errors: window.__errors, missing: window.__missing })),
        new Promise((resolve, reject) => { frozen = setTimeout(() => reject(new Error('the page stopped responding')), 5000) }),
      ]).finally(() => clearTimeout(frozen))
      if (seen.threw) failures.push(`threw ${seen.threw}`)
      // a row whose page throws on purpose names the message it expects; it must be seen, and nothing else may be
      const thrown = [...(seen.errors || []), ...pageErrors]
      for (const error of thrown) if (!(fault.pageThrows && error.indexOf(fault.pageThrows) >= 0)) failures.push(error)
      if (fault.pageThrows && !thrown.some((error) => error.indexOf(fault.pageThrows) >= 0)) failures.push(`the page's own error "${fault.pageThrows}" was not reported`)
      if (DEEP) {
        rows.push(judgeDeep(fault, seen, failures))
        await context.close()
        continue
      }
      if (!Array.isArray(seen.sync)) failures.push('getSync was never reached')
      else failures.push(...problems(seen.sync[0]).map((p) => `schema: ${p}`))
      if (!Array.isArray(seen.got)) failures.push('get() never called back')
      else if (seen.got.length !== 1) failures.push(`get() called back ${seen.got.length} times`)
      else if (JSON.stringify(seen.got[0]) !== JSON.stringify(seen.sync && seen.sync[0])) failures.push('get() and getSync() disagree')
      const reading = seen.sync && seen.sync[0]
      // the lab build's candidates: every key present and true, false or "!na" under every fault, unless the lab stage never ran; on the browser's own user agent in
      // Chromium, with nothing broken, none is true (Playwright's Chromium is driven, so this shows only that the page itself plants nothing)
      if (LAB && reading && reading.c) {
        // or '!to' with the key in flags.partial: the lab stage itself never ran (a fault that stops its timer or its message channel)
        const bad = BOT_KEYS.filter((key) => !(reading.c[key] === true || reading.c[key] === false || reading.c[key] === '!na' || (reading.c[key] === '!to' && reading.flags.partial.indexOf(key) >= 0)))
        if (bad.length) failures.push(`x.bot.* not true, false or "!na": ${bad.map((key) => key + '=' + JSON.stringify(reading.c[key])).join(', ')}`)
        else if (fault.own && !fault.edits.length && engineName === 'chromium' && BOT_KEYS.some((key) => reading.c[key] === true)) failures.push(`baseline candidates: ${BOT_KEYS.filter((key) => reading.c[key] === true).join(', ')}`)
      }
      // both baselines with the harness's user agent must be complete; the own-user-agent one names no model
      if (!fault.edits.length && !fault.start && !fault.own && !(reading && reading.id && reading.did && reading.idStrict && reading.model === 'SM-X135FU' && 'x.txt.w' in reading.c && (!LAB || 'r.audio' in reading.c))) failures.push('baseline has no complete reading')
      if (fault.own && !(reading && 'hw.scr' in reading.c)) failures.push('no screen part: the exclusions cannot be checked')
      // the engine comes from features, so the Android user agent of this harness must not change it
      if (!fault.edits.length && !fault.start && reading && reading.c['x.engine'] !== ENGINE[engineName]) failures.push(`baseline engine ${reading.c['x.engine']}, expected ${ENGINE[engineName]}`)
      // every fault: the classification is the one promised, or the documented outcome for this fault, and nothing else
      const shown = reading && reading.c ? classification(reading) : null
      if (shown) {
        const seen = shown
        const named = OUTCOMES[fault.of || fault.name]
        const outcome = named && named.engines.includes(engineName) ? named : null
        const want = { ...EXPECTED[engineName], ...(outcome ? outcome.changes : {}) }
        for (const key of Object.keys(seen)) if (seen[key] !== want[key]) failures.push(`classification ${key}=${seen[key]}, expected ${want[key]}${outcome ? ' (documented: ' + outcome.reason + ')' : ''}`)
        // a documented outcome that no longer happens is a stale document
        if (outcome && Object.keys(outcome.changes).some((key) => key in seen && seen[key] !== EXPECTED[engineName][key]) === false) failures.push('documented outcome did not happen')
      }
      // the outcome a fault must give: a complete reading, or the reading of the fault it adds to
      if (fault.complete && !(reading && reading.id && reading.idStrict && !reading.flags.partial.length)) failures.push(`expected a complete reading, got id=${reading && reading.id} partial=[${reading && reading.flags.partial}]`)
      if (fault.text) {
        const want = fault.text[engineName] || []
        const got = reading ? reading.flags.partial.filter((key) => key.startsWith('p.') || key.startsWith('hw.')) : null
        if (!reading || JSON.stringify(got) !== JSON.stringify(want) || (want.length ? reading.id !== null : !reading.id)) failures.push(`expected failed id parts [${want}], got [${got}] with id=${reading && reading.id}`)
      }
      if (fault.values) for (const key of Object.keys(fault.values)) if (!reading || reading.c[key] !== fault.values[key]) failures.push(`expected ${key}=${fault.values[key]}, got ${reading && reading.c[key]}`)
      if (fault.sameId && !(reading && baseline && reading.id && reading.id === baseline.id)) failures.push(`expected the baseline's id, got ${reading && reading.id}`)
      if (fault.sameAs && comparable(reading) !== comparable(seenBy[fault.sameAs])) failures.push(`expected the reading of "${fault.sameAs}": ${comparable(reading)} vs ${comparable(seenBy[fault.sameAs])}`)
      seenBy[fault.name] = reading
      // the baseline is the first one: the harness's user agent, in the first context
      if (!fault.edits.length && !fault.start && !fault.own && !fault.again) baseline = reading
      // started with options that store nothing: no stored id, no private-window answer, no cookie, and the ids of the baseline
      if (fault.bare) {
        const cookies = await context.cookies()
        if (!reading || reading.did !== null || 'x.private' in reading.c || reading.flags.private !== null) failures.push(`stored mode: did=${reading && reading.did} private=${reading && reading.flags.private}`)
        if (cookies.length) failures.push(`cookies stored: ${cookies.map((c) => c.name)}`)
        if (!reading || !baseline || reading.id !== baseline.id || reading.idStrict !== baseline.idStrict) failures.push('ids differ from the baseline')
      }
      if (fault.stores && !(reading && reading.did && reading.id === (baseline && baseline.id))) failures.push(`expected the stored mode with the baseline's id, got did=${reading && reading.did}`)
      if (fault.again && reading && baseline) for (const key of Object.keys(baseline.c)) if (reading.c[key] !== baseline.c[key]) perSession.add(key)
      if (fault.same) {
        const moved = !reading || !baseline ? ['the whole reading'] : SAME.filter((key) => JSON.stringify(reading[key]) !== JSON.stringify(baseline[key]))
        if (reading && baseline)
          for (const key of new Set([...Object.keys(reading.c), ...Object.keys(baseline.c)])) if (!perSession.has(key) && reading.c[key] !== baseline.c[key]) moved.push(`c.${key}`)
        if (moved.length) failures.push(`differs from the baseline: ${moved.join(', ')}`)
      }
      const missing = seen.missing || []
      const { state, unknown } = rowState(fault.edits.map((edit) => edit[0]), missing, absentHere)
      for (const target of unknown) failures.push(`target ${target} does not resolve in this browser and is not a known absence`)
      // not applicable only when every target it needed is a known absence here; partly applied when only some were
      const reason = missing.filter(absentHere).map((t) => `${t}: ${absentHere(t).reason}`).join('; ')
      const absent = state === 'absent' && !unknown.length ? reason : null
      const partly = state === 'partial' && !unknown.length ? reason : null
      // what the lab build reports is judged only where the whole fault happened; a row with no reading has not met its outcome
      if (LAB && fault.expect && state === 'applied') {
        failures.push(...readingProblems(fault.expect, reading, baseline).map((p) => `outcome: ${p}`))
      }
      const rendering = reading && LAB ? ['r.cchk', 'r.achk'].filter((k) => k in reading.c).map((k) => `${k}=${reading.c[k]}`).join(' ') : ''
      const observed = LAB && fault.expect && state === 'applied' ? reportFor(fault, reading, baseline) : ''
      rows.push({ fault: fault.name, ok: !failures.length, absent, partly, judged: !!(LAB && fault.expect && state === 'applied'), failures, rendering, observed, classification: shown, reading: reading ? { id: !!reading.id, did: !!reading.did, partial: reading.flags.partial } : null })
    } catch (error) {
      rows.push({ fault: fault.name, ok: false, failures: [`harness: ${error.message.split('\n')[0]}`], reading: null })
    }
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}

const failed = rows.filter((row) => !row.ok)
const absent = rows.filter((row) => row.absent && row.ok)
const partly = rows.filter((row) => row.partly && row.ok)
// only rows whose whole fault happened count as handled
const applicable = rows.length - absent.length - partly.length
const judged = rows.filter((row) => row.judged)
for (const row of rows) {
  const k = row.classification
  const engine = k ? ` ${k.engine}${k.android ? ' android' : ''}${['mem', 'scr', 'cores'].filter((key) => k[key]).map((key) => ' !' + key).join('')}` : ''
  const state = row.reading ? `id=${row.reading.id ? 'yes' : 'no '}${DEEP ? '' : ` did=${row.reading.did ? 'yes' : 'no '}`} partial=[${row.reading.partial}]${engine}` : 'silent (null)'
  const note = row.absent ? `  (not applicable: ${row.absent})` : row.partly ? `  (partly applied, not counted: ${row.partly})` : ''
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.fault.padEnd(72)} ${state}${row.rendering ? ' ' + row.rendering : ''}${row.ok ? '' : '  <- ' + row.failures.join(' | ')}${note}`)
}
for (const row of rows) if (row.observed) console.log(`note ${row.fault}: ${row.observed}`)
if (process.argv.includes('--show')) console.log('\nbaseline reading:\n' + JSON.stringify(baseline, null, 1))
if (perSession.size) console.log(`\ndiffer between two fresh contexts, left out of the same-reading rows: ${[...perSession].join(', ')}`)
const extra = [
  absent.length ? `${absent.length} not applicable, on the known-absence list` : '',
  partly.length ? `${partly.length} partly applied, not counted` : '',
  LAB || DEEP ? `${judged.filter((row) => row.ok).length} of ${judged.length} rendering outcomes as expected` : '',
].filter(Boolean)
console.log(`\n${engineName} ${browser.version()} (${process.platform})${launch.label}, ${DEEP ? 'deep entry' : LAB ? 'lab build' : DEFER ? 'deferred build' : 'product build'}: ${applicable - failed.length} of ${applicable} applicable faults handled${extra.length ? '; ' + extra.join('; ') : ''}`)
writeFileSync(new URL(`./report/raw/fault-${engineName}${launch.suffix}${DEEP ? '-deep' : LAB ? '-lab' : DEFER ? '-defer' : ''}.json`, import.meta.url), JSON.stringify({ engine: engineName, version: browser.version(), platform: process.platform, gpu: launch.gpu, private: launch.privately, applicable, notApplicable: absent.length, partlyApplied: partly.length, rows }, null, 1))
process.exit(failed.length ? 1 : 0)
