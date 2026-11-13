// What the deep entry costs the page: its own page-busy total (ms), its largest step (the longest single task it gave the page),
// and the longest task the page saw while it ran. Chromium under CPU slowdown (CDP), software or GPU rasteriser; Firefox and
// WebKit without slowdown. Desktop lab timings on this machine, not phone or laptop timings.
// "cold": the first context after a browser launch. "first view": 11 new contexts after it. "reload": 12 reloads in one tab.
// Usage: node lab/deep-cost.mjs [chromium|firefox|webkit] [--gpu] [--rates 1,4,6]
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import * as playwright from 'playwright'
import { launchFrom } from './launch.mjs'

const arg = (name, fallback) => {
  const at = process.argv.indexOf('--' + name)
  return at > 0 ? process.argv[at + 1] : fallback
}
const engineName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chromium'
const launch = launchFrom(engineName, process.argv)
const RATES = engineName === 'chromium' ? arg('rates', '1,4,6').split(',').map(Number) : [1]
const bundle = readFileSync(new URL('../dist/deep.min.js', import.meta.url))
const server = http.createServer((request, response) => {
  if (request.url === '/deep.min.js') return response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>cost</title><body><script src="/deep.min.js"></script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const LONG = `window.__long = []; try { new PerformanceObserver(function (list) { list.getEntries().forEach(function (e) { window.__long.push(e.duration) }) }).observe({ type: 'longtask' }) } catch (e) {}`
const read = async (tab) => {
  await tab.goto(url, { waitUntil: 'load' })
  return tab.evaluate(`new Promise((resolve) => VisitoDeep.get(function (r) { setTimeout(function () { resolve({ r: r, long: window.__long || [] }) }, 50) }))`)
}
const throttle = async (context, tab, rate) => {
  if (engineName !== 'chromium' || rate === 1) return
  const cdp = await context.newCDPSession(tab)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
}
const sample = (got) => ({ ms: got.r.ms, step: Math.max(0, ...Object.values(got.r.t)), long: Math.max(0, ...got.long), id: got.r.id, t: got.r.t })
const stats = (values) => {
  const v = [...values].sort((a, b) => a - b)
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]
  return { median: (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2, p90: at(0.9), max: v[v.length - 1], n: v.length }
}
const out = { engine: engineName, gpu: launch.gpu, rates: {} }
for (const rate of RATES) {
  const browser = await playwright[engineName].launch(launch.options)
  out.version = browser.version()
  const views = []
  try {
    for (let i = 0; i < 12; i++) {
      const context = await browser.newContext()
      await context.addInitScript(LONG)
      const tab = await context.newPage()
      await throttle(context, tab, rate)
      views.push(sample(await read(tab)))
      await context.close()
    }
    const context = await browser.newContext()
    await context.addInitScript(LONG)
    const tab = await context.newPage()
    await throttle(context, tab, rate)
    await read(tab)
    const reloads = []
    for (let i = 0; i < 12; i++) reloads.push(sample(await read(tab)))
    await context.close()
    const first = views.slice(1)
    out.rates[rate] = {
      cold: views[0],
      first: { ms: stats(first.map((s) => s.ms)), step: stats(first.map((s) => s.step)), long: stats(first.map((s) => s.long)) },
      reload: { ms: stats(reloads.map((s) => s.ms)), step: stats(reloads.map((s) => s.step)), long: stats(reloads.map((s) => s.long)) },
      ids: [...new Set([...views, ...reloads].map((s) => s.id))],
    }
  } finally {
    await browser.close()
  }
}
server.close()
const f = (s) => `${s.median.toFixed(1)} (${s.p90.toFixed(1)}, ${s.max.toFixed(1)})`
console.log(`${engineName} ${out.version}${launch.label}: median (90th percentile, maximum) in ms`)
console.log('CPU | first view: total | first view: largest step | first view: longest task | cold: total, largest step, longest task | reload: total | reload: largest step')
for (const rate of RATES) {
  const r = out.rates[rate]
  console.log(`${rate}x | ${f(r.first.ms)} | ${f(r.first.step)} | ${f(r.first.long)} | ${r.cold.ms.toFixed(1)}, ${r.cold.step.toFixed(1)}, ${r.cold.long.toFixed(1)} | ${f(r.reload.ms)} | ${f(r.reload.step)}  ids: ${r.ids.length}`)
  const slow = Object.entries(r.cold.t).sort((a, b) => b[1] - a[1]).slice(0, 3)
  console.log(`     cold, slowest steps: ${slow.map(([k, v]) => `${k} ${v}`).join(', ')}`)
}
writeFileSync(new URL(`./report/raw/deep-cost-${engineName}${launch.suffix}.json`, import.meta.url), JSON.stringify(out, null, 1))
