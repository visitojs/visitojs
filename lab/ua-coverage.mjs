// Usage: node lab/ua-coverage.mjs <file with one user agent per line>. Prints how often the parser finds a model, per app and OS.
import { readFileSync } from 'node:fs'
import { parseUa } from '../build/esm/ua.js'

const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const groups = new Map()
const misses = new Map()
for (const ua of lines) {
  const info = parseUa(ua)
  const key = `${info.os} / ${info.app}`
  const g = groups.get(key) || { n: 0, model: 0, reduced: 0 }
  g.n++
  if (info.model) g.model++
  if (info.reduced) g.reduced++
  groups.set(key, g)
  if (!info.model && !info.reduced && info.os === 'android') misses.set(ua, (misses.get(ua) || 0) + 1)
}
console.log(`${lines.length} user agents`)
for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${key.padEnd(24)} n=${String(g.n).padStart(6)}  model=${((100 * g.model) / g.n).toFixed(1)}%  reduced=${((100 * g.reduced) / g.n).toFixed(1)}%`)
}
console.log(`\nAndroid user agents with no model and not reduced: ${misses.size} distinct`)
for (const [ua, n] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  x${n}  ${ua.slice(0, 170)}`)
