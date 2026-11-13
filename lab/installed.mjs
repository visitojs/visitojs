// Reads the rendering values of the lab build, or the deep entry's reading, in a browser installed on this machine, started by
// Playwright with a temporary profile of its own (never the user's profile), in two launches of three contexts with one reload each.
// Usage: node lab/installed.mjs --exe <browser executable> --label <name> [--build lab|deep]
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const exe = arg('exe')
if (!exe) throw new Error('--exe is required')
const label = arg('label', 'installed')
const DEEP = arg('build', 'lab') === 'deep'
const bundle = readFileSync(new URL(DEEP ? '../dist/deep.min.js' : '../dist/visito.lab.min.js', import.meta.url))
const server = http.createServer((request, response) => {
  if (request.url === '/b.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>installed</title><body><script src="/b.js"></script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const KEYS = DEEP ? ['x.rule', 'r.cg', 'r.cchk', 'r.audio', 'r.achk'] : ['x.engine', 'x.ev.brave', 'r.cg', 'r.ct', 'r.cchk', 'r.cgcpu', 'r.ctcpu', 'r.audio', 'r.achk', 'r.math']
const rows = []
let version = null
for (let launch = 0; launch < 2; launch++) {
  const browser = await chromium.launch({ executablePath: exe })
  version = browser.version()
  try {
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'load' })
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await page.reload({ waitUntil: 'load' })
        const r = await page.evaluate(DEEP ? 'new Promise((resolve) => VisitoDeep.get(resolve))' : 'new Promise((resolve) => Visito.get(resolve))')
        const row = { launch, context: i, reload }
        for (const key of KEYS) row[key] = r.c[key]
        if (DEEP) Object.assign(row, { id: r.id, flags: r.flags })
        rows.push(row)
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
server.close()
for (const row of rows) console.log(JSON.stringify(row))
for (const key of KEYS) console.log(`${key}: ${[...new Set(rows.map((r) => r[key]))].join(' / ')}`)
console.log(`${label} ${version}, ${DEEP ? 'deep entry' : 'lab build'}, ${rows.length} readings`)
writeFileSync(new URL(`./report/raw/installed-${label}-${DEEP ? 'deep' : 'lab'}.json`, import.meta.url), JSON.stringify({ label, version, deep: DEEP, rows }, null, 1))
