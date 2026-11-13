// Replays the recorded page with its original response delays, with one of its scripts swapped per variant:
// nothing (twice, to measure the noise), the script the page had, and VisitoJS.
// Usage: node lab/speed.mjs --slot <regex of the script URL to swap> [--ready <expression>] [--runs 30] [--cpu 4] [--net 1] [--settle 3000] [--label name]
// --ready is an expression that returns a promise settling when the page's own script has its id, to time it.
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { PHONE } from './phone.mjs'
import { problems } from './schema.mjs'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const RUNS = Number(arg('runs', 30))
const CPU = Number(arg('cpu', 4))
const NET = Number(arg('net', 1))
const SETTLE = Number(arg('settle', 3000))
const LABEL = arg('label', `cpu${CPU}-net${NET}`)
const TAPS = 20
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const har = JSON.parse(readFileSync('private/fixture/page.har', 'utf8'))
const meta = JSON.parse(readFileSync('private/fixture/meta.json', 'utf8'))
const entries = new Map()
for (const entry of har.log.entries) if (!entries.has(entry.request.url)) entries.set(entry.request.url, entry)
if (!arg('slot')) throw new Error('--slot is required: a regular expression matching the URL of the script to swap')
const SCRIPT = new RegExp(arg('slot'))
const original = [...entries.values()].find((entry) => SCRIPT.test(entry.request.url))
if (!original) throw new Error(`the recorded page loads no script matching ${SCRIPT}`)
const READY = arg('ready') ? `\n;try{(${arg('ready')}).then(function(){window.__fpReadyAt=performance.now()})}catch(e){}` : ''

// The same script slot in the same HTML carries a different body per variant.
const BODY = {
  control: '/* no fingerprint script */',
  control2: '/* no fingerprint script */',
  original: original.response.content.text + READY,
  visitojs: readFileSync('dist/visito.min.js', 'utf8') + '\n;window.__reading=Visito.getSync();if(window.__reading&&window.__reading.id)window.__fpReadyAt=performance.now();Visito.get(function(r){window.__final=r;window.__doneAt=performance.now();if(r&&r.id&&!window.__fpReadyAt)window.__fpReadyAt=window.__doneAt});',
}
const VARIANTS = Object.keys(BODY)

const INIT = `(() => {
  const m = (window.__m = { longtasks: [], lcp: 0, fcp: 0, cls: 0, taps: [] })
  const watch = (type, each) => { try { new PerformanceObserver((list) => list.getEntries().forEach(each)).observe({ type, buffered: true }) } catch (e) {} }
  watch('longtask', (e) => m.longtasks.push(Math.round(e.duration)))
  watch('largest-contentful-paint', (e) => { m.lcp = e.startTime })
  watch('paint', (e) => { if (e.name === 'first-contentful-paint') m.fcp = e.startTime })
  watch('layout-shift', (e) => { if (!e.hadRecentInput) m.cls += e.value })
  document.addEventListener('DOMContentLoaded', () => {
    m.dcl = performance.now()
    const pad = document.createElement('div')
    pad.id = '__tap'
    pad.style.cssText = 'position:fixed;left:0;top:0;width:48px;height:48px;z-index:2147483647;opacity:0'
    pad.addEventListener('touchstart', (e) => m.taps.push(performance.now() - e.timeStamp), { passive: true })
    document.documentElement.appendChild(pad)
  })
  window.addEventListener('load', () => { m.load = performance.now() })
})()`

const SKIP_HEADER = /^(content-encoding|content-length|transfer-encoding|connection|set-cookie|strict-transport-security)$/
const unmatched = new Set()
const handler = (variant) => async (route) => {
  const request = route.request()
  const url = request.url()
  if (SCRIPT.test(url)) {
    await sleep(Math.max(0, original.time) * NET)
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: BODY[variant] })
  }
  const entry = request.method() === 'GET' ? entries.get(url) : null
  if (!entry || !(entry.response.status > 0)) {
    // beacons and anything the recording did not see: a small answer after a short wait, never the network
    if (request.method() === 'GET') unmatched.add(url.split('?')[0])
    await sleep(150 * NET)
    return route.fulfill({ status: 204, body: '' })
  }
  await sleep(Math.min(Math.max(0, entry.time), 5000) * NET)
  const headers = {}
  for (const { name, value } of entry.response.headers) {
    const key = name.toLowerCase()
    if (key[0] !== ':' && !SKIP_HEADER.test(key)) headers[key] = value
  }
  const content = entry.response.content
  const body = content.text === undefined ? '' : content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : content.text
  return route.fulfill({ status: entry.response.status, headers, body })
}

async function run(browser, variant) {
  const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block' })
  try {
    await context.addInitScript(INIT)
    await context.route('**/*', handler(variant))
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 120)))
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
    const navigation = page.goto(meta.url, { waitUntil: 'load', timeout: 180000 })
    await page.waitForSelector('#__tap', { state: 'attached', timeout: 180000 })
    for (let i = 0; i < TAPS; i++) {
      await page.touchscreen.tap(24, 24)
      await sleep(100)
    }
    await navigation
    await page.waitForTimeout(SETTLE)
    const m = await page.evaluate(() => ({ ...window.__m, fpReadyAt: window.__fpReadyAt, reading: window.__final || window.__reading, finished: !!window.__final, doneAt: window.__doneAt }))
    const taps = [...m.taps].sort((a, b) => a - b)
    return {
      lcp: m.lcp,
      fcp: m.fcp,
      cls: m.cls,
      dcl: m.dcl,
      load: m.load,
      blocking: m.longtasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0),
      longest: Math.max(0, ...m.longtasks),
      tapMedian: taps.length ? taps[Math.floor(taps.length / 2)] : NaN,
      tapWorst: taps.length ? taps[taps.length - 1] : NaN,
      taps: taps.length,
      fpReadyAfterDcl: m.fpReadyAt === undefined ? NaN : m.fpReadyAt - m.dcl,
      libraryMs: m.reading ? m.reading.ms : NaN,
      steps: m.reading ? m.reading.t : {},
      longestStep: m.reading ? Math.max(0, ...Object.values(m.reading.t)) : NaN,
      doneAfterLoad: m.doneAt === undefined ? NaN : m.doneAt - m.load,
      finished: m.finished,
      partial: m.reading ? m.reading.flags.partial : [],
      hasDid: m.reading ? !!m.reading.did : null,
      hasId: m.reading ? !!m.reading.id : null,
      schema: variant === 'visitojs' ? problems(m.reading === undefined ? null : m.reading) : [],
      pageErrors,
    }
  } finally {
    await context.close()
  }
}

const median = (values) => {
  const sorted = values.filter((v) => v === v).sort((a, b) => a - b)
  return sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : NaN
}
// 95 % interval of the median of paired differences, by bootstrap with a fixed seed so a report can be reproduced
function interval(differences) {
  const clean = differences.filter((v) => v === v)
  if (clean.length < 3) return [NaN, NaN]
  let seed = 20261112
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
  const medians = []
  for (let round = 0; round < 2000; round++) medians.push(median(clean.map(() => clean[Math.floor(random() * clean.length)])))
  medians.sort((a, b) => a - b)
  return [medians[50], medians[1949]]
}

const browser = await chromium.launch()
const results = Object.fromEntries(VARIANTS.map((variant) => [variant, []]))
try {
  for (let i = 0; i < RUNS; i++) {
    // rotate the order so no variant always runs first
    for (let k = 0; k < VARIANTS.length; k++) {
      const variant = VARIANTS[(i + k) % VARIANTS.length]
      results[variant][i] = await run(browser, variant)
    }
    process.stderr.write(`run ${i + 1}/${RUNS}\r`)
  }
} finally {
  await browser.close()
}

const METRICS = ['fcp', 'lcp', 'cls', 'dcl', 'load', 'blocking', 'longest', 'tapMedian', 'tapWorst', 'fpReadyAfterDcl', 'libraryMs', 'longestStep', 'doneAfterLoad']
const fmt = (value, metric) => (value !== value ? '   n/a' : metric === 'cls' ? value.toFixed(4) : value.toFixed(1)).padStart(9)
const summary = {}
console.log(`\n${meta.title}\nChromium ${browser.version()}, CPU x${CPU}, network x${NET}, ${RUNS} runs per variant, ${TAPS} taps per run`)
console.log('metric (median)   ' + VARIANTS.map((v) => v.padStart(9)).join('') + '   visitojs-control [95% interval]   control2-control [95% interval]')
for (const metric of METRICS) {
  const column = (variant) => results[variant].map((r) => r[metric])
  const diff = (variant) => column(variant).map((value, i) => value - results.control[i][metric])
  const row = { medians: Object.fromEntries(VARIANTS.map((v) => [v, median(column(v))])), visito: interval(diff('visitojs')), noise: interval(diff('control2')), original: interval(diff('original')) }
  summary[metric] = row
  const range = ([low, high]) => `[${fmt(low, metric).trim()}, ${fmt(high, metric).trim()}]`.padEnd(30)
  console.log(metric.padEnd(18) + VARIANTS.map((v) => fmt(row.medians[v], metric)).join('') + '   ' + range(row.visito) + '  ' + range(row.noise))
}
const visito = results.visitojs
const facts = {
  didAtScriptEnd: visito.filter((r) => r.hasDid).length,
  idAtScriptEnd: visito.filter((r) => r.hasId).length,
  schemaProblems: visito.flatMap((r) => r.schema),
  finished: visito.filter((r) => r.finished).length,
  partial: [...new Set(visito.flatMap((r) => r.partial))],
  worstStep: Math.max(...visito.map((r) => r.longestStep)),
  pageErrors: Object.fromEntries(VARIANTS.map((v) => [v, results[v].reduce((n, r) => n + r.pageErrors.length, 0)])),
  tapsDelivered: Object.fromEntries(VARIANTS.map((v) => [v, results[v].reduce((n, r) => n + r.taps, 0)])),
  unmatched: [...unmatched],
}
const steps = {}
for (const r of visito) for (const [step, ms] of Object.entries(r.steps)) (steps[step] = steps[step] || []).push(ms)
console.log('\nvisitojs steps, median ms: ' + Object.keys(steps).map((step) => `${step} ${median(steps[step]).toFixed(1)}`).join(', '))
console.log(`visitojs: stored id present in ${facts.didAtScriptEnd}/${RUNS} runs, id in ${facts.idAtScriptEnd}/${RUNS}; finished every stage in ${facts.finished}/${RUNS}; failed reads: [${facts.partial}]; slowest single step over all runs: ${facts.worstStep.toFixed(1)} ms; schema problems: ${facts.schemaProblems.length}`)
console.log(`page errors per variant: ${JSON.stringify(facts.pageErrors)}; taps delivered: ${JSON.stringify(facts.tapsDelivered)}; requests not in the recording: ${facts.unmatched.length}`)
writeFileSync(`lab/report/raw/speed-${LABEL}.json`, JSON.stringify({ label: LABEL, cpu: CPU, net: NET, runs: RUNS, chromium: browser.version(), page: meta.title, summary, facts, results }, null, 1))
