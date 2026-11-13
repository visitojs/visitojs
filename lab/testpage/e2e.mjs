// Drives the phone test page in a real browser against the real Worker code (served by Node, results kept in memory).
// Usage: node lab/testpage/e2e.mjs [chromium|firefox|webkit]
import http from 'node:http'
import { readFileSync } from 'node:fs'
import * as playwright from 'playwright'
import worker from './src/worker.js'
import { PHONE } from '../phone.mjs'
import { problems } from '../schema.mjs'
import { loadPage, stopOnPageLoad } from '../launch.mjs'

const engineName = process.argv[2] || 'chromium'
const files = {
  '/page.html': [readFileSync(new URL('./public/page.html', import.meta.url)), 'text/html; charset=utf-8'],
  '/visito.js': [readFileSync(new URL('../../dist/visito.lab.min.js', import.meta.url)), 'application/javascript'],
}
const stored = new Map()
const env = {
  LINK_TOKEN: 'link',
  ADMIN_TOKEN: 'admin',
  ASSETS: { fetch: async (request) => { const f = files[new URL(request.url).pathname]; return f ? new Response(f[0], { headers: { 'content-type': f[1] } }) : new Response('', { status: 404 }) } },
  RESULTS: { put: async (k, v) => void stored.set(k, v), get: async (k) => stored.get(k) ?? null, list: async () => ({ keys: [...stored.keys()].map((name) => ({ name })), list_complete: true }) },
}
const server = http.createServer(async (incoming, outgoing) => {
  const chunks = []
  for await (const chunk of incoming) chunks.push(chunk)
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
  const response = await worker.fetch(new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method, headers: incoming.headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env)
  // the lab runs on plain http, where a Secure cookie would be dropped
  const headers = Object.fromEntries([...response.headers].map(([k, v]) => [k, k === 'set-cookie' ? v.replace('; Secure', '') : v]))
  outgoing.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })
const records = () => [...stored.values()].map((v) => JSON.parse(v))
const browser = await playwright[engineName].launch()
// a harness page that does not load ends the run with a FAIL line, after the checks so far (lab/launch.mjs)
let stopped = null
try {
  const context = await browser.newContext(engineName === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))

  check('without the token the page does not exist', (await loadPage(page, `${base}/`)).status() === 404)
  check('the page file cannot be reached around the token', (await loadPage(page, `${base}/page.html`)).status() === 404)

  await loadPage(page, `${base}/?k=link`)
  await page.screenshot({ path: `lab/report/raw/testpage-${engineName}-1-wait.png` })
  await page.waitForSelector('#pick:not([hidden])', { timeout: 40000 })
  check('after the check the page asks which phone this is', await page.locator('#phones button').count() === 8)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('no sideways scrolling at phone width', overflow <= 0, `${overflow}px`)
  const smallest = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#phones button')].map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))))
  check('every number button is at least 44 px', smallest >= 44, `${smallest}px`)
  await page.screenshot({ path: `lab/report/raw/testpage-${engineName}-2-pick.png` })
  check('the result is stored before any tap, so nothing is lost if the tester stops here', records().length === 1 && records()[0].body.phone === null)

  await page.locator('#phones button', { hasText: '3' }).tap().catch(() => page.locator('#phones button', { hasText: '3' }).click())
  await page.waitForSelector('#done:not([hidden])')
  await page.screenshot({ path: `lab/report/raw/testpage-${engineName}-3-done.png` })
  await page.waitForTimeout(300)
  const first = records()[0]
  check('the tap adds the phone number to the same record', records().length === 1 && first.body.phone === 3)
  check('the stored reading is well formed and complete', first.body.reading && !problems(first.body.reading).length && !first.body.reading.flags.partial.length, JSON.stringify(first.body.reading && problems(first.body.reading)))
  // every automation mark candidate is recorded, so the test page keeps collecting evidence for it
  const botKeys = ['own-value', 'frame-window', 'frame-srcdoc', 'no-webdriver', 'app-version', 'plain-getter', 'plugins-type', 'ua-version', 'no-platform-hint', 'runtime-constructible'].map((mark) => 'x.bot.' + mark)
  const c = (first.body.reading && first.body.reading.c) || {}
  check('the stored reading records every automation mark candidate as true, false or "!na"', botKeys.every((key) => c[key] === true || c[key] === false || c[key] === '!na'), JSON.stringify(botKeys.map((key) => c[key])))
  check('the page shows a 4-character code', /^[0-9A-Z]{4}$/.test(await page.locator('#code').textContent()))
  check('calibration time and screen facts are recorded', first.body.calib > 0 && first.body.screen && first.body.screen.sw > 0)
  check('the server saw its own cookie and the script cookie on the post', !!first.cookies._dzt_srv && !!first.cookies._dzt_js && !!first.cookies._dzt, JSON.stringify(first.cookies))
  check('no page error', !errors.length && !first.body.errors.length, errors.concat(first.body.errors).join(' | '))

  await loadPage(page, `${base}/?k=link`)
  await page.waitForSelector('#pick:not([hidden])', { timeout: 40000 })
  const second = records().find((r) => r.body.rid !== first.body.rid)
  check('a second visit is a new record that carries the same stored values', second && second.cookies._dzt_srv === first.cookies._dzt_srv && second.body.storage.ls === first.body.storage.ls && second.body.reading.did === first.body.reading.did && second.body.reading.didNew === false)
  check('the phone number is remembered for the next visit', await page.locator('#phones button[aria-pressed="true"]').textContent() === '3')

  const exported = await (await context.request.get(`${base}/export?k=admin`)).json()
  check('the export returns both visits', exported.length === 2)
  check('the export refuses the link token', (await context.request.get(`${base}/export?k=link`)).status() === 404)
  await context.close()

  const dark = await browser.newContext({ ...(engineName === 'firefox' ? { ...PHONE, isMobile: undefined } : PHONE), colorScheme: 'dark' })
  const darkPage = await dark.newPage()
  await loadPage(darkPage, `${base}/?k=link`)
  await darkPage.waitForSelector('#pick:not([hidden])', { timeout: 40000 })
  await darkPage.screenshot({ path: `lab/report/raw/testpage-${engineName}-4-pick-dark.png` })
  await dark.close()
} catch (error) {
  stopped = error
} finally {
  await browser.close()
  server.close()
}
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : '  <- ' + c.detail}`)
if (stopped) stopOnPageLoad(stopped)
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${engineName}: ${checks.length - failed} of ${checks.length} test-page checks pass`)
process.exit(failed ? 1 : 0)
