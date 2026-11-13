// Counts every automation mark, the lab build's candidates (x.bot.*, none of which ships) and the core's flags.auto, in real browsers
// started two ways:
//   clean:  the browser started as a person starts it, an ordinary process with a fresh temporary profile and the URL on the command
//           line; no debugging port or pipe, no automation switch. Headed only. The installed Chrome, Edge and Brave, Playwright's builds,
//           and, in Playwright's Chromium builds, the test extensions in lab/marks/extensions, which do what extensions people run do.
//   driven: Playwright, headed and headless, with phone emulation, decoy user agents, locale overrides, a persistent profile, an
//           insecure page, pages under Trusted Types and a strict Content Security Policy, and two value-preserving fixtures.
// Every clean page is loaded twice over: as written, and with an "innocent patches" script first that wraps what host libraries wrap.
// What each mark should show is worked out from the launch, never from the reading (lab/mark-truth.mjs).
// Usage: node lab/marks.mjs clean [chromium|chrome|edge|brave|firefox|webkit]...
//          CHROMIUM=<chrome.exe> runs the chromium contexts on another Chromium build: one rung of the version ladder
//        node lab/marks.mjs driven [chromium|firefox|webkit]...
//        node lab/marks.mjs cost [chromium|chrome|msedge]...   the lab build's lap for all the candidates together, headed, navigated page
//        node lab/marks.mjs --table          prints the per-mark rows and verdicts from lab/report/raw/marks-*.json
// ONLY=<text> runs only the clean contexts whose mode contains it, to try one.
// RUNS=<n> page loads per context and build (3 for the count of record: repeats only test determinism); DIST=<folder> runs other builds.
// The quickest run that covers Playwright's Chromium with every test extension: RUNS=1 node lab/marks.mjs clean chromium, then --table.
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as playwright from 'playwright'
import { PHONE } from './phone.mjs'
import { problems } from './schema.mjs'
import { CANDIDATES, CORE_MARKS, COST_BROWSERS, COST_CONTEXTS, EMBEDDERS, EXTENSIONS, POLICIES, floorOf, inGate, tally, verdict } from './mark-truth.mjs'

const RAW = new URL('./report/raw/', import.meta.url)
const RUNS = Number(process.env.RUNS || 3)
const HOST = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'other'
const WAIT = 20000
const EXTENSION_DIR = fileURLToPath(new URL('./marks/extensions/', import.meta.url))

// ---- the pages ---------------------------------------------------------------------------------------------------------------

// records what reaches the page from its own scripts, and every policy violation, before anything else runs
const PRELUDE = `window.__errors = []; window.__violations = [];
addEventListener('error', function (e) { window.__errors[window.__errors.length] = 'error: ' + e.message });
addEventListener('unhandledrejection', function (e) { window.__errors[window.__errors.length] = 'rejection: ' + e.reason });
document.addEventListener('securitypolicyviolation', function (e) { window.__violations[window.__violations.length] = { directive: e.violatedDirective, source: e.sourceFile, blocked: e.blockedURI, disposition: e.disposition } });`

// Wrappers of the kind host pages carry: framework zones, analytics, error monitors, consent tools, polyfills. Each calls the
// original and returns its answer, as those libraries do. Written here for the harness; none is taken from any library.
const INNOCENT = `(function () {
  var apply = function (real, self, args) { return real.apply(self, args) };
  var fts = Function.prototype.toString;
  Function.prototype.toString = function toString() { return apply(fts, this, arguments) };
  ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask'].forEach(function (name) {
    var real = window[name];
    if (typeof real !== 'function') return;
    window[name] = function (fn) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof fn === 'function') args[0] = function () { return fn.apply(this, arguments) };
      return real.apply(window, args);
    };
  });
  var et = EventTarget.prototype, add = et.addEventListener, remove = et.removeEventListener;
  et.addEventListener = function () { return apply(add, this, arguments) };
  et.removeEventListener = function () { return apply(remove, this, arguments) };
  var realFetch = window.fetch;
  if (realFetch) window.fetch = function () { return apply(realFetch, window, arguments) };
  var xhr = XMLHttpRequest.prototype, open = xhr.open, send = xhr.send;
  xhr.open = function () { return apply(open, this, arguments) };
  xhr.send = function () { return apply(send, this, arguments) };
  var create = Document.prototype.createElement;
  Document.prototype.createElement = function () { return apply(create, this, arguments) };
  var setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function () { return apply(setAttribute, this, arguments) };
  ['pushState', 'replaceState'].forEach(function (name) { var real = History.prototype[name]; History.prototype[name] = function () { return apply(real, this, arguments) } });
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (name) { var real = console[name]; console[name] = function () { return apply(real, console, arguments) } });
  var then = Promise.prototype.then;
  Promise.prototype.then = function (a, b) { return then.call(this, a, b) };
  var gopd = Object.getOwnPropertyDescriptor, define = Object.defineProperty, keys = Object.keys;
  Object.getOwnPropertyDescriptor = function (o, p) { return gopd(o, p) };
  Object.defineProperty = function (o, p, d) { return define(o, p, d) };
  Object.keys = function (o) { return keys(o) };
  // a consent tool's cookie and iframe-src accessors, replaced with ordinary functions that pass through
  var cookie = gopd(Document.prototype, 'cookie');
  define(Document.prototype, 'cookie', { configurable: true, enumerable: true, get: function () { return cookie.get.call(this) }, set: function (v) { cookie.set.call(this, v) } });
  var src = gopd(HTMLIFrameElement.prototype, 'src');
  define(HTMLIFrameElement.prototype, 'src', { configurable: true, enumerable: true, get: function () { return src.get.call(this) }, set: function (v) { src.set.call(this, v) } });
  // polyfills that define only what is missing; the client-hints one fills its brands from the user agent
  if (!('userAgentData' in navigator)) define(Navigator.prototype, 'userAgentData', { configurable: true, get: function () {
    return { brands: [{ brand: 'Polyfill', version: '1' }], mobile: /Mobi/.test(navigator.userAgent), platform: 'Unknown', getHighEntropyValues: function () { return Promise.resolve({}) } };
  } });
  if (!Array.prototype.findLast) Array.prototype.findLast = function (f) { for (var i = this.length - 1; i >= 0; i--) if (f(this[i])) return this[i] };
  // an older library's enumerable additions to built-in prototypes
  Array.prototype.last = function () { return this[this.length - 1] };
  window.onerror = function () { return false };
})();`

// Value-preserving structural states, for the two marks a real engine can show without hiding anything: the value read is the
// browser's own, only where it is defined changes. They run only in driven contexts labelled with their name.
const FIXTURES = {
  'own-value': `Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, enumerable: true, value: navigator.hardwareConcurrency });`,
  'plain-getter': `(function () { var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, enumerable: d.enumerable, get: function () { return d.get.call(this) } }) })();`,
}

// posts the reading, what reached the page, what it loaded and what the extensions left, then goes where the harness says
const REPORT = `(function () {
  var sent = false;
  var send = function (result) {
    if (sent) return;
    sent = true;
    try {
      var names = [], entries = performance.getEntriesByType('resource');
      for (var i = 0; i < entries.length; i++) names[names.length] = entries[i].name;
      result.resources = names;
    } catch (e) { result.resources = null }
    // what the harness checks to know an extension took effect, and which names own-value and plain-getter would see
    try {
      var gopd = Object.getOwnPropertyDescriptor, list = ['userAgent', 'appVersion', 'platform', 'language', 'languages', 'webdriver', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'plugins', 'mimeTypes', 'vendor'];
      var screens = ['width', 'height', 'availWidth', 'availHeight', 'colorDepth'], plain = [];
      var look = function (proto, names, prefix) { for (var i = 0; i < names.length; i++) { var d = gopd(proto, names[i]); if (d && ('value' in d || (d.get && gopd(d.get, 'prototype')))) plain[plain.length] = prefix + names[i] } };
      look(Navigator.prototype, list, 'navigator.');
      look(Screen.prototype, screens, 'screen.');
      result.ext = {
        ownNavigator: Object.getOwnPropertyNames(navigator),
        ownScreen: Object.getOwnPropertyNames(screen),
        plainGetters: plain,
        nativePlugins: gopd(Navigator.prototype, 'plugins').get.call(navigator).length,
        passwordManager: document.documentElement.getAttribute('data-test-password-manager')
      };
    } catch (e) { result.ext = { error: String(e) } }
    result.errors = window.__errors;
    result.violations = window.__violations;
    result.userAgent = navigator.userAgent;
    var x = new XMLHttpRequest();
    x.open('POST', location.pathname.replace('/p/', '/r/'));
    x.onload = function () { if (x.responseText) location.replace(x.responseText) };
    x.send(JSON.stringify(result));
  };
  var timer = setTimeout(function () { send({ error: 'no reading within ${WAIT / 1000} s' }) }, ${WAIT});
  try {
    Visito.get(function (reading) {
      clearTimeout(timer);
      send({ reading: reading });
    });
  } catch (e) { send({ error: 'get threw: ' + e }) }
})();`

// The page policies (R24 (c)), loaded with the lab build, which carries the candidates. Trusted Types alone, enforced and report-only, as a site rolling them out sends them; and a strict policy
// that allows only the page's own nonced scripts and its own origin for the result. Every report goes to the harness.
const NONCE = 'visitomarks'
const POLICY = {
  'tt-enforced': ['content-security-policy', (id) => `require-trusted-types-for 'script'; report-uri /csp/${id}`],
  'tt-report-only': ['content-security-policy-report-only', (id) => `require-trusted-types-for 'script'; report-uri /csp/${id}`],
  'csp-strict': ['content-security-policy', (id) => `default-src 'none'; script-src 'nonce-${NONCE}'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'; report-uri /csp/${id}`],
}

const page = (run) => {
  const tag = run.policy ? `<script nonce="${NONCE}"` : '<script'
  return `<!doctype html><meta charset="utf-8"><title>marks</title>
${tag}>${PRELUDE}</script>${run.variant === 'innocent' ? `\n${tag}>${INNOCENT}</script>` : ''}${run.fixture ? `\n${tag}>${FIXTURES[run.fixture]}</script>` : ''}
${tag} src="/${run.build === 'lab' ? 'visito.lab.min.js' : 'visito.min.js'}"></script>
${tag}>${REPORT}</script>`
}

// ---- the server: pages, builds, results, reports ------------------------------------------------------------------------------

const dist = process.env.DIST ? pathToFileURL(process.env.DIST.replace(/\/?$/, '/')) : new URL('../dist/', import.meta.url)
const FILES = {}
for (const name of ['visito.min.js', 'visito.lab.min.js']) FILES['/' + name] = readFileSync(new URL(name, dist))
const SCRIPTS = Object.keys(FILES)

// the lab build inlined on a navigated page, as a site's page is; the reading's own lap for the x.bot task is what is timed
const COST_PAGE = `<!doctype html><meta charset="utf-8"><title>cost</title><script>${FILES['/visito.lab.min.js'].toString('utf8')}</script><script>Visito.get(function (r) { window.__t = r && r.t ? r.t.bot : null })</script>`

const runs = new Map()
let nextId = 1
const stray = []
const server = http.createServer((request, response) => {
  const path = request.url.split('?')[0]
  if (FILES[path]) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[path])
  if (path === '/cost') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(COST_PAGE)
  // the browser asks for its icon by itself: answered with nothing, so no browser logs a failed load on a page under a policy
  if (path === '/favicon.ico') return response.writeHead(204).end()
  const match = /^\/([prc]|csp)\/(\d+)$/.exec(path)
  const run = match && runs.get(match[2])
  if (!run) {
    // a request the harness did not expect
    stray.push(path)
    return response.writeHead(404).end()
  }
  if (match[1] === 'p') {
    run.requested = request.headers['user-agent'] || null
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    if (run.policy) headers[POLICY[run.policy][0]] = POLICY[run.policy][1](run.id)
    return response.writeHead(200, headers).end(page(run))
  }
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    // a violation report the browser sent: counted against the run, and the source it names kept
    if (match[1] === 'csp') {
      run.reports.push(body)
      return response.writeHead(204).end()
    }
    let result
    try {
      result = JSON.parse(body)
    } catch (e) {
      result = { error: 'unreadable result' }
    }
    const next = run.next ? run.next() : ''
    response.writeHead(200, { 'content-type': 'text/plain' }).end(next)
    run.done(result)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port
const ORIGIN = `http://127.0.0.1:${PORT}`
// a name that is not potentially trustworthy, so the page is not a secure context; mapped to the loopback server, never resolved
const LAN = `http://lan.test:${PORT}`

/** Registers one page load; the promise settles with the page's result. */
function plan(spec) {
  const id = String(nextId++)
  let done
  const result = new Promise((resolve) => (done = resolve))
  const run = { ...spec, id, done, requested: null, reports: [] }
  runs.set(id, run)
  return { run, result, path: `/p/${id}` }
}

// The user agents the switcher extension is set to, with the appVersion and platform each browser reports for itself (HTML, NavigatorID)
const UA_TARGETS = {
  'edge-windows': { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0', platform: 'Win32' },
  'chrome-mac': { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36', platform: 'MacIntel' },
  'firefox-windows': { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0', appVersion: '5.0 (Windows)', platform: 'Win32' },
}
for (const t of Object.values(UA_TARGETS)) if (!t.appVersion) t.appVersion = t.userAgent.slice('Mozilla/'.length)
// a simpler switcher that replaces the user agent alone, leaving appVersion and platform as the browser gives them
UA_TARGETS['edge-windows-ua-only'] = { userAgent: UA_TARGETS['edge-windows'].userAgent }
// a full-profile switcher that also sets the vendor the target browser reports (HTML, NavigatorID: "Google Inc." in Chrome and Edge)
UA_TARGETS['edge-windows-full-profile'] = { ...UA_TARGETS['edge-windows'], vendor: 'Google Inc.' }

/** Whether the extension a clean context loaded left what it leaves; a launch where it did not is a harness failure, not a count. */
function extensionTookEffect(extension, result) {
  const ext = (result && result.ext) || {}
  if (ext.error) return 'the page could not look: ' + ext.error
  const own = ext.ownNavigator || []
  const [name, option] = extension.split(' ')
  if (name === 'ua-switcher') {
    if (result.userAgent !== UA_TARGETS[option].userAgent) return 'the user agent was not switched'
    return UA_TARGETS[option].vendor && own.indexOf('vendor') < 0 ? 'navigator has no own vendor' : null
  }
  if (name === 'language-switcher') return own.indexOf('languages') >= 0 && own.indexOf('language') >= 0 ? null : 'navigator has no own language and languages'
  if (name === 'hardware-spoofer') return own.indexOf('hardwareConcurrency') >= 0 && (ext.ownScreen || []).indexOf('width') >= 0 ? null : 'navigator and screen have no own hardware values'
  if (name === 'plugin-emulator') {
    if (own.indexOf('plugins') < 0) return 'navigator has no own plugins'
    if (option !== 'no-pdf' && !(ext.nativePlugins > 0)) return 'the native plug-in list is empty'
    return null
  }
  if (name === 'privacy') return (ext.plainGetters || []).indexOf('navigator.hardwareConcurrency') >= 0 ? null : 'the getters were not replaced'
  if (name === 'password-manager') return ext.passwordManager !== null && ext.passwordManager !== undefined ? null : 'the content script did not run'
  return 'unknown extension ' + extension
}

/** One record per page load: what came back, judged against the schema, plus the request facts the harness saw. */
function record(ctx, key, run, result, outside, consoleMessages) {
  const reading = result && result.reading
  const failures = []
  if (!result || result.error) failures.push(result ? result.error : 'no result')
  if (result && result.errors && result.errors.length) failures.push(...result.errors)
  if (reading) failures.push(...problems(reading).map((p) => 'schema: ' + p))
  else if (result && !result.error) failures.push('the reading was null')
  // the lab build must record every candidate as true, false or "!na"
  if (reading && run.build === 'lab') {
    const bad = CANDIDATES.filter((mark) => [true, false, '!na'].indexOf(reading.c['x.bot.' + mark]) < 0)
    if (bad.length) failures.push('x.bot.* not true, false or "!na": ' + bad.join(', '))
  }
  // only the page and its scripts: the page's own list of what it loaded, and what the server saw that it did not expect
  const loaded = (result && result.resources) || []
  // the icon is the browser's own request, which some builds also list in the page's timing entries
  const foreign = loaded.filter((name) => SCRIPTS.concat(['/favicon.ico']).indexOf(name.replace(/^https?:\/\/[^/]+/, '')) < 0)
  if (!result || result.resources === null) failures.push('the page could not list what it loaded')
  if (foreign.length) failures.push('the page loaded ' + foreign.join(', '))
  if (outside && outside.length) failures.push('requests left the page: ' + outside.join(', '))
  const notes = []
  if (ctx.extension && result && !result.error) {
    const why = extensionTookEffect(ctx.extension, result)
    if (why) failures.push('the extension did not take effect: ' + why)
    // an older build keeps an entry with PDF viewing off: the emulator still ran, over a list that is not empty
    else if (/ no-pdf$/.test(ctx.extension) && result.ext.nativePlugins !== 0) notes.push(`the native plug-in list kept ${result.ext.nativePlugins} entries with PDF viewing off`)
  }
  // under a page policy: what the browser logged, the violations the page saw and the reports it sent, by the script they name
  const policy = run.policy ? {
    console: (consoleMessages || []).map((m) => `${m.type}: ${m.text} (${m.url})`),
    violations: ((result && result.violations) || []).map((v) => `${v.disposition} ${v.directive} ${v.blocked} (${v.source})`),
    reports: run.reports.slice(),
  } : null
  // noted, never a harness failure: whether they count against a candidate is evidenceFrom's business
  if (policy) for (const kind of ['console', 'violations', 'reports']) if (policy[kind].length) notes.push(`${run.policy}: ${policy[kind].length} ${kind}: ${policy[kind].join(' | ').slice(0, 300)}`)
  return {
    key,
    build: run.build,
    variant: run.variant,
    fixture: run.fixture || null,
    ctx: { ...ctx, fixture: run.fixture || null, userAgent: (result && result.userAgent) || run.requested, requested: run.requested, major: majorFor(ctx, run.requested) },
    failures,
    notes,
    policy,
    auto: reading ? reading.flags.auto : null,
    ext: (result && result.ext) || null,
    lab: reading && run.build === 'lab' ? Object.fromEntries(Object.keys(reading.c).filter((k) => k.indexOf('x.bot.') === 0).map((k) => [k.slice(6), reading.c[k]])) : null,
    engine: reading ? { engine: reading.c['x.engine'], android: reading.c['x.android'], os: reading.os, app: reading.app } : null,
    // the lab stage's lap for the bot task, in milliseconds
    ms: reading && run.build === 'lab' && reading.t ? reading.t.bot : null,
  }
}

/** The Blink major the harness launched. Brave numbers its own releases, so its unswitched user agent gives the engine's. */
function majorFor(ctx, requested) {
  if (ctx.engine !== 'blink') return null
  if (ctx.browser === 'brave') {
    const m = /Chrome\/(\d+)/.exec(requested || '')
    return m ? +m[1] : null
  }
  return parseInt(ctx.version, 10)
}

/** The page loads one context needs: both builds, R times each, interleaved. The product build gives the core's flags.auto as it ships. */
function loads(variant, fixture, policy) {
  const out = []
  for (let i = 0; i < RUNS; i++) for (const build of ['product', 'lab']) out.push({ build, variant, fixture, policy })
  return out
}

// ---- clean launches -----------------------------------------------------------------------------------------------------------

const DECOY = {
  android: 'Mozilla/5.0 (Android 15; Mobile; rv:146.0) Gecko/146.0 Firefox/146.0',
  // a desktop Chrome user agent for another OS, switched by the browser itself
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
}
const PROGRAMS = process.env.ProgramFiles || 'C:/Program Files'
const PROGRAMS_X86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
const INSTALLED = {
  chrome: join(PROGRAMS, 'Google/Chrome/Application/chrome.exe'),
  edge: join(PROGRAMS_X86, 'Microsoft/Edge/Application/msedge.exe'),
  brave: join(PROGRAMS, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
}
// Switches a person may use too, none of them visible to a page as automation: no first-run pages or default-browser question in a
// profile made for one run, and no occlusion tracking, so a window that opens behind the terminal still counts as visible (the lab
// stage waits for a visible page). Playwright's Chromium build also runs its network service unsandboxed: its folder's permissions
// keep that sandbox from starting here, and the restart loses the first navigation (measured 2026-11-13)
const CHROMIUM_QUIET = ['--no-first-run', '--no-default-browser-check']
const NO_OCCLUSION = '--disable-features=CalculateNativeWinOcclusion'
const PLAYWRIGHT_CHROMIUM = '--disable-features=CalculateNativeWinOcclusion,NetworkServiceSandbox'
// a launch whose first page is not requested in time is ended and started again with a new profile
const FIRST_PAGE_MS = 15000
const ATTEMPTS = 4
const FIREFOX_PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'startup.homepage_welcome_url': '',
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'widget.windows.window_occlusion_tracking.enabled': false,
}
// Chrome's "download PDF files instead of opening them" setting, which empties navigator.plugins
const NO_PDF = { plugins: { always_open_pdf_externally: true } }
// content_scripts "world" is in Chrome from 111 (MDN compatibility data); older builds get the same code through a script element
const MAIN_WORLD_FROM = 111

/** The clean contexts of one browser: { mode, configured, args(url, dir), prefs, chromePrefs, extension }. */
function cleanContexts(browser) {
  const features = browser === 'chromium' ? PLAYWRIGHT_CHROMIUM : NO_OCCLUSION
  const chromium = (extra = []) => (url, dir) => ['--user-data-dir=' + dir, ...CHROMIUM_QUIET, features, ...extra(dir), url]
  const none = () => []
  if (browser === 'chromium') {
    const loaded = (dir) => ['--load-extension=' + join(dir, 'extension')]
    return [
      { mode: 'normal', args: chromium(none) },
      { mode: 'incognito', args: chromium(() => ['--incognito']) },
      { mode: 'insecure', insecure: true, args: chromium(() => ['--host-resolver-rules=MAP lan.test 127.0.0.1']) },
      { mode: 'ua-android', configured: true, args: chromium(() => ['--user-agent=' + DECOY.android]) },
      { mode: 'ua-mac', configured: true, args: chromium(() => ['--user-agent=' + DECOY.mac]) },
      ...EXTENSIONS.map((extension) => ({
        mode: 'ext ' + extension,
        extension,
        configured: true,
        chromePrefs: / no-pdf$/.test(extension) ? NO_PDF : null,
        args: chromium(loaded),
      })),
    ]
  }
  if (browser === 'chrome' || browser === 'brave') return [{ mode: 'normal', args: chromium(none) }, { mode: 'incognito', args: chromium(() => ['--incognito']) }]
  if (browser === 'edge') return [{ mode: 'normal', args: chromium(none) }, { mode: 'inprivate', args: chromium(() => ['--inprivate']) }]
  if (browser === 'firefox') {
    const firefox = (extra = []) => (url, dir) => ['-no-remote', '-profile', dir, ...extra, url]
    return [
      { mode: 'normal', args: firefox() },
      { mode: 'private', args: firefox(['-private-window']) },
      { mode: 'fpp', configured: true, prefs: { 'privacy.fingerprintingProtection': true }, args: firefox() },
      { mode: 'rfp', configured: true, prefs: { 'privacy.resistFingerprinting': true }, args: firefox() },
    ]
  }
  // Playwright's WebKit build starts without its inspector pipe and opens the URL it is given
  if (browser === 'webkit') return [{ mode: 'normal', args: (url) => [url] }]
  throw new Error(`unknown browser "${browser}": use chromium, chrome, edge, brave, firefox or webkit`)
}

const ENGINE_OF = { chromium: 'blink', chrome: 'blink', edge: 'blink', brave: 'blink', msedge: 'blink', firefox: 'gecko', webkit: 'webkit' }

function executable(browser) {
  if (INSTALLED[browser]) return INSTALLED[browser]
  if (browser === 'chromium' && process.env.CHROMIUM) return process.env.CHROMIUM
  return playwright[browser].executablePath()
}

/** The file version Windows records for an executable. */
function fileVersion(path) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${path}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim() || 'unknown'
  } catch (e) {
    return 'unknown'
  }
}

/** The installed version, from the folder Chrome-family installers name after it, or the executable's own file version. */
function versionOf(browser) {
  try {
    if (INSTALLED[browser]) return readdirSync(join(INSTALLED[browser], '..')).filter((name) => /^\d+\.\d+/.test(name)).sort().pop() || 'unknown'
  } catch (e) {
    return 'unknown'
  }
  if (browser === 'chromium') return fileVersion(executable(browser))
  return null
}

/** Ends every process started with this profile folder, whatever the browser did with the first one. */
function sweep(pid, dir) {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch (e) {
    // already gone
  }
  const leaf = dir.split(/[\\/]/).pop()
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${leaf}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' })
  } catch (e) {
    // nothing left to end
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function removeDir(dir) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      await pause(500)
    }
  }
}

/**
 * The extension as this build loads it, copied into the profile folder: Manifest V3 with its main-world scripts from Chrome 111; for an
 * older build, Manifest V2 whose content script inserts each main-world script as an inline script element at document start.
 */
function placeExtension(dir, extension, major) {
  const [name, option] = extension.split(' ')
  const from = join(EXTENSION_DIR, name)
  const to = join(dir, 'extension')
  cpSync(from, to, { recursive: true })
  if (name === 'ua-switcher') {
    const file = join(to, 'switch.js')
    const target = UA_TARGETS[option]
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^ {2}var target = .*\/\/ TARGET$/m, `  var target = ${JSON.stringify(target)} // TARGET`))
  }
  if (major >= MAIN_WORLD_FROM) return
  const manifest = JSON.parse(readFileSync(join(to, 'manifest.json'), 'utf8'))
  manifest.manifest_version = 2
  for (const script of manifest.content_scripts) {
    if (script.world !== 'MAIN') continue
    delete script.world
    const code = script.js.map((js) => readFileSync(join(to, js), 'utf8')).join('\n')
    writeFileSync(join(to, 'inject.js'), `(function () { var s = document.createElement('script'); s.textContent = ${JSON.stringify(code)}; (document.head || document.documentElement).appendChild(s); s.remove() })()\n`)
    script.js = ['inject.js']
  }
  writeFileSync(join(to, 'manifest.json'), JSON.stringify(manifest, null, 1))
}

function profileDir(browser, context, major) {
  const dir = mkdtempSync(join(tmpdir(), 'visito-marks-'))
  if (browser === 'firefox') {
    const prefs = { ...FIREFOX_PREFS, ...(context.prefs || {}) }
    writeFileSync(join(dir, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n')
  }
  if (context.chromePrefs) {
    mkdirSync(join(dir, 'Default'), { recursive: true })
    writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify(context.chromePrefs))
  }
  if (context.extension) placeExtension(dir, context.extension, major)
  return dir
}

/** Starts the browser on the first page; resolves with { proc, dir } once that page was requested, or null after the last attempt. */
async function start(browser, context, first, url, major) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const dir = profileDir(browser, context, major)
    const proc = spawn(executable(browser), context.args(url, dir), { stdio: ['ignore', 'pipe', 'pipe'] })
    // read and dropped: the browser's own log
    proc.stdout.resume()
    proc.stderr.resume()
    const deadline = Date.now() + FIRST_PAGE_MS
    while (!first.requested && Date.now() < deadline) await pause(200)
    if (first.requested) return { proc, dir, attempt }
    sweep(proc.pid, dir)
    await pause(1000)
    await removeDir(dir)
  }
  return null
}

/** One clean launch: a fresh profile, the URL of the first page on the command line; each page sends the browser to the next. */
async function cleanRun(browser, context, variant, version) {
  const base = context.insecure ? LAN : ORIGIN
  const planned = loads(variant).map(plan)
  for (let i = 0; i < planned.length; i++) planned[i].run.next = i + 1 < planned.length ? () => base + planned[i + 1].path : () => ''
  const strayBefore = stray.length
  const major = parseInt(version, 10)
  const ctx = { launch: 'clean', browser, engine: ENGINE_OF[browser], host: HOST, testBuild: browser === 'firefox' || browser === 'webkit', mode: context.mode, extension: context.extension || null, configured: !!context.configured, headless: false, shell: false, uaSet: !!context.configured && /^ua-/.test(context.mode), hasTouch: false, version }
  const key = `${browser} ${browser === 'chromium' ? major : version} clean ${context.mode} ${variant}`
  const started = await start(browser, context, planned[0].run, base + planned[0].path, major)
  if (!started) return [{ key, ctx, failures: [`the browser never requested the first page in ${ATTEMPTS} launches`], build: null }]
  const records = []
  try {
    for (const { run, result } of planned) {
      let timer
      const got = await Promise.race([result, new Promise((resolve) => (timer = setTimeout(resolve, WAIT + 15000, null)))])
      clearTimeout(timer)
      records.push(record({ ...ctx, attempt: started.attempt }, key, run, got || { error: 'the page never reported' }, null, null))
      if (!got) break
    }
  } finally {
    sweep(started.proc.pid, started.dir)
    await pause(1000)
    await removeDir(started.dir)
  }
  const strays = stray.slice(strayBefore)
  if (strays.length) records.push({ key, ctx, failures: ['unexpected requests: ' + strays.join(', ')], build: null })
  return records
}

// ---- driven launches ----------------------------------------------------------------------------------------------------------

const DRIVEN_DECOYS = {
  'firefox-ua': 'Mozilla/5.0 (Android 15; Mobile; rv:146.0) Gecko/146.0 Firefox/146.0',
  'safari-ua': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
}

function drivenModes(engine) {
  if (engine === 'chromium') return [{ mode: 'headed', options: { headless: false } }, { mode: 'headless-shell', options: {}, headless: true, shell: true }, { mode: 'headless-new', options: { channel: 'chromium' }, headless: true }]
  return [{ mode: 'headed', options: { headless: false } }, { mode: 'headless', options: {}, headless: true }]
}

function drivenProfiles(engine) {
  const phone = engine === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE
  const out = [
    { name: 'desktop', options: {} },
    { name: 'phone', options: phone, uaSet: true, hasTouch: true },
    ...Object.keys(DRIVEN_DECOYS).map((name) => ({ name, options: { userAgent: DRIVEN_DECOYS[name] }, uaSet: true })),
    { name: 'locale', options: { locale: 'ar-EG', timezoneId: 'Asia/Tokyo' } },
    { name: 'insecure', options: {}, insecure: true },
    { name: 'persistent', options: {}, persistent: true },
    { name: 'innocent', options: {}, variant: 'innocent' },
    ...POLICIES.map((policy) => ({ name: policy, options: {}, policy })),
    { name: 'fixture own-value', options: {}, fixture: 'own-value' },
    { name: 'fixture plain-getter', options: {}, fixture: 'plain-getter' },
  ]
  if (engine === 'chromium') out.splice(1, 0, { name: 'pixel-7', options: playwright.devices['Pixel 7'], uaSet: true, hasTouch: true })
  if (engine === 'webkit') out.splice(1, 0, { name: 'iphone-15', options: playwright.devices['iPhone 15'], uaSet: true, hasTouch: true })
  return out
}

/** Serves the insecure profile's pages from the loopback server under a name that is not a secure context. */
async function routeLan(context) {
  await context.route(`${LAN}/**`, async (route) => {
    const request = route.request()
    const answer = await fetch(ORIGIN + new URL(request.url()).pathname, { method: request.method(), body: request.method() === 'POST' ? request.postData() : undefined, headers: { 'user-agent': request.headers()['user-agent'] || '' } })
    await route.fulfill({ status: answer.status, headers: { 'content-type': answer.headers.get('content-type') || 'text/plain' }, body: Buffer.from(await answer.arrayBuffer()) })
  })
}

async function drivenEngine(engine) {
  const records = []
  const versions = {}
  for (const mode of drivenModes(engine)) {
    let browser = null
    try {
      browser = await playwright[engine].launch(mode.options)
      versions[mode.mode] = browser.version()
      for (const profile of drivenProfiles(engine).filter((p) => !process.env.ONLY || p.name.indexOf(process.env.ONLY) >= 0)) {
        const variant = profile.variant || 'plain'
        const key = `${engine} ${parseInt(versions[mode.mode], 10)} driven ${mode.mode} ${profile.name}`
        const ctx = { launch: 'driven', browser: engine, engine: ENGINE_OF[engine], host: HOST, mode: mode.mode, profile: profile.name, policy: profile.policy || null, configured: false, headless: !!mode.headless, shell: !!mode.shell, uaSet: !!profile.uaSet, hasTouch: !!profile.hasTouch, version: versions[mode.mode] }
        for (const spec of loads(variant, profile.fixture, profile.policy)) {
          const { run, result, path } = plan(spec)
          let context = null
          let dir = null
          const outside = []
          const messages = []
          try {
            if (profile.persistent) {
              dir = mkdtempSync(join(tmpdir(), 'visito-marks-'))
              context = await playwright[engine].launchPersistentContext(dir, { ...mode.options, ...profile.options })
            } else context = await browser.newContext(profile.options)
            if (profile.insecure) await routeLan(context)
            const tab = context.pages()[0] || (await context.newPage())
            const base = profile.insecure ? LAN : ORIGIN
            // the page's own report endpoint is the harness's; any other request left the page
            tab.on('request', (request) => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) outside.push(request.url()) })
            tab.on('pageerror', (error) => outside.push('page error: ' + String(error)))
            tab.on('console', (message) => messages.push({ type: message.type(), text: message.text(), url: (message.location() || {}).url || '' }))
            await tab.goto(base + path, { waitUntil: 'load', timeout: WAIT })
            let timer
            const got = await Promise.race([result, new Promise((resolve) => (timer = setTimeout(resolve, WAIT + 5000, null)))])
            clearTimeout(timer)
            // reports are sent after the event that caused them: give them time to arrive
            if (profile.policy) await pause(1500)
            records.push(record(ctx, key, run, got || { error: 'the page never reported' }, outside, messages))
          } catch (e) {
            records.push(record(ctx, key, run, { error: 'harness: ' + e.message.split('\n')[0] }, outside, messages))
          } finally {
            if (context) await context.close().catch(() => {})
            if (dir) await removeDir(dir)
          }
        }
      }
    } catch (e) {
      records.push({ key: `${engine} driven ${mode.mode}`, ctx: { launch: 'driven', browser: engine }, failures: ['launch: ' + e.message.split('\n')[0]], build: null })
    } finally {
      if (browser) await browser.close().catch(() => {})
    }
  }
  return { records, versions }
}

// ---- the cost at script start -------------------------------------------------------------------------------------------------

const COST_LAUNCH = { chromium: {}, chrome: { channel: 'chrome' }, msedge: { channel: 'msedge' } }

/**
 * The lab build's lap for the x.bot task, all candidates together, on a navigated page, headed, one fresh context per load
 * (Playwright starts each with a temporary profile). It runs in the lab stage after the page has parsed, so it is an upper bound for
 * any one candidate there and not the time a script would take at script start, which a shipped entry would have measured again.
 */
async function cost(target) {
  const browser = await playwright.chromium.launch({ headless: false, args: [NO_OCCLUSION], ...COST_LAUNCH[target] })
  const times = []
  try {
    for (let i = 0; i < COST_CONTEXTS; i++) {
      const context = await browser.newContext()
      const tab = await context.newPage()
      await tab.goto(ORIGIN + '/cost', { waitUntil: 'load' })
      await tab.waitForFunction(() => window.__t !== undefined, null, { timeout: WAIT })
      times.push(await tab.evaluate(() => window.__t))
      await context.close()
    }
    const list = times.filter(Number.isFinite).sort((a, b) => a - b)
    return { browser: target, version: browser.version(), contexts: list.length, median: list[list.length >> 1], max: list[list.length - 1], times }
  } finally {
    await browser.close()
  }
}

// ---- counting -----------------------------------------------------------------------------------------------------------------

/**
 * Splits records into per-mark observations for the tally: the lab build's x.bot.* keys ("lab" inside the gate a mark would ship
 * behind, "lab-outside" beyond it, where a firing says how far a mark would reach, not that it misfired) and flags.auto ("core").
 */
function observations(records) {
  const out = []
  for (const r of records) {
    if (!r.build || r.failures.length) continue
    const core = {}
    for (const mark of CORE_MARKS) core[mark] = r.auto.indexOf(mark) >= 0
    out.push({ source: 'core', key: r.key, ctx: r.ctx, marks: core, ran: null })
    const marks = {}
    const ran = {}
    if (r.build === 'lab') {
      for (const mark of CANDIDATES) {
        marks[mark] = r.lab[mark] === true
        ran[mark] = r.lab[mark] === true || r.lab[mark] === false
      }
      out.push({ source: inGate(r.ctx, 0) ? 'lab' : 'lab-outside', key: r.key, ctx: r.ctx, marks, ran })
    }
  }
  return out
}

function loadAll(prefix) {
  if (!existsSync(RAW)) return []
  return readdirSync(RAW).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).map((name) => JSON.parse(readFileSync(new URL(name, RAW), 'utf8')))
}

const tick = (mark) => '`' + mark + '`'

/**
 * The evidence the ship rule needs beyond the counts: the newest rung, the page policies by engine, the cost by browser. No gate has
 * a ceiling and no embedder was measured, so those two populations stay owed for every candidate (lab/mark-truth.mjs).
 */
function evidenceFrom(records, costs) {
  const policies = []
  for (const r of records) {
    // the lab page carries the candidates. Its violations and reports count; its console messages are listed but not counted, since
    // the lab build reads far more than any candidate (Firefox logs a warning for its screen reads under fingerprinting protection)
    if (!r.ctx || !r.ctx.policy || r.build !== 'lab') continue
    let row = policies.find((p) => p.policy === r.ctx.policy && p.engine === r.ctx.browser)
    if (!row) policies.push((row = { policy: r.ctx.policy, engine: r.ctx.browser, loads: 0, console: 0, violations: 0, reports: 0, failures: 0 }))
    row.loads++
    if (r.policy) for (const kind of ['console', 'violations', 'reports']) row[kind] += r.policy[kind].length
    if (r.failures.length) row.failures++
  }
  const majors = records.filter((r) => r.ctx && r.ctx.launch === 'clean' && r.ctx.engine === 'blink' && r.build).map((r) => r.ctx.major).filter(Number.isFinite)
  // console messages are shown with the policies, not counted against a candidate
  return { newest: Math.max(...majors), policies: policies.map((p) => ({ ...p, logged: p.console, console: 0 })), cost: costs }
}

/** The rows docs/DECISIONS.md records, reproduced from the raw files. */
async function table() {
  const files = loadAll('marks-clean-').concat(loadAll('marks-driven-'))
  // a context run again on its own replaces its earlier records; the replaced ones are counted and named, never dropped silently
  const rerun = new Set(files.filter((file) => file.only).flatMap((file) => file.records.map((r) => r.key)))
  const replaced = files.filter((file) => !file.only).flatMap((file) => file.records).filter((r) => rerun.has(r.key))
  const records = files.flatMap((file) => (file.only ? file.records : file.records.filter((r) => !rerun.has(r.key))))
  if (replaced.length) console.log(`Run again on their own, replacing ${replaced.length} earlier records (${replaced.filter((r) => r.failures.length).length} of them with a harness failure): ${[...new Set(replaced.map((r) => r.key))].join('; ')}.
`)
  // only the lab lap: an older file timed an entry that no longer exists
  const costs = loadAll('marks-cost').filter((file) => file.kind === 'lab-lap').flatMap((file) => file.results)
  const failures = records.filter((r) => r.failures.length)
  const rows = tally(observations(records))
  const evidence = evidenceFrom(records, costs)
  const builds = [...new Set(records.map((r) => `${r.ctx.browser} ${r.ctx.version}`))].sort()
  const configurations = (filter) => new Set(rows.filter(filter).map((row) => row.key)).size
  console.log(`Records: ${records.length} page loads in ${new Set(records.map((r) => r.key)).size} configurations, ${failures.length} with a harness failure. Builds: ${builds.join(', ')}.\n`)

  console.log('Verdicts (lab/mark-truth.mjs verdict: R24). Counts are configurations, each loaded RUNS times per build; repeats test determinism only.\n')
  console.log('| Mark | Floor | Clean configurations looked in / fired | Driven configurations looked in / fired / true | False positives | Person-caused | Verdict |\n|---|---|---|---|---|---|---|')
  for (const mark of CANDIDATES) {
    const floor = floorOf(mark)
    const mine = (launch) => rows.filter((row) => row.mark === mark && row.source === 'lab' && row.launch === launch && !(row.major < floor) && row.ran > 0)
    const fired = (list) => new Set(list.filter((row) => row.fired).map((row) => row.key)).size
    const looked = (list) => new Set(list.map((row) => row.key)).size
    const v = verdict(rows, mark, { ...evidence, floor })
    const status = v.ships ? 'ships' : 'held back'
    const fpKeys = new Set(rows.filter((row) => row.mark === mark && row.source !== 'lab-outside' && row.major >= floor && row.fp).map((row) => row.key)).size
    const personKeys = new Set(rows.filter((row) => row.mark === mark && row.source !== 'lab-outside' && row.major >= floor && row.person).map((row) => row.key)).size
    const trueKeys = new Set(mine('driven').filter((row) => row.true).map((row) => row.key)).size
    console.log(`| ${tick(mark)} | ${floor} | ${looked(mine('clean'))} / ${fired(mine('clean'))} | ${looked(mine('driven'))} / ${fired(mine('driven'))} / ${trueKeys} | ${fpKeys} | ${personKeys} | ${status}${v.reasons.length ? ': ' + v.reasons.join('; ') : ''} |`)
  }
  console.log(`\nOwed for every candidate, and blocking: ${EMBEDDERS}; and every Blink newer than ${evidence.newest}, the newest build measured.`)

  console.log('\nThe oldest rung from which every rung up to the newest is clean, per mark (lab build, raw, inside the gate by user agent):\n')
  for (const mark of CANDIDATES) {
    const majors = [...new Set(rows.filter((row) => row.mark === mark && row.source === 'lab' && row.launch === 'clean' && Number.isFinite(row.major)).map((row) => row.major))].sort((a, b) => a - b)
    const dirty = majors.filter((major) => rows.some((row) => row.mark === mark && row.major === major && row.source === 'lab' && (row.fp || row.person || row.nondeterministic.length)))
    const looked = majors.filter((major) => rows.some((row) => row.mark === mark && row.major === major && row.source === 'lab' && row.launch === 'clean' && row.ran > 0))
    let floor = null
    for (let i = majors.length - 1; i >= 0; i--) {
      if (dirty.indexOf(majors[i]) >= 0 || looked.indexOf(majors[i]) < 0) break
      floor = majors[i]
    }
    console.log(`- ${tick(mark)}: rungs ${majors.join(', ')}; looked at ${looked.join(', ') || 'none'}; fired at ${dirty.join(', ') || 'none'}; clean from ${floor === null ? 'none' : floor}`)
  }

  console.log('\nPage policies (driven, lab build): loads / console messages (listed, not counted) / violation events / reports\n')
  for (const p of evidence.policies) console.log(`- ${p.policy} in ${p.engine}: ${p.loads} / ${p.logged} / ${p.violations} / ${p.reports}${p.failures ? ` (${p.failures} loads with a failure)` : ''}`)
  console.log('\nThe lab build\'s lap for all the candidates together, headed, navigated page, one fresh context per load (ms):\n')
  for (const c of costs) console.log(`- ${c.browser} ${c.version}: ${c.contexts} contexts; median ${c.median.toFixed(2)}, max ${c.max.toFixed(2)}`)
  if (!costs.length) console.log('- none recorded: node lab/marks.mjs cost')

  // the full table, one row per configuration: what the lab build saw for each candidate
  const marks = CANDIDATES
  const cell = (key, mark) => {
    const lab = rows.find((row) => row.key === key && row.mark === mark && row.source !== 'core')
    return !lab ? '' : !lab.ran ? '-' : lab.fired ? (lab.fired === lab.runs ? 'FIRED' : 'some') : '0'
  }
  console.log('\nPer configuration, lab build: "0" (looked, not seen), "FIRED" (every load), "some" (some loads), "-" (could not be looked for, "!na").\n')
  console.log(`| Configuration | Gate | ${marks.map(tick).join(' | ')} |\n|---|---|${marks.map(() => '---').join('|')}|`)
  const keys = [...new Set(records.filter((r) => r.build && !r.failures.length).map((r) => r.key))]
  const sample = (key) => records.find((r) => r.key === key && r.build)
  for (const key of keys.sort()) console.log(`| ${key} | ${inGate(sample(key).ctx, 0) ? 'in' : 'out'} | ${marks.map((mark) => cell(key, mark)).join(' | ')} |`)

  console.log('\nThe core flags.auto marks, both builds: configurations / fired / false positives / person-caused\n')
  for (const mark of CORE_MARKS) {
    const mine = rows.filter((row) => row.mark === mark && row.source === 'core')
    const count = (filter) => new Set(mine.filter(filter).map((row) => row.key)).size
    console.log(`- ${tick(mark)}: clean ${count((row) => row.launch === 'clean')} / ${count((row) => row.launch === 'clean' && row.fired)} / ${count((row) => row.launch === 'clean' && row.fp)} / ${count((row) => row.person)}; driven ${count((row) => row.launch === 'driven')} / ${count((row) => row.launch === 'driven' && row.fired)} / ${count((row) => row.launch === 'driven' && row.fp)}`)
  }
  if (failures.length) {
    console.log('\nHarness failures (not counted as false positives, but they block shipping):')
    for (const f of failures.slice(0, 60)) console.log(`  ${f.key} ${f.build || ''}: ${f.failures.join(' | ').slice(0, 400)}`)
  }
  return failures.length
}

// ---- main ---------------------------------------------------------------------------------------------------------------------

const [command, ...targets] = process.argv.slice(2)
let code = 0
try {
  if (command === '--table') code = (await table()) ? 1 : 0
  else if (command === 'cost') {
    const results = []
    for (const target of targets.length ? targets : COST_BROWSERS) {
      const result = await cost(target)
      console.log(`${target} ${result.version}: ${result.contexts} contexts; lab lap for the candidates median ${result.median.toFixed(2)} ms, max ${result.max.toFixed(2)} ms`)
      results.push(result)
    }
    writeFileSync(new URL('marks-cost.json', RAW), JSON.stringify({ kind: 'lab-lap', date: new Date().toISOString(), results }, null, 1))
  } else if (command === 'clean') {
    for (const browser of targets.length ? targets : ['chromium', 'chrome', 'edge', 'brave', 'firefox', 'webkit']) {
      const version = versionOf(browser) || (await (async () => { const b = await playwright[browser].launch(); const v = b.version(); await b.close(); return v })())
      const records = []
      // ONLY=<text> keeps the contexts whose mode contains it: for trying one context, never for a count of record
      for (const context of cleanContexts(browser).filter((c) => !process.env.ONLY || c.mode.indexOf(process.env.ONLY) >= 0)) {
        for (const variant of ['plain', 'innocent']) {
          const got = await cleanRun(browser, context, variant, version)
          const bad = got.filter((r) => r.failures.length)
          console.log(`${bad.length ? 'FAIL' : 'ok  '} ${browser} ${version} clean ${context.mode} ${variant}: ${got.length} loads${bad.length ? ' <- ' + bad[0].failures.join(' | ').slice(0, 300) : ''}`)
          records.push(...got)
        }
      }
      // a run of some contexts only is kept in its own file; its records replace the earlier ones of the same contexts (see table)
      const only = process.env.ONLY ? '-rerun-' + process.env.ONLY.replace(/[^a-z0-9]+/gi, '-') : ''
      const name = browser === 'chromium' ? `marks-clean-chromium-${parseInt(version, 10)}${only}.json` : `marks-clean-${browser}${only}.json`
      writeFileSync(new URL(name, RAW), JSON.stringify({ browser, version, executable: executable(browser), launch: 'clean', runs: RUNS, only: process.env.ONLY || null, date: new Date().toISOString(), records }, null, 1))
      if (records.some((r) => r.failures.length)) code = 1
    }
  } else if (command === 'driven') {
    for (const engine of targets.length ? targets : ['chromium', 'firefox', 'webkit']) {
      const { records, versions } = await drivenEngine(engine)
      const bad = records.filter((r) => r.failures.length)
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${engine} ${JSON.stringify(versions)} driven: ${records.length} loads${bad.length ? ', ' + bad.length + ' failed, first: ' + bad[0].key + ' ' + bad[0].failures.join(' | ').slice(0, 300) : ''}`)
      writeFileSync(new URL(`marks-driven-${engine}.json`, RAW), JSON.stringify({ browser: engine, versions, launch: 'driven', runs: RUNS, date: new Date().toISOString(), records }, null, 1))
      if (bad.length) code = 1
    }
  } else {
    console.log('usage: node lab/marks.mjs clean [browser...] | driven [engine...] | cost [browser...] | --table')
    code = 2
  }
} finally {
  server.close()
}
process.exit(code)
