// Compares two builds on a page that has replaced, with a wrong-value form, one built-in the user-agent parser calls.
// Each build loads in its own fresh context under the same tamper; then a second page in that context, with the
// tamper gone, shows whether anything wrong outlived it. The current build may differ from the reference only where it
// has the untampered value, its reading is never missing where the reference has one, and its id after the tampering
// is never wrong where the reference's is right. Tampers are in lab/tampers.mjs.
// Usage (after npm run build): node lab/tamper-diff.mjs <chromium|firefox|webkit> <reference bundle>
// BUNDLE picks the current build (default dist/visito.min.js); a reference is origin/main's dist built the same way.
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { TAMPERS, install, compare } from './tampers.mjs'

const engineName = process.argv[2] || 'chromium'
if (!process.argv[3]) {
  console.error('usage: node lab/tamper-diff.mjs <engine> <reference bundle>')
  process.exit(2)
}
const LAB = /\.lab\./.test(process.env.BUNDLE || '')
const FILES = { '/ref.js': readFileSync(process.argv[3]), '/cur.js': readFileSync(process.env.BUNDLE || new URL('../dist/visito.min.js', import.meta.url)) }
const SETTLE_MS = 5000
const PARALLEL = Number(process.env.PARALLEL || 6)
// the reading's own fields; did, ms and t change on every view
const SAME = ['id', 'idStrict', 'model', 'os', 'osVer', 'app', 'appVer', 'engineVer', 'flags']
// synthetic: the fault matrix's phone, its section left open, the reduced form, and a desktop Firefox
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/585.0.0.47.54;IABMV/1;]',
  'Mozilla/5.0 (Linux; Android 12; SM-X135FU Build/SP1A.210812.016; wv Version/4.0 Chrome/156.0.8078.50 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
]

const page = (file) => `<!doctype html><meta charset="utf-8"><title>tamper</title>
<script src="${file}"></script>
<script>
(function () {
  var done = function () { window.__undo && window.__undo(); window.__undo = null; console.log('VISITO_DONE') }
  try { window.__sync = Visito.getSync() } catch (e) { window.__threw = 'getSync: ' + e }
  try { Visito.get(function (r) { window.__got = r; done() }) } catch (e) { window.__threw = 'get: ' + e; done() }
  setTimeout(done, ${SETTLE_MS - 1000})
})()
</script>`

const server = http.createServer((request, response) => {
  const file = request.url.slice(0, 7)
  if (FILES[file]) return response.writeHead(200, { 'content-type': 'application/javascript' }).end(FILES[file])
  response.writeHead(200, { 'content-type': 'text/html' }).end(page(request.url.indexOf('ref') >= 0 ? '/ref.js' : '/cur.js'))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

// a page that never finishes counts as no reading; the harness gives up on it rather than wait
const HUNG = { hung: true }
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(HUNG), ms))])
let version = ''

// one view; a tamper is installed before any page script and lifted by the page once the reading is in
async function view(context, build, tamper) {
  const tab = await context.newPage()
  if (tamper) await tab.addInitScript(`window.__undo = ${install(tamper)}`)
  const finished = new Promise((resolve) => tab.on('console', (message) => message.text() === 'VISITO_DONE' && resolve()))
  const seen = await within(
    (async () => {
      await tab.goto(base + build, { waitUntil: 'load', timeout: SETTLE_MS * 2 })
      await Promise.race([finished, tab.waitForTimeout(SETTLE_MS)])
      return tab.evaluate(() => ({ got: window.__got || null, threw: window.__threw || null }))
    })().catch(() => HUNG),
    SETTLE_MS * 3,
  )
  if (seen === HUNG) return HUNG
  return seen.threw ? null : seen.got
}

// a tampered view, then a clean one in the same storage. Each visit has a browser of its own: a page that loops
// forever can take a whole engine down with it, and must not take the next row too.
async function visit(userAgent, build, tamper) {
  const browser = await playwright[engineName].launch()
  version = browser.version()
  try {
    const result = await within(
      (async () => {
        const context = await browser.newContext({ userAgent })
        const first = await view(context, build, tamper)
        if (first === HUNG) return HUNG
        const next = await view(context, build, null)
        return { first, next: next === HUNG ? null : next, hung: false }
      })().catch(() => HUNG),
      SETTLE_MS * 8,
    )
    return result === HUNG ? { first: null, next: null, hung: true } : result
  } finally {
    await within(browser.close().catch(() => {}), SETTLE_MS * 2)
  }
}

const rows = []
let failed = 0
try {
  for (const userAgent of USER_AGENTS) {
    const clean = (await visit(userAgent, 'cur', null)).first
    const again = (await visit(userAgent, 'cur', null)).first
    const refClean = (await visit(userAgent, 'ref', null)).first
    // values of c that differ between two fresh contexts are left out, as in the fault matrix
    const perSession = new Set(Object.keys((clean && clean.c) || {}).filter((key) => !again || again.c[key] !== clean.c[key]))
    const fields = (a, b) => [
      ...SAME.map((name) => ({ name, get: (r) => r[name] })),
      ...[...new Set([...Object.keys(a.c || {}), ...Object.keys(b.c || {})])].filter((key) => !perSession.has(key)).map((key) => ({ name: 'c.' + key, get: (r) => r.c && r.c[key] })),
    ]
    const intact = compare(refClean, clean, clean, fields)
    rows.push({ userAgent, tamper: 'none', verdict: intact.verdict === 'same' ? 'same' : 'FAIL', moved: intact.moved })
    if (intact.verdict !== 'same') failed++
    const one = async (tamper) => {
      const [ref, cur] = await Promise.all([visit(userAgent, 'ref', tamper), visit(userAgent, 'cur', tamper)])
      const result = compare(ref.first, cur.first, clean, fields)
      const moved = result.moved.slice()
      let verdict = result.verdict
      // the id once the tampering has ended: wrong only where the reference's is wrong too
      const wrongAfter = (r, right) => !r || !right || r.id !== right.id || r.idStrict !== right.idStrict
      if (wrongAfter(cur.next, clean) && !wrongAfter(ref.next, refClean)) {
        verdict = 'FAIL'
        moved.push('the id after the tampering is wrong')
      }
      if (ref.hung) moved.push('the reference page hung')
      if (cur.hung) moved.push('the current page hung')
      if (cur.hung && !ref.hung) verdict = 'FAIL'
      if (verdict === 'FAIL') failed++
      process.stderr.write(`${verdict.padEnd(10)} ${tamper.name}\n`)
      return { userAgent, tamper: tamper.name, verdict, moved }
    }
    // a few tampers at a time; rows keep the order of the list
    for (let i = 0; i < TAMPERS.length; i += PARALLEL) rows.push(...(await Promise.all(TAMPERS.slice(i, i + PARALLEL).map(one))))
  }
} finally {
  server.close()
}

for (const row of rows) {
  if (row.verdict === 'same' && !process.argv.includes('--all')) continue
  console.log(`${row.verdict === 'FAIL' ? 'FAIL' : 'ok  '} ${row.tamper.padEnd(56)} ${row.verdict.padEnd(10)} ${row.userAgent.slice(0, 60)}  ${row.moved.join(' | ')}`)
}
const count = (v) => rows.filter((row) => row.verdict === v).length
console.log(
  `\n${engineName} ${version}, ${LAB ? 'lab' : 'product'} build: ${rows.length} rows (${USER_AGENTS.length} user agents x ${TAMPERS.length + 1} states), ` +
    `same ${count('same')}, better ${count('better')}, both wrong ${count('both wrong')}, failed ${failed}`,
)
writeFileSync(new URL(`./report/raw/tamper-${engineName}${LAB ? '-lab' : ''}.json`, import.meta.url), JSON.stringify({ engine: engineName, version, rows }, null, 1))
process.exit(failed ? 1 : 0)
