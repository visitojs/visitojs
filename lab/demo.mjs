// Opens the demo page in a real browser and checks what a visitor would see. Usage: node lab/demo.mjs [chromium|firefox|webkit]
import http from 'node:http'
import { readFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { loadPage, stopOnPageLoad } from './launch.mjs'

const engineName = process.argv[2] || 'chromium'
const files = {
  '/': [readFileSync(new URL('../demo/index.html', import.meta.url)), 'text/html; charset=utf-8'],
  '/visito.min.js': [readFileSync(new URL('../dist/visito.min.js', import.meta.url)), 'application/javascript'],
  '/llms.txt': [readFileSync(new URL('../demo/llms.txt', import.meta.url)), 'text/plain; charset=utf-8'],
  '/favicon.ico': [readFileSync(new URL('../demo/favicon.ico', import.meta.url)), 'image/x-icon'],
}
// the brand images, as pages.yml publishes them
for (const name of ['favicon-32.png', 'favicon-180.png', 'favicon-192.png', 'favicon-512.png', 'logo-light-624.png', 'logo-dark-624.png', 'social-preview.png']) {
  files['/' + name] = [readFileSync(new URL(`../demo/${name}`, import.meta.url)), 'image/png']
}
const server = http.createServer((request, response) => {
  const file = files[request.url]
  if (!file) return response.writeHead(404).end()
  response.writeHead(200, { 'content-type': file[1] }).end(file[0])
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })
const browser = await playwright[engineName].launch()
// a harness page that does not load ends the run with a FAIL line, after the checks so far (lab/launch.mjs)
let stopped = null
try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, colorScheme })
    const page = await context.newPage()
    const errors = []
    const outside = []
    const missing = []
    page.on('response', (response) => response.url().startsWith(base) && response.status() >= 400 && missing.push(`${response.status()} ${response.url()}`))
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('request', (request) => !request.url().startsWith(base) && outside.push(request.url()))
    const read = async () => {
      await loadPage(page, `${base}/`, { waitUntil: 'load' })
      await page.waitForFunction(() => document.getElementById('raw').textContent.charAt(0) === '{', null, { timeout: 15000 })
      return page.evaluate(() => Object.fromEntries(['did', 'did-state', 'id', 'strict', 'device', 'browser', 'flags', 'work'].map((id) => [id, document.getElementById(id).textContent])))
    }
    const first = await read()
    check(`${colorScheme}: the stored id and both ids are shown`, /^[0-9a-f-]{36}$/.test(first.did) && /^[0-9a-f]{64}$/.test(first.id) && /^[0-9a-f]{64}$/.test(first.strict), JSON.stringify(first))
    check(`${colorScheme}: a first visit is marked as new`, first['did-state'] === 'new in this browser', first['did-state'])
    const second = await read()
    check(`${colorScheme}: after a reload the ids are the same and the visitor is seen before`, second.did === first.did && second.id === first.id && second['did-state'] === 'seen before', JSON.stringify(second))
    check(`${colorScheme}: no page error and no request leaves the page`, !errors.length && !outside.length, [...errors, ...outside].join(' | '))
    check(`${colorScheme}: every file the page asks for is there`, !missing.length, missing.join(' | '))
    const described = await page.evaluate(() => ({ title: document.title, canonical: (document.querySelector('link[rel=canonical]') || {}).href, ld: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)['@type'] }))
    check(`${colorScheme}: the page describes itself: title, canonical link and JSON-LD`, /^VisitoJS/.test(described.title) && described.canonical === 'https://visitojs.github.io/visitojs/' && described.ld === 'SoftwareSourceCode', JSON.stringify(described))
    // the header logo: the theme's own file, drawn at its set size, with the name as its text
    const logo = await page.evaluate(() => {
      const img = document.querySelector('header .brand img')
      return img && { file: img.currentSrc.split('/').pop(), width: img.naturalWidth, shown: img.getBoundingClientRect().width, alt: img.alt, text: img.parentNode.parentNode.textContent.trim() }
    })
    const expected = colorScheme === 'dark' ? 'logo-dark-624.png' : 'logo-light-624.png'
    check(`${colorScheme}: the header shows ${expected}, 156 px wide, and no typed name`, logo && logo.file === expected && logo.width === 624 && logo.shown === 156 && logo.alt === 'VisitoJS' && logo.text === '', JSON.stringify(logo))
    const preview = await page.evaluate(() => (document.querySelector('meta[property="og:image"]') || {}).content)
    const served = preview && files['/' + preview.split('/').pop()]
    check(`${colorScheme}: the link-preview image is a file the site serves`, preview === 'https://visitojs.github.io/visitojs/social-preview.png' && served, String(preview))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(`${colorScheme}: nothing overflows a phone-width screen`, overflow <= 0, `${overflow}px`)
    await page.screenshot({ path: `lab/report/raw/demo-${engineName}-${colorScheme}.png`, fullPage: true })
    await context.close()
  }
} catch (error) {
  stopped = error
} finally {
  await browser.close()
  server.close()
}
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : '  <- ' + c.detail}`)
if (stopped) stopOnPageLoad(stopped)
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${engineName}: ${checks.length - failed} of ${checks.length} demo-page checks pass`)
process.exit(failed ? 1 : 0)
