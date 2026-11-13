// What a person's display and zoom settings do to the deep entry's parts on one machine: the display scale (the browser's own
// preference or launch switch for it), the text size, and page zoom, both the default zoom and a zoom kept for the site, which is
// what the zoom keys and menu store. Each setting is a new browser with a temporary profile of its own, written before launch, and
// is read in two new pages and once more after a reload. The page reports devicePixelRatio so a setting that did not take is seen.
// It reports; it does not pass or fail. lab/deep-stability.mjs pins the outcomes.
// Usage: node lab/deep-scale.mjs [chromium|firefox] [--gpu] [--exe <installed Chromium-based browser> --label <name>]
// Chromium runs as Playwright's full build (channel "chromium"): the headless shell keeps no zoom preferences. That build draws on
// the GPU by default, so without --gpu it gets --disable-gpu, which gives the software values of the headless shell (deep-backends.mjs).
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as playwright from 'playwright'
import { launchFrom } from './launch.mjs'
import { profileWith, SCALE_SETTINGS } from './scale-settings.mjs'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const engineName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chromium'
const launch = launchFrom(engineName, process.argv)
const exe = arg('exe')
const label = (exe ? arg('label', 'installed') : engineName) + launch.suffix
const bundle = readFileSync(new URL('../dist/deep.min.js', import.meta.url))
const server = http.createServer((request, response) => {
  if (request.url === '/deep.min.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>scale</title><body><script src="/deep.min.js"></script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
// the rasteriser, read by the harness and not by the library, so a run that fell back to software is seen
const RENDERER = "(() => { try { const gl = document.createElement('canvas').getContext('webgl'); const i = gl && gl.getExtension('WEBGL_debug_renderer_info'); return i ? gl.getParameter(i.UNMASKED_RENDERER_WEBGL) : 'no WebGL' } catch (e) { return 'no WebGL' } })()"
const READ = `new Promise((resolve) => VisitoDeep.get((r) => resolve({ r: r, dpr: devicePixelRatio, width: innerWidth, renderer: ${RENDERER} })))`
const KEYS = ['r.cg', 'r.audio', 'r.cchk', 'r.achk', 'x.rule']

const rows = []
let version = null
const settings = SCALE_SETTINGS[engineName === 'firefox' ? 'firefox' : 'chromium']
const scratch = mkdtempSync(join(tmpdir(), 'visito-scale-'))
try {
  for (const name of Object.keys(settings)) {
    const setting = settings[name]
    const dir = await profileWith(engineName, setting, join(scratch, String(rows.length)))
    const options = engineName === 'firefox'
      ? { viewport: null, firefoxUserPrefs: { ...(launch.options.firefoxUserPrefs || {}), ...(setting.prefs || {}) } }
      : { viewport: null, ...(exe ? { executablePath: exe } : { channel: 'chromium' }), args: [...(launch.options.args || []), ...(launch.gpu || exe ? [] : ['--disable-gpu']), ...(setting.args || [])] }
    const context = await playwright[engineName].launchPersistentContext(dir, options)
    try {
      version = context.browser() ? context.browser().version() : version
      const seen = []
      for (let i = 0; i < 2; i++) {
        const tab = await context.newPage()
        await tab.goto(url, { waitUntil: 'load' })
        seen.push(await tab.evaluate(READ))
        if (i === 1) {
          await tab.reload({ waitUntil: 'load' })
          seen.push(await tab.evaluate(READ))
        }
        await tab.close()
      }
      for (const s of seen) {
        const row = { setting: name, dpr: s.dpr, width: s.width, renderer: s.renderer, id: s.r && s.r.id }
        for (const key of KEYS) row[key] = s.r && s.r.c[key]
        rows.push(row)
      }
    } finally {
      await context.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
} finally {
  server.close()
  rmSync(scratch, { recursive: true, force: true })
}

const base = rows[0]
const short = (v) => (typeof v === 'string' && v.length > 16 ? v.slice(0, 16) : v)
console.log(`${label} ${version || ''}: ${rows.length} readings; "=" is the value of the first setting; renderer ${[...new Set(rows.map((r) => r.renderer))].join(' / ')}`)
for (const name of Object.keys(settings)) {
  const mine = rows.filter((r) => r.setting === name)
  const one = (key) => {
    const values = [...new Set(mine.map((r) => r[key]))]
    return values.map((v) => (v === base[key] ? '=' : short(v))).join('/')
  }
  console.log(`${name.padEnd(34)} dpr ${[...new Set(mine.map((r) => r.dpr))].join('/')}  id ${one('id')}  cg ${one('r.cg')}  audio ${one('r.audio')}  checks ${one('r.cchk')},${one('r.achk')}`)
}
mkdirSync(new URL('./report/raw/', import.meta.url), { recursive: true })
writeFileSync(new URL(`./report/raw/deep-scale-${label}.json`, import.meta.url), JSON.stringify({ label, version, rows }, null, 1))
