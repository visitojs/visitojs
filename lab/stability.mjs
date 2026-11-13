// Checks that what should stay the same does: across reloads, fresh storage, an app update, rotation, and under injected noise.
// Usage: node lab/stability.mjs [chromium|firefox|webkit] [--gpu | --private]   (the options are in lab/launch.mjs)
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { launchFrom, loadPage, stopOnPageLoad } from './launch.mjs'
import { BROWSER_NOTICES, noticeFor as browserNotice } from './notices.mjs'
import { PHONE } from './phone.mjs'
import { problems } from './schema.mjs'

const engineName = process.argv[2] || 'chromium'
const launch = launchFrom(engineName, process.argv)
const GPU = launch.gpu
// the lab build reads everything fresh on each view, so it is the one that can show a value moving; the product build is checked for its cache
const FILES = {
  '/visito.min.js': readFileSync(new URL('../dist/visito.min.js', import.meta.url)),
  '/visito.lab.min.js': readFileSync(new URL('../dist/visito.lab.min.js', import.meta.url)),
  '/visito.defer.min.js': readFileSync(new URL('../dist/visito.defer.min.js', import.meta.url)),
}
// the deferred build, started by the page in stored mode and with store: false: its ids must be the other builds' in every scenario
const DEFERRED = { '/defer': 'Visito.start()', '/defer-bare': 'Visito.start({ store: false })' }
const page = (file, start) => `<!doctype html><meta charset="utf-8"><title>stability</title><body><script src="${file}"></script>` + (start ? `<script>${start}</script>` : '')
const UPDATED = PHONE.userAgent.replace('FBAV/585.0.0.47.54', 'FBAV/586.0.0.1.1').replace('Chrome/156.0.8078.50', 'Chrome/157.0.8100.3')
// what a protected browser or an extension does: canvas readback and audio channel data come back slightly different on every read
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
const server = http.createServer((request, response) => {
  if (FILES[request.url]) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[request.url])
  if (DEFERRED[request.url]) return response.writeHead(200, { 'content-type': 'text/html' }).end(page('/visito.defer.min.js', DEFERRED[request.url]))
  response.writeHead(200, { 'content-type': 'text/html' }).end(page(request.url === '/product' ? '/visito.min.js' : '/visito.lab.min.js'))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const productUrl = url + 'product'
/** Reads the deferred build in both modes in this page's context and compares its ids with `reading`, the lab build's there. */
const deferredSame = async (scenario, page, reading) => {
  const stored = await read(page, url + 'defer')
  const bare = await read(page, url + 'defer-bare')
  check(`${scenario}: the deferred build's ids, in stored mode and with store: false`, !!reading.id && stored.id === reading.id && stored.idStrict === reading.idStrict && bare.id === reading.id && bare.idStrict === reading.idStrict, `${stored.id} ${bare.id} vs ${reading.id}`)
  check(`${scenario}: the deferred build with store: false reports no stored id`, bare.did === null && !('x.private' in bare.c))
}
// Firefox has no mobile emulation in Playwright
const device = engineName === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE

const browser = await playwright[engineName].launch(launch.options)
// every console message and page error from any page this run opens: the library must write none
const consoleSeen = []
// Notices a browser prints itself (lab/notices.mjs), each named with its engine and reason. Any other message fails the run, and so
// does one of these from a rendering read.
const noticeFor = (text) => browserNotice(engineName, text)
const read = async (page, address = url) => {
  await loadPage(page, address, { waitUntil: 'load' })
  return page.evaluate(() => new Promise((resolve) => Visito.get(resolve)))
}
const open = async (options = {}, scripts = []) => {
  const context = await browser.newContext({ ...device, ...options })
  for (const script of scripts) await context.addInitScript(script)
  const page = await context.newPage()
  page.on('console', (message) => consoleSeen.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => consoleSeen.push(`pageerror: ${error.message}`))
  return { context, page }
}
const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })
// the private-window answer belongs to one visit: it is not part of what must stay the same
const values = (reading) => JSON.stringify({ ...reading.c, 'x.private': undefined })
const notes = []

// a harness page that does not load ends the run with a FAIL line, after the checks so far (lab/launch.mjs)
let stopped = null
try {
  if (GPU) {
    // which rasteriser this run drew with, read by the harness itself and not by the library
    const probe = await open()
    await loadPage(probe.page, url + 'probe')
    const renderer = await probe.page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no WebGL'
    })
    notes.push(`GPU run, renderer: ${renderer}`)
    await probe.context.close()
    consoleSeen.length = 0
  }
  const first = await open()
  const readings = []
  for (let i = 0; i < 20; i++) readings.push(await read(first.page))
  const base = readings[0]
  check('the reading is well formed', !problems(base).length, problems(base).join('; '))
  check('no read failed', !base.flags.partial.length, base.flags.partial.join(', '))
  const moving = Object.keys(base.c).filter((key) => readings.some((r) => r.c[key] !== base.c[key]))
  check('20 reloads: every value is identical', !moving.length, `changed: ${moving.join(', ')}`)
  check('20 reloads: one id, one strict id, one stored id', readings.every((r) => r.id === base.id && r.idStrict === base.idStrict && r.did === base.did) && !!base.id && !!base.idStrict && !!base.did)
  check('the stored id is new only on the first view', base.didNew && readings.slice(1).every((r) => !r.didNew))
  const deferredHere = await read(first.page, url + 'defer')
  check('the deferred build in the same storage: the stored id the lab build made', deferredHere.did === base.did && !deferredHere.didNew)
  await deferredSame('20 reloads', first.page, base)
  await first.context.close()

  const fresh = await open()
  const other = await read(fresh.page)
  check('fresh storage (a private window): same id and strict id', other.id === base.id && other.idStrict === base.idStrict)
  // with every read on, this lists what a browser changes per session: the evidence for keeping those values out of the id
  const perSession = Object.keys(base.c).filter((k) => k !== 'x.private' && other.c[k] !== base.c[k])
  if (perSession.length) notes.push(`lab build: differs between two fresh storages: ${perSession.join(', ')}`)
  check('fresh storage: a new stored id, marked new', other.did !== base.did && other.didNew)
  await deferredSame('fresh storage', fresh.page, other)
  await fresh.context.close()

  const updated = await open({ userAgent: UPDATED })
  const after = await read(updated.page)
  check('app and browser update: same id, new strict id', after.id === base.id && !!after.idStrict && after.idStrict !== base.idStrict)
  check('app and browser update: the version fields moved', after.appVer === '586.0.0.1.1' && after.engineVer === 157)
  await deferredSame('app and browser update', updated.page, after)
  await updated.context.close()

  const rotated = await open({ viewport: { width: PHONE.viewport.height, height: PHONE.viewport.width } })
  const sideways = await read(rotated.page)
  check('rotation: same id and same screen value', sideways.id === base.id && sideways.c['x.scr'] === base.c['x.scr'], `${sideways.c['x.scr']} vs ${base.c['x.scr']}`)
  await deferredSame('rotation', rotated.page, sideways)
  await rotated.context.close()
  // no false noise: an unprotected engine reads its own pattern and known answer back exactly
  const rendered = ['r.math', 'r.cg', 'r.ct', 'r.cgcpu', 'r.ctcpu', 'r.audio'].filter((k) => !/^[0-9a-f]{16}$/.test(base.c[k]))
  const lacksAudio = base.c['r.audio'] === '!na'
  check('rendering values are values, not statuses', rendered.every((k) => k === 'r.audio' && lacksAudio), rendered.map((k) => `${k}=${base.c[k]}`).join(', '))
  check('no check reports noise on an unprotected browser', base.c['r.cchk'] === 'ok' && base.c['r.achk'] === (lacksAudio ? '!na' : 'ok'), `r.cchk=${base.c['r.cchk']} r.achk=${base.c['r.achk']}`)
  if (lacksAudio) notes.push('this build has no OfflineAudioContext: r.audio is !na')
  const noisy = await open({}, [NOISE])
  const altered = await read(noisy.page)
  check('injected canvas noise is reported as noise', altered.c['r.cg'] === '!noise' && altered.c['r.ct'] === '!noise', `${altered.c['r.cg']} ${altered.c['r.ct']} (${altered.c['r.cchk']})`)
  check('injected audio noise is reported as noise', altered.c['r.audio'] === (lacksAudio ? '!na' : '!noise'), `${altered.c['r.audio']} (${altered.c['r.achk']})`)
  check('noise in the rendering values leaves the ids alone', altered.id === base.id && altered.idStrict === base.idStrict)
  await deferredSame('injected noise', noisy.page, altered)
  await noisy.context.close()

  // product build: the same ids as the lab build, and the second view must come from the cache and run no read
  const cached = await open()
  const one = await read(cached.page, productUrl)
  check('product build: the ids the lab build reports', one.id === base.id && one.idStrict === base.idStrict)
  check('product build: no rendering or locale read', !Object.keys(one.c).some((k) => k.startsWith('r.') || k === 'x.tz') && !Object.keys(one.t).some((k) => k === 'canvas' || k.indexOf('canvas:') === 0), Object.keys(one.t).join(','))
  const elsewhere = await open()
  const again = await read(elsewhere.page, productUrl)
  check('product build, fresh storage: same values and same id', values(again) === values(one) && again.id === one.id, Object.keys(one.c).filter((k) => k !== 'x.private' && again.c[k] !== one.c[k]).join(', '))
  await elsewhere.context.close()
  const two = await read(cached.page, productUrl)
  check('product build: the second view is served from the cache', 'cache' in two.t && !('text' in two.t) && !('cache' in one.t), JSON.stringify(two.t))
  check('product build: cached values and ids equal the first view', values(two) === values(one) && two.id === one.id && two.idStrict === one.idStrict)
  // the two builds share the cache, so a site that mixes them stays consistent; store: false neither reads it nor writes it
  const shared = await read(cached.page, url + 'defer')
  check('deferred build after the product build: served from the shared cache, same ids', 'cache' in shared.t && shared.id === one.id && shared.idStrict === one.idStrict, JSON.stringify(shared.t))
  const unshared = await read(cached.page, url + 'defer-bare')
  check('deferred build with store: false after the product build: read fresh, same ids', !('cache' in unshared.t) && unshared.id === one.id && unshared.idStrict === one.idStrict, JSON.stringify(unshared.t))
  await cached.context.close()

  const unexplained = consoleSeen.filter((text) => !noticeFor(text))
  check('nothing is written to the console, by either build, beyond the listed browser notices', !unexplained.length, unexplained.slice(0, 5).join(' | '))
  check('the rendering reads write nothing to the console', !consoleSeen.some((text) => /canvas|getImageData|readback|audio/i.test(text)), consoleSeen.filter((text) => /canvas|getImageData|readback|audio/i.test(text)).slice(0, 3).join(' | '))
  for (const notice of BROWSER_NOTICES) {
    const count = consoleSeen.filter((text) => notice.engine === engineName && notice.pattern.test(text)).length
    if (count) notes.push(`browser notice, ${count} times: ${notice.reason}`)
  }

  writeFileSync(new URL(`./report/raw/stability-${engineName}${launch.suffix}.json`, import.meta.url), JSON.stringify({ engine: engineName, gpu: GPU, private: launch.privately, version: browser.version(), base, normal: one, checks, notes, console: consoleSeen }, null, 1))
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
console.log(`\n${engineName} ${browser.version()}${launch.label}: ${checks.length - failed} of ${checks.length} stability checks pass`)
process.exit(failed ? 1 : 0)
