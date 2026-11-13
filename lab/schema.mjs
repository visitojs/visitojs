// What a well-formed reading is. Returns a list of problems; an empty list means valid.
const STATUS = ['!na', '!err', '!to', '!ex', '!noise']
const UUID = /^[a-f0-9-]{32,36}$/i
const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/
// the rendering values and the lab build's diagnostics beside them
const RENDER = {
  'r.math': (v) => HEX16.test(v),
  'r.cg': (v) => HEX16.test(v),
  'r.ct': (v) => HEX16.test(v),
  'r.cgcpu': (v) => HEX16.test(v),
  'r.ctcpu': (v) => HEX16.test(v),
  'r.audio': (v) => HEX16.test(v),
  'r.cchk': (v) => ['ok', 'pattern', 'geometry-patch', 'text-patch', 'geometry', 'text', 'blocked'].includes(v),
  'r.achk': (v) => ['ok', 'pattern', 'copy', 'silent', 'nan'].includes(v),
  'r.arms': (v) => /^\d+(\.\d+)?(e[+-]\d+)?$/.test(v),
}
const KEYS = ['v', 'did', 'didNew', 'didSrc', 'model', 'os', 'osVer', 'app', 'appVer', 'engineVer', 'c', 'id', 'idStrict', 'flags', 'ms', 't']

const nullable = (value, test) => value === null || test(value)
const isString = (value) => typeof value === 'string'

export function problems(reading) {
  if (reading === null) return []
  if (typeof reading !== 'object') return ['not an object']
  const out = []
  const keys = Object.keys(reading).sort().join(',')
  if (keys !== [...KEYS].sort().join(',')) out.push(`keys: ${keys}`)
  if (reading.v !== 3) out.push('v')
  if (!nullable(reading.did, (v) => isString(v) && UUID.test(v))) out.push('did')
  if (typeof reading.didNew !== 'boolean') out.push('didNew')
  if (!/^c?l?$/.test(reading.didSrc)) out.push('didSrc')
  if (reading.did === null && (reading.didNew || reading.didSrc !== '')) out.push('did null but didNew/didSrc set')
  for (const key of ['model', 'osVer', 'appVer']) if (!nullable(reading[key], isString)) out.push(key)
  for (const key of ['os', 'app']) if (!isString(reading[key]) || !reading[key]) out.push(key)
  if (!nullable(reading.engineVer, (v) => Number.isInteger(v) && v > 0)) out.push('engineVer')
  for (const key of ['id', 'idStrict']) if (!nullable(reading[key], (v) => isString(v) && HEX64.test(v))) out.push(key)
  if ((reading.id === null) !== (reading.idStrict === null) || (reading.id && reading.id === reading.idStrict)) out.push('id and idStrict must come together and differ')
  if (typeof reading.ms !== 'number' || !(reading.ms >= 0)) out.push('ms')
  if (!reading.t || typeof reading.t !== 'object' || Object.values(reading.t).some((ms) => typeof ms !== 'number' || !(ms >= 0))) out.push('t')

  if (!reading.c || typeof reading.c !== 'object') out.push('c')
  else {
    for (const [key, value] of Object.entries(reading.c)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) out.push(`c.${key} type`)
      if (isString(value) && value[0] === '!' && !STATUS.includes(value)) out.push(`c.${key} unknown status`)
      else if (RENDER[key] && !(isString(value) && (STATUS.includes(value) || RENDER[key](value)))) out.push(`c.${key} shape`)
    }
    const failed = Object.keys(reading.c).filter((k) => reading.c[k] === '!err' || reading.c[k] === '!to').sort()
    if (!reading.flags || ![true, false, null].includes(reading.flags.private)) out.push('flags.private')
    if (!reading.flags || reading.flags.weak !== (reading.c['hw.model'] === '!na')) out.push('flags.weak')
    if (!reading.flags || !Array.isArray(reading.flags.auto) || reading.flags.auto.some((mark) => !isString(mark))) out.push('flags.auto')
    const partial = reading.flags && Array.isArray(reading.flags.partial) ? [...reading.flags.partial].sort() : null
    if (!partial) out.push('flags.partial')
    else if (partial.join(',') !== failed.join(',')) out.push(`flags.partial ${partial} but failed reads are ${failed}`)
    if (failed.some((k) => k.startsWith('hw.') || k.startsWith('p.')) && reading.id !== null) out.push('an id was built from a partial set')
  }
  return out
}
