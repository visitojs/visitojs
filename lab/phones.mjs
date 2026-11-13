// Replays the current id rules on the readings a test page stored, and prints one row per visit grouped by device.
// Usage: node lab/phones.mjs <export.json>   (the export is the test page's /export answer; it stays in private/)
import { readFileSync } from 'node:fs'
import { hintedOs, seal } from '../build/esm/reading.js'
import { parseUa } from '../build/esm/ua.js'

const file = process.argv[2]
if (!file) throw new Error('usage: node lab/phones.mjs <export.json>')
const records = JSON.parse(readFileSync(file, 'utf8')).sort((a, b) => (a.at < b.at ? -1 : 1))

const rows = records.map((record) => {
  const stored = record.body.reading || { c: {}, flags: {}, t: {} }
  const ua = parseUa(record.ua)
  const c = { ...stored.c }
  const brave = String(c['x.ch.brands']).includes('Brave')
  // the stored model may predate a parser fix: take it again from the user agent, then from client hints
  const hinted = typeof c['x.ch.model'] === 'string' && c['x.ch.model'] && c['x.ch.model'][0] !== '!' ? c['x.ch.model'] : null
  c['hw.model'] = ua.model || hinted || '!na'
  if (ua.reduced) ua.osVer = ua.osVer || hintedOs(c)
  if (brave) c['hw.mem'] = '!ex'
  // a reading stored by a current build says what was excluded; for an older one it is told from the browser
  // as id version 3 tells it: every iOS browser in these sessions is WebKit at the Safari 17 level or later, Brave's desktop
  // builds lose the screen too, and Firefox was not among the visits
  const scr = 'hw.scr' in stored.c ? stored.c['hw.scr'] === '!ex' : ua.os === 'ios' || (brave && ua.os !== 'android')
  const cores = 'hw.cores' in stored.c ? stored.c['hw.cores'] === '!ex' : brave
  const ids = seal(c, { scr, cores }, ua)
  const slowest = Object.entries(stored.t || {}).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  return {
    at: record.at.slice(5, 19),
    device: `${ua.os} ${c['x.plat']}`,
    browser: brave ? 'brave' : ua.app,
    did: (stored.did || 'none').slice(0, 6) + (stored.didNew ? ' new' : ''),
    id: ids.id ? ids.id.slice(0, 8) : 'none',
    strict: ids.idStrict ? ids.idStrict.slice(0, 8) : 'none',
    weak: c['hw.model'] === '!na',
    model: c['hw.model'],
    txt: c['p.txt'],
    private: stored.flags.private,
    auto: (stored.flags.auto || []).join('+'),
    partial: (stored.flags.partial || []).length,
    slowest: `${slowest[0]} ${slowest[1]}`,
  }
})

const devices = [...new Set(rows.map((row) => row.device))]
for (const device of devices) {
  const visits = rows.filter((row) => row.device === device)
  console.log(`\n${device}: ${visits.length} visits, ${new Set(visits.map((v) => v.id)).size} ids, ${new Set(visits.map((v) => v.did.slice(0, 6))).size} stored ids`)
  for (const v of visits) {
    console.log(
      `  ${v.at}  ${v.browser.padEnd(10)} did ${v.did.padEnd(10)} id ${v.id}${v.weak ? ' weak' : '     '} strict ${v.strict}  model ${String(v.model).padEnd(11)} text ${String(v.txt).padEnd(5)} private ${String(v.private).padEnd(5)} failed ${v.partial}  slowest ${v.slowest}${v.auto ? '  auto ' + v.auto : ''}`,
    )
  }
}
