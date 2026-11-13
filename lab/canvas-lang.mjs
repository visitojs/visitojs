// Measures whether a lang attribute on the detached canvases pins the text scene (r.ct) against the browser's own interface
// language. Chromium takes its font fallback for a canvas with no language from its UI language (docs/DECISIONS.md), so r.ct
// moves with --lang; the HTML Standard lets a canvas context take its language from the canvas element's lang attribute.
// Each variant is applied from outside the library, on every canvas the page creates, before any context exists.
// Usage: node lab/canvas-lang.mjs [chromium|firefox] [--gpu] [--exe <browser executable> --label <name>] [--langs en-US,de,ar,...] [--headed]
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { launchFrom } from './launch.mjs'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const engineName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chromium'
const exe = arg('exe')
const launch = launchFrom(engineName, process.argv)
const label = arg('label', exe ? 'installed' : engineName) + launch.suffix
const LANGS = arg('langs', engineName === 'chromium' ? 'en-US,de,ru,ar,fa,ur,ja,zh-CN,ko,th,hi' : '').split(',').filter(Boolean)
// the lab build: the deep entry draws no text
const FILE = 'visito.lab.min.js'
const bundle = readFileSync(new URL(`../dist/${FILE}`, import.meta.url))
const CALL = 'Visito.get(resolve)'
const page = `<!doctype html><meta charset="utf-8"><title>lang</title><body><script src="/b.js"></script>`
const server = http.createServer((request, response) => {
  if (request.url === '/b.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end(page)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

// none: as shipped. attr: lang="en" on each canvas element. context: the 2D context's own lang property, where it exists.
// without: the builds now set lang="en" themselves; this drops the attribute and answers its read-back with "en", the control.
const VARIANTS = {
  none: '',
  attr: `(() => { const make = Document.prototype.createElement; Document.prototype.createElement = function (tag) { const e = make.apply(this, arguments); if (String(tag).toLowerCase() === 'canvas') e.setAttribute('lang', 'en'); return e } })()`,
  without: `(() => { const set = Element.prototype.setAttribute, get = Element.prototype.getAttribute; const own = (e, n) => e instanceof HTMLCanvasElement && String(n).toLowerCase() === 'lang'; Element.prototype.setAttribute = function (n) { if (!own(this, n)) return set.apply(this, arguments) }; Element.prototype.getAttribute = function (n) { return own(this, n) ? 'en' : get.apply(this, arguments) } })()`,
  context: `(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function () { const c = get.apply(this, arguments); if (c && 'lang' in c) c.lang = 'en'; return c } })()`,
}

const rows = []
const launches = LANGS.length ? LANGS : ['']
for (const lang of launches) {
  const browser = await playwright[engineName].launch({ ...(exe ? { executablePath: exe } : {}), ...(launch.headed ? { headless: false } : {}), args: [...(launch.options.args || []), ...(lang ? [`--lang=${lang}`] : [])] })
  try {
    for (const variant of Object.keys(VARIANTS)) {
      const seen = []
      for (let i = 0; i < 3; i++) {
        const context = await browser.newContext()
        if (VARIANTS[variant]) await context.addInitScript(VARIANTS[variant])
        const tab = await context.newPage()
        await tab.goto(url, { waitUntil: 'load' })
        const r = await tab.evaluate(`new Promise((resolve) => ${CALL})`)
        const ui = await tab.evaluate(() => [navigator.language, 'lang' in CanvasRenderingContext2D.prototype])
        seen.push({ ct: r.c['r.ct'], cg: r.c['r.cg'], cchk: r.c['r.cchk'], ui })
        await context.close()
      }
      const cts = [...new Set(seen.map((s) => s.ct))]
      rows.push({ lang, variant, ct: cts, cg: [...new Set(seen.map((s) => s.cg))], cchk: [...new Set(seen.map((s) => s.cchk))], navigatorLanguage: seen[0].ui[0], contextHasLang: seen[0].ui[1] })
    }
    rows[rows.length - 1].version = browser.version()
  } finally {
    await browser.close()
  }
}
server.close()
for (const row of rows) console.log(`${(row.lang || '(default)').padEnd(8)} ${row.variant.padEnd(8)} r.ct ${row.ct.join('/')}  r.cg ${row.cg.join('/')}  r.cchk ${row.cchk.join('/')}  navigator.language ${row.navigatorLanguage}  ctx.lang ${row.contextHasLang}`)
for (const variant of Object.keys(VARIANTS)) {
  const values = new Set(rows.filter((r) => r.variant === variant).flatMap((r) => r.ct))
  console.log(`${variant}: ${values.size} distinct r.ct over ${launches.length} interface languages`)
}
writeFileSync(new URL(`./report/raw/canvas-lang-${label}.json`, import.meta.url), JSON.stringify({ engine: engineName, label, build: 'lab', rows }, null, 1))
