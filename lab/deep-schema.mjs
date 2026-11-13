// What a reading of the deep entry must look like, and its id recomputed in Node from the recipe in docs/SIGNALS.md, independently
// of the library's own SHA-256. Used by the browser harnesses and the old-engines check.
import { createHash } from 'node:crypto'

const HEX16 = /^[0-9a-f]{16}$/
const HEX64 = /^[0-9a-f]{64}$/
export const DEEP_PARTS = ['r.audio', 'r.cg']
const STATUSES = ['!na', '!err', '!to', '!ex', '!noise']
// r.cchk and r.achk: the check that decided, or the status of a read that never reached one. The text scene is not read, so no text check
const CANVAS_CHECKS = ['ok', 'pattern', 'geometry-patch', 'geometry', 'blocked', '!na', '!err', '!to', '!ex']
const AUDIO_CHECKS = ['ok', 'pattern', 'copy', 'silent', 'nan', '!na', '!err', '!to', '!ex']
const RULES = ['', 'webkit', 'android', 'brave', 'other']
// what each rule leaves out: '' nothing, the others everything
const LEFT_OUT = { '': [], webkit: DEEP_PARTS, android: DEEP_PARTS, brave: DEEP_PARTS, other: DEEP_PARTS }
const KEYS = ['c', 'flags', 'id', 'ms', 't', 'v']

/** "visito-deep:1", then "key=value" for the two parts in sorted order and the fixed line "r.ct=!ex", one per line; SHA-256 in hex. */
export function deepId(c, version = 1) {
  const text = `visito-deep:${version}\n` + DEEP_PARTS.map((key) => `${key}=${String(c[key])}`).join('\n') + '\nr.ct=!ex'
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

/** Problems with a deep reading; an empty list when it is well formed and its id is the one Node recomputes. */
export function deepProblems(r) {
  if (!r || typeof r !== 'object') return ['not a reading']
  const out = []
  const keys = Object.keys(r).sort()
  if (!sameList(keys, KEYS)) out.push(`keys are ${keys.join(',')}, expected ${KEYS.join(',')}`)
  if (r.v !== 1) out.push(`v is ${r.v}`)
  const c = r.c || {}
  for (const key of DEEP_PARTS) if (!(HEX16.test(c[key]) || STATUSES.includes(c[key]))) out.push(`${key} is ${c[key]}`)
  if (c['r.ct'] !== '!ex') out.push(`r.ct is ${c['r.ct']}: the text scene is never read`)
  if (!CANVAS_CHECKS.includes(c['r.cchk'])) out.push(`r.cchk is ${c['r.cchk']}`)
  if (!AUDIO_CHECKS.includes(c['r.achk'])) out.push(`r.achk is ${c['r.achk']}`)
  if (!RULES.includes(c['x.rule'])) out.push(`x.rule is ${JSON.stringify(c['x.rule'])}`)
  // x.id "!err" means a hash failed: when its known answers were wrong every value became "!err" after its check passed; when the
  // hash threw, the values stand and only the id is missing
  const hashed = c['x.id'] !== '!err'
  if (hashed && c['r.cchk'] === 'ok' && !HEX16.test(c['r.cg'])) out.push('r.cchk is ok without a canvas value')
  if (hashed && c['r.achk'] === 'ok' && !HEX16.test(c['r.audio'])) out.push('r.achk is ok without an audio value')
  if (c['r.cg'] === '!noise' && !['pattern', 'geometry-patch', 'geometry', 'blocked'].includes(c['r.cchk'])) out.push(`canvas noise with r.cchk ${c['r.cchk']}`)
  if (c['r.audio'] === '!noise' && !['pattern', 'copy'].includes(c['r.achk'])) out.push(`audio noise with r.achk ${c['r.achk']}`)
  const left = LEFT_OUT[c['x.rule']] || []
  if (!DEEP_PARTS.every((key) => (left.includes(key) ? c[key] === '!ex' : c[key] !== '!ex'))) out.push(`rule ${JSON.stringify(c['x.rule'])} leaves out ${left.join(', ') || 'nothing'}, and c holds ${DEEP_PARTS.map((key) => key + '=' + c[key]).join(' ')}`)
  if (left.length === DEEP_PARTS.length && !(c['r.cchk'] === '!ex' && c['r.achk'] === '!ex')) out.push(`rule ${c['x.rule']} with a check that is not "!ex"`)
  const f = r.flags || {}
  const want = {
    partial: DEEP_PARTS.filter((key) => c[key] === '!err' || c[key] === '!to'),
    noise: DEEP_PARTS.filter((key) => c[key] === '!noise'),
    excluded: DEEP_PARTS.filter((key) => c[key] === '!ex'),
  }
  for (const list of Object.keys(want)) if (!sameList(f[list], want[list])) out.push(`flags.${list} is ${JSON.stringify(f[list])}, expected ${JSON.stringify(want[list])}`)
  const real = DEEP_PARTS.some((key) => HEX16.test(c[key]))
  const due = real && !want.partial.length && !want.noise.length && c['x.id'] !== '!err'
  if (due) {
    if (r.id !== deepId(c)) out.push(`id ${r.id} is not the one recomputed from c, ${deepId(c)}`)
  } else if (r.id !== null) out.push(`id ${r.id} where none is due`)
  if (r.id !== null && !HEX64.test(r.id)) out.push(`id ${r.id} is not 64 hex digits`)
  const thin = DEEP_PARTS.some((key) => c[key] === '!ex' || c[key] === '!na')
  if (f.weak !== (r.id !== null && thin)) out.push(`flags.weak is ${f.weak}`)
  if (!(typeof r.ms === 'number' && r.ms >= 0)) out.push(`ms is ${r.ms}`)
  if (!r.t || typeof r.t !== 'object' || Object.keys(r.t).some((step) => typeof r.t[step] !== 'number')) out.push('t is not a map of step timings')
  return out
}
