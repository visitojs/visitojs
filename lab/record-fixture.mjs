// Records one real page with every response and its timing into private/fixture/page.har. Needs network; beacons are blocked.
// Usage: FIXTURE_URL=... [FIXTURE_USER=... FIXTURE_PASS=...] [FIXTURE_BLOCK=<regex of the site's own event endpoints>] node lab/record-fixture.mjs
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PHONE } from './phone.mjs'

const url = process.env.FIXTURE_URL
if (!url) throw new Error('FIXTURE_URL is required')
// event endpoints only: the scripts that would call them still load, so the page keeps its real weight
const BEACON = new RegExp('facebook\\.com/tr|google-analytics\\.com|/g/collect|clarity\\.ms/collect' + (process.env.FIXTURE_BLOCK ? '|' + process.env.FIXTURE_BLOCK : ''), 'i')

const browser = await chromium.launch()
const context = await browser.newContext({
  ...PHONE,
  serviceWorkers: 'block',
  httpCredentials: process.env.FIXTURE_USER ? { username: process.env.FIXTURE_USER, password: process.env.FIXTURE_PASS || '' } : undefined,
  recordHar: { path: 'private/fixture/page.har', content: 'embed', mode: 'full' },
})
const blocked = []
await context.route('**/*', (route) => {
  const request = route.request()
  if (request.method() !== 'GET' || BEACON.test(request.url())) {
    blocked.push(`${request.method()} ${request.url().split('?')[0]}`)
    return route.abort()
  }
  return route.continue()
})
const page = await context.newPage()
const response = await page.goto(url, { waitUntil: 'load', timeout: 90000 })
await page.waitForTimeout(8000)
const title = await page.title()
await context.close()
await browser.close()
writeFileSync('private/fixture/meta.json', JSON.stringify({ url, status: response.status(), title, recorded: new Date().toISOString(), blocked }, null, 1))
console.log(`recorded ${url}: HTTP ${response.status()}, title "${title}", ${blocked.length} beacon requests blocked`)
