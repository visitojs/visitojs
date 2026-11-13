// How many deep ids one machine gives in Chromium across its rasterisers: software (Playwright's default), the GPU through each
// ANGLE backend, and the GPU switched off. Three new contexts per launch, two launches per setting.
// Usage: node lab/deep-backends.mjs [--exe <installed Chromium-based browser> --label <name>]
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const exe = arg('exe')
const label = exe ? arg('label', 'installed') : 'chromium'
const bundle = readFileSync(new URL('../dist/deep.min.js', import.meta.url))
const server = http.createServer((request, response) => {
  if (request.url === '/deep.min.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>backends</title><body><script src="/deep.min.js"></script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const GPU = ['--enable-gpu', '--ignore-gpu-blocklist']
const SETTINGS = {
  default: [],
  'gpu, ANGLE d3d11': [...GPU, '--use-angle=d3d11'],
  'gpu, ANGLE d3d9': [...GPU, '--use-angle=d3d9'],
  'gpu, ANGLE gl': [...GPU, '--use-angle=gl'],
  'gpu, ANGLE vulkan': [...GPU, '--use-angle=vulkan'],
  'gpu, ANGLE swiftshader': [...GPU, '--use-angle=swiftshader'],
  '--disable-gpu': ['--disable-gpu'],
}
const rows = []
for (const name of Object.keys(SETTINGS)) {
  const seen = []
  let renderer = null
  let version = null
  for (let launch = 0; launch < 2; launch++) {
    const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: SETTINGS[name] })
    version = browser.version()
    try {
      for (let i = 0; i < 3; i++) {
        const context = await browser.newContext()
        const tab = await context.newPage()
        await tab.goto(url, { waitUntil: 'load' })
        const r = await tab.evaluate('new Promise((resolve) => VisitoDeep.get(resolve))')
        if (!renderer) {
          renderer = await tab.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl')
            const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
            return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no WebGL'
          })
        }
        seen.push({ id: r.id, cg: r.c['r.cg'], audio: r.c['r.audio'], cchk: r.c['r.cchk'], achk: r.c['r.achk'] })
        await context.close()
      }
    } finally {
      await browser.close()
    }
  }
  const distinct = (key) => [...new Set(seen.map((s) => s[key]))]
  rows.push({ setting: name, version, renderer, ids: distinct('id'), cg: distinct('cg'), audio: distinct('audio'), cchk: distinct('cchk'), achk: distinct('achk') })
}
server.close()
for (const row of rows) console.log(`${row.setting.padEnd(24)} ids ${row.ids.map((id) => (id ? id.slice(0, 12) : 'null')).join('/')}  r.cg ${row.cg.join('/')}  r.audio ${row.audio.join('/')}  checks ${row.cchk.join('/')} ${row.achk.join('/')}  (${row.renderer})`)
const all = new Set(rows.flatMap((row) => row.ids))
console.log(`${label} ${rows[0] && rows[0].version}: ${all.size} distinct deep ids over ${rows.length} settings`)
writeFileSync(new URL(`./report/raw/deep-backends-${label}.json`, import.meta.url), JSON.stringify({ label, rows }, null, 1))
