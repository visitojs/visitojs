// Checks that the deep id stays the same where it should on one machine, and moves or stays out where the documentation says it
// does: reloads, new contexts in two launches, pixel ratios, page locales, Chromium's interface language, forced colours and a
// dark scheme, the display scale, text size and zoom a person sets (lab/scale-settings.mjs), the core loaded beside it, injected
// noise, the per-browser rules, and Firefox's protection preferences.
// Usage: node lab/deep-stability.mjs [chromium|firefox|webkit] [--gpu | --private] [--headed] [--exe <installed browser> --label <name>]
// --exe starts an installed Chromium-based browser with a temporary profile of its own (Playwright's default), never the user's.
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as playwright from 'playwright'
import { launchFrom, loadPage, stopOnPageLoad } from './launch.mjs'
import { deepProblems } from './deep-schema.mjs'
import { blockedFont } from './notices.mjs'
import { profileWith, SCALE_SETTINGS } from './scale-settings.mjs'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const engineName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chromium'
const launch = launchFrom(engineName, process.argv)
const exe = arg('exe')
const label = (exe ? arg('label', 'installed') : engineName) + launch.suffix
const FILES = {
  '/deep.min.js': readFileSync(new URL('../dist/deep.min.js', import.meta.url)),
  '/visito.min.js': readFileSync(new URL('../dist/visito.min.js', import.meta.url)),
}
const PAGES = {
  '/': ['/deep.min.js'],
  '/core': ['/visito.min.js'],
  '/both': ['/visito.min.js', '/deep.min.js'],
}
const page = (scripts) => `<!doctype html><meta charset="utf-8"><title>deep stability</title><body>${scripts.map((s) => `<script src="${s}"></script>`).join('')}`
const server = http.createServer((request, response) => {
  if (FILES[request.url]) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[request.url])
  if (PAGES[request.url]) return response.writeHead(200, { 'content-type': 'text/html' }).end(page(PAGES[request.url]))
  // the full Chromium build asks for an icon by itself; an answer with no content keeps a 404 out of the console
  if (request.url === '/favicon.ico') return response.writeHead(204).end()
  response.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
// what the rule must be here: WebKit is excluded whole; Blink and Gecko desktop read the geometry scene and the audio render
const RULE = { chromium: '', firefox: '', webkit: 'webkit' }[engineName]
const READS = RULE === ''
// a protected browser or an extension: canvas readback and audio channel data come back slightly different on every read
const NOISE = `(() => {
  const image = CanvasRenderingContext2D.prototype.getImageData
  CanvasRenderingContext2D.prototype.getImageData = function () {
    const out = image.apply(this, arguments)
    for (let i = 0; i < 8; i++) out.data[(Math.random() * out.data.length) | 0] ^= 1
    return out
  }
  if (typeof AudioBuffer === 'undefined') return
  const channel = AudioBuffer.prototype.getChannelData
  AudioBuffer.prototype.getChannelData = function () {
    const data = channel.apply(this, arguments)
    for (let i = 0; i < data.length; i++) data[i] += (Math.random() - 0.5) * 2e-7
    return data
  }
})()`
// what Brave adds to navigator, as a stub: the rule must follow the feature, whatever the user agent says
const BRAVE = `Object.defineProperty(Navigator.prototype, 'brave', { configurable: true, get: function () { return { isBrave: function () { return Promise.resolve(true) } } } })`

const checks = []
const notes = []
const consoleSeen = []
// the part of the run that is going on, so a browser notice can be tied to the setting that causes it
let phase = 'default'
// Notices a browser prints itself, each with the setting it belongs to and why. Any other message fails the run, and so does one of
// these outside its setting.
const NOTICES = [
  { engine: 'firefox', phase: 'privacy.resistFingerprinting', pattern: /from extracting canvas data because no user input was detected/, reason: 'Firefox under resistFingerprinting, for a canvas read outside a user-input handler; the pattern check reports the placeholder data as noise' },
]
// Firefox's own font-visibility warning in private browsing (lab/notices.mjs) is skipped in every phase, as lab/stability.mjs and
// lab/defer.mjs skip it: layout raises it for installed fonts its protection hides, not the library
const explained = (entry) => !!blockedFont(engineName, entry.text) || NOTICES.some((n) => n.engine === engineName && n.phase === entry.phase && n.pattern.test(entry.text))
const requests = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })
const start = (extra = {}) => playwright[engineName].launch({ ...launch.options, ...(exe ? { executablePath: exe } : {}), ...extra, args: [...(launch.options.args || []), ...(extra.args || [])] })
const open = async (browser, options = {}, scripts = []) => {
  const context = await browser.newContext(options)
  for (const script of scripts) await context.addInitScript(script)
  context.on('request', (request) => requests.push(request.url()))
  const tab = await context.newPage()
  tab.on('console', (message) => consoleSeen.push({ phase, text: `${message.type()}: ${message.text()}` }))
  tab.on('pageerror', (error) => consoleSeen.push({ phase, text: `pageerror: ${error.message}` }))
  return { context, tab }
}
const deep = async (tab, path = '/') => {
  await loadPage(tab, origin + path, { waitUntil: 'load' })
  return tab.evaluate('new Promise((resolve) => VisitoDeep.get(resolve))')
}
const core = async (tab, path = '/core') => {
  await loadPage(tab, origin + path, { waitUntil: 'load' })
  return tab.evaluate('new Promise((resolve) => Visito.get(resolve))')
}
/** Opens a new context, reads the deep entry once and closes it. */
const fresh = async (browser, options, scripts) => {
  const { context, tab } = await open(browser, options, scripts)
  try {
    return await deep(tab)
  } finally {
    await context.close()
  }
}
const parts = (r) => (r ? ['r.cg', 'r.ct', 'r.audio', 'r.cchk', 'r.achk', 'x.rule'].map((k) => `${k}=${r.c[k]}`).join(' ') : 'null')
const coreValues = (r) => JSON.stringify({ id: r.id, idStrict: r.idStrict, c: { ...r.c, 'x.private': undefined } })
const summary = { label, engine: engineName, gpu: launch.gpu, private: launch.privately, exe: exe || null }

let browser = await start()
summary.version = browser.version()
// a harness page that does not load ends the run with a FAIL line, after the checks so far (lab/launch.mjs)
let stopped = null
try {
  if (engineName === 'chromium') {
    // which rasteriser this run drew with, read by the harness itself and not by the library
    const probe = await open(browser)
    await loadPage(probe.tab, origin + '/core')
    summary.renderer = await probe.tab.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no WebGL'
    })
    notes.push(`renderer: ${summary.renderer}`)
    await probe.context.close()
  }

  const first = await open(browser)
  const readings = []
  for (let i = 0; i < 20; i++) readings.push(i ? await (async () => { await first.tab.reload({ waitUntil: 'load' }); return first.tab.evaluate('new Promise((resolve) => VisitoDeep.get(resolve))') })() : await deep(first.tab))
  await first.context.close()
  const base = readings[0]
  summary.base = base
  check('the reading is well formed and its id is the one Node recomputes', base && !deepProblems(base).length, base ? deepProblems(base).join('; ') : 'null')
  check(`the rule is ${JSON.stringify(RULE)}`, base && base.c['x.rule'] === RULE, parts(base))
  if (READS) {
    check('no check reports noise on an unprotected browser: a deep id from r.cg and r.audio, both values, r.ct "!ex", not weak',
      base && base.id && base.c['r.cchk'] === 'ok' && base.c['r.achk'] === 'ok' && base.c['r.ct'] === '!ex' && !base.flags.weak && !base.flags.excluded.length, parts(base))
  } else {
    check('excluded whole: every part "!ex", no id', base && base.id === null && base.flags.excluded.join() === 'r.audio,r.cg' && base.c['r.cchk'] === '!ex', parts(base))
  }
  const moving = ['r.cg', 'r.ct', 'r.audio', 'r.cchk', 'r.achk'].filter((k) => readings.some((r) => r.c[k] !== base.c[k]))
  check('20 reloads: one deep id, every part identical', !moving.length && readings.every((r) => r.id === base.id), `changed: ${moving.join(', ')}`)

  // 10 new contexts in this launch and 10 in a second one
  const contexts = []
  for (let i = 0; i < 10; i++) contexts.push(await fresh(browser))
  await browser.close()
  browser = await start()
  for (let i = 0; i < 10; i++) contexts.push(await fresh(browser))
  const otherIds = [...new Set(contexts.map((r) => r.id))]
  check('10 new contexts in each of 2 launches: the same deep id', otherIds.length === 1 && otherIds[0] === base.id, otherIds.join(', '))

  const variants = {}
  // Firefox reports Playwright's deviceScaleFactor in devicePixelRatio but does not draw at it; its real scale rows are further down
  if (engineName !== 'firefox') for (const scale of [1, 1.25, 1.5, 2]) variants[`deviceScaleFactor ${scale}`] = { deviceScaleFactor: scale }
  for (const locale of ['en-US', 'fa-IR', 'ja-JP', 'ar-EG', 'zh-CN']) variants[`page locale ${locale}`] = { locale }
  variants['forced colours'] = { forcedColors: 'active' }
  variants['dark scheme'] = { colorScheme: 'dark' }
  variants['reduced motion'] = { reducedMotion: 'reduce' }
  if (engineName === 'chromium') variants['phone emulation (a desktop build)'] = { viewport: { width: 393, height: 873 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true }
  summary.variants = {}
  for (const name of Object.keys(variants)) {
    const r = await fresh(browser, variants[name])
    summary.variants[name] = { id: r.id, parts: parts(r) }
    check(`${name}: the same deep id and rule`, r.id === base.id && r.c['x.rule'] === RULE, parts(r))
  }

  // the rule follows Brave's feature
  const braved = await fresh(browser, {}, [BRAVE])
  check(engineName === 'webkit' ? 'a navigator.brave stub: WebKit still wins' : 'a navigator.brave stub: rule "brave", nothing read', braved.c['x.rule'] === (engineName === 'webkit' ? 'webkit' : 'brave') && braved.id === null && braved.flags.excluded.join() === 'r.audio,r.cg', parts(braved))

  if (READS) {
    const noisy = await fresh(browser, {}, [NOISE])
    summary.noise = parts(noisy)
    check('injected canvas noise: r.cg is noise, no id', noisy.c['r.cg'] === '!noise' && noisy.c['r.ct'] === '!ex' && noisy.id === null && noisy.flags.noise.indexOf('r.cg') >= 0, parts(noisy))
    check('injected audio noise: the audio part is noise', noisy.c['r.audio'] === '!noise', parts(noisy))
  }

  // the core reading is the same with and without the deep entry on the page, and the deep id the same with and without the core
  const alone = await open(browser)
  const coreAlone = await core(alone.tab)
  await alone.context.close()
  const together = await open(browser)
  await loadPage(together.tab, origin + '/both', { waitUntil: 'load' })
  const pair = await together.tab.evaluate('Promise.all([new Promise((r) => Visito.get(r)), new Promise((r) => VisitoDeep.get(r))])')
  await together.context.close()
  check("the core's id, idStrict and values are the same with the deep entry on the page", coreValues(pair[0]) === coreValues(coreAlone), Object.keys(coreAlone.c).filter((k) => k !== 'x.private' && pair[0].c[k] !== coreAlone.c[k]).join(', '))
  check('the deep id is the same with the core on the page', pair[1].id === base.id, parts(pair[1]))
  check('the deep entry adds nothing to the core reading', !Object.keys(pair[0].c).some((k) => k.indexOf('r.') === 0 || k === 'x.rule'))

  if (READS) {
    // The display scale, text size and zoom a person sets, each in a new browser with a temporary profile holding that setting, read in
    // two new pages and again after a reload. Canvas text moved with them in Firefox on Windows and in Chromium on Linux, which is why
    // the deep entry does not read the text scene: the deep id must not move. Chromium runs as Playwright's full build, which keeps zoom settings,
    // on the GPU or with it switched off to match this run's rasteriser.
    await browser.close()
    summary.scale = {}
    const scratch = mkdtempSync(join(tmpdir(), 'visito-deep-scale-'))
    try {
      const settings = SCALE_SETTINGS[engineName]
      let n = 0
      const persistent = async (setting) => {
        const dir = await profileWith(engineName, setting, join(scratch, String(n++)))
        // headed, Chromium draws on the GPU as the base reading did, so the software switch stays off
        const shown = launch.headed ? { headless: false } : {}
        const options = engineName === 'firefox'
          ? { viewport: null, ...shown, firefoxUserPrefs: { ...(launch.options.firefoxUserPrefs || {}), ...(setting.prefs || {}) } }
          : { viewport: null, ...shown, ...(exe ? { executablePath: exe } : { channel: 'chromium' }), args: [...(launch.options.args || []), ...(launch.gpu || exe || launch.headed ? [] : ['--disable-gpu']), ...(setting.args || [])] }
        const context = await playwright[engineName].launchPersistentContext(dir, options)
        context.on('request', (request) => requests.push(request.url()))
        const got = []
        try {
          for (let i = 0; i < 2; i++) {
            const tab = await context.newPage()
            tab.on('console', (message) => consoleSeen.push({ phase, text: `${message.type()}: ${message.text()}` }))
            tab.on('pageerror', (error) => consoleSeen.push({ phase, text: `pageerror: ${error.message}` }))
            await loadPage(tab, origin + '/', { waitUntil: 'load' })
            const once = () => tab.evaluate('new Promise((resolve) => VisitoDeep.get((r) => resolve({ r: r, dpr: devicePixelRatio })))')
            got.push(await once())
            if (i) {
              await tab.reload({ waitUntil: 'load' })
              got.push(await once())
            }
            await tab.close()
          }
        } finally {
          await context.close()
        }
        return got
      }
      for (const name of Object.keys(settings)) {
        phase = name
        const got = await persistent(settings[name])
        const ids = [...new Set(got.map((g) => g.r.id))]
        summary.scale[name] = { dpr: [...new Set(got.map((g) => g.dpr))], ids, parts: [...new Set(got.map((g) => parts(g.r)))] }
        check(`${name} (devicePixelRatio ${summary.scale[name].dpr.join('/')}), 3 readings: the same deep id and rule`, ids.length === 1 && ids[0] === base.id && got.every((g) => g.r.c['x.rule'] === RULE), summary.scale[name].parts.join(' | '))
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      phase = 'default'
    }
    browser = await start()
  }

  if (engineName === 'chromium' && !exe) {
    // Chromium's interface language moved the text scene's value in a headed browser (docs/DECISIONS.md); the deep entry does not read
    // it, so the deep id must be the same under every interface language, headless and headed
    summary.lang = {}
    for (const lang of ['ar', 'ja', 'zh-CN', 'ko', 'th', 'de']) {
      await browser.close()
      browser = await start({ args: [`--lang=${lang}`] })
      const r = await fresh(browser)
      summary.lang[lang] = { id: r.id, parts: parts(r) }
      check(`Chromium --lang=${lang}${launch.headed ? ', headed' : ''}: the same deep id`, !!r && r.id === base.id, parts(r))
    }
  }

  if (engineName === 'firefox' && !launch.privately) {
    // Firefox's protections, one launch each: the older randomisation and resistFingerprinting must be noise; the efficient
    // variant leaves getImageData alone in this build, which is the tripwire: if Gecko extends it to getImageData this row fails
    const FP = 'privacy.fingerprintingProtection'
    const prefs = {
      '+CanvasRandomization': { want: 'noise', prefs: { [FP]: true, [FP + '.overrides']: '-AllTargets,+CanvasRandomization' } },
      'privacy.resistFingerprinting': { want: 'noise', prefs: { 'privacy.resistFingerprinting': true } },
      '+EfficientCanvasRandomization (tripwire)': { want: 'same', prefs: { [FP]: true, [FP + '.overrides']: '-AllTargets,+EfficientCanvasRandomization' } },
      'fingerprinting protection, default targets': { want: 'same', prefs: { [FP]: true } },
      'browser.privatebrowsing.autostart': { want: 'same', prefs: { 'browser.privatebrowsing.autostart': true } },
    }
    summary.prefs = {}
    for (const name of Object.keys(prefs)) {
      await browser.close()
      phase = name
      browser = await playwright.firefox.launch({ firefoxUserPrefs: prefs[name].prefs })
      const r = await fresh(browser)
      summary.prefs[name] = parts(r)
      const ok = prefs[name].want === 'noise' ? r.c['r.cg'] === '!noise' && r.c['r.cchk'] === 'pattern' && r.id === null : r.id === base.id
      check(`Firefox ${name}: ${prefs[name].want === 'noise' ? 'canvas noise ("pattern"), no id' : 'the same deep id'}`, ok, parts(r))
    }
  }
} catch (error) {
  stopped = error
} finally {
  await browser.close()
  server.close()
}

const elsewhere = requests.filter((url) => !url.startsWith(origin + '/'))
const unexpected = requests.filter((url) => url.startsWith(origin + '/') && !(url.slice(origin.length) in FILES) && !(url.slice(origin.length) in PAGES))
check('no request leaves the page: only the page and its scripts are fetched', !elsewhere.length && !unexpected.length, [...elsewhere, ...unexpected].slice(0, 5).join(' '))
const unexplained = consoleSeen.filter((entry) => !explained(entry))
check('nothing is written to the console and no page error, beyond the listed browser notices', !unexplained.length, unexplained.slice(0, 5).map((e) => `[${e.phase}] ${e.text}`).join(' | '))
for (const n of NOTICES) {
  const count = consoleSeen.filter((e) => n.engine === engineName && n.phase === e.phase && n.pattern.test(e.text)).length
  if (count) notes.push(`browser notice, ${count} times, under ${n.phase}: ${n.reason}`)
}
const fonts = [...new Set(consoleSeen.map((e) => blockedFont(engineName, e.text)).filter(Boolean))]
if (fonts.length) notes.push(`Firefox's font-visibility warning, skipped, for: ${fonts.join(', ')}`)
summary.checks = checks
summary.notes = notes
writeFileSync(new URL(`./report/raw/deep-stability-${label}.json`, import.meta.url), JSON.stringify(summary, null, 1))
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : '  <- ' + c.detail}`)
for (const note of notes) console.log(`note ${note}`)
console.log(`base: id ${summary.base && summary.base.id} ${parts(summary.base)}`)
if (stopped) stopOnPageLoad(stopped)
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${label} ${summary.version}: ${checks.length - failed} of ${checks.length} deep stability checks pass`)
process.exit(failed ? 1 : 0)
