// Wrong-value forms of the built-ins the user-agent parser calls, for comparing two builds on a page that has replaced them.
// Each one is source text, so a page's init script and Node install it the same way. `make` receives the original and
// returns the replacement; `get` replaces a getter. A `make` that returns undefined is the built-in removed.
const THROW = 'function () { throw new Error("tampered") }'
const GARBAGE = '{ toString: ' + THROW + ', valueOf: ' + THROW + ' }'
const returning = (value) => `function () { return function () { return ${value} } }`
const wrap = (body) => `function (o) { return function () { var r = o.apply(this, arguments); ${body} } }`

const common = (target, key, label) => [
  { name: `${label} throws`, target, key, make: `function () { return ${THROW} }` },
  { name: `${label} removed`, target, key, make: 'function () { return undefined }' },
  { name: `${label} returns garbage`, target, key, make: returning(GARBAGE) },
]

export const TAMPERS = [
  ...common('String.prototype', "'indexOf'", 'String.prototype.indexOf'),
  { name: 'String.prototype.indexOf returns -1', target: 'String.prototype', key: "'indexOf'", make: returning(-1) },
  { name: 'String.prototype.indexOf counts from 1', target: 'String.prototype', key: "'indexOf'", make: wrap('return r < 0 ? r : r + 1') },
  ...common('String.prototype', "'lastIndexOf'", 'String.prototype.lastIndexOf'),
  { name: 'String.prototype.lastIndexOf returns -1', target: 'String.prototype', key: "'lastIndexOf'", make: returning(-1) },
  { name: 'String.prototype.lastIndexOf counts from 1', target: 'String.prototype', key: "'lastIndexOf'", make: wrap('return r < 0 ? r : r + 1') },
  ...common('String.prototype', "'replace'", 'String.prototype.replace'),
  { name: 'String.prototype.replace returns the string unchanged', target: 'String.prototype', key: "'replace'", make: 'function () { return function () { return "" + this } }' },
  { name: 'String.prototype.replace returns an empty string', target: 'String.prototype', key: "'replace'", make: returning('""') },
  {
    name: 'String.prototype.replace drops the g flag',
    target: 'String.prototype',
    key: "'replace'",
    make: 'function (o) { return function (p, v) { return o.call(this, p instanceof RegExp && p.global ? new RegExp(p.source, p.flags.split("g").join("")) : p, v) } }',
  },
  ...common('String.prototype', "'slice'", 'String.prototype.slice'),
  { name: 'String.prototype.slice returns an empty string', target: 'String.prototype', key: "'slice'", make: returning('""') },
  ...common('String.prototype', "'split'", 'String.prototype.split'),
  { name: 'String.prototype.split returns no parts', target: 'String.prototype', key: "'split'", make: returning('[]') },
  { name: 'String.prototype.split returns the whole string', target: 'String.prototype', key: "'split'", make: 'function () { return function () { return ["" + this] } }' },
  ...common('String.prototype', "'substring'", 'String.prototype.substring'),
  { name: 'String.prototype.substring returns an empty string', target: 'String.prototype', key: "'substring'", make: returning('""') },
  { name: 'String.prototype.substring returns the whole string', target: 'String.prototype', key: "'substring'", make: 'function () { return function () { return "" + this } }' },
  ...common('RegExp.prototype', "'exec'", 'RegExp.prototype.exec'),
  { name: 'RegExp.prototype.exec never matches', target: 'RegExp.prototype', key: "'exec'", make: returning('null') },
  { name: 'RegExp.prototype.exec returns one fixed match', target: 'RegExp.prototype', key: "'exec'", make: returning('["x", "7", "8"]') },
  { name: 'RegExp.prototype.exec returns a match with empty groups', target: 'RegExp.prototype', key: "'exec'", make: returning('["x", "", ""]') },
  ...common('RegExp.prototype', "'test'", 'RegExp.prototype.test'),
  { name: 'RegExp.prototype.test always true', target: 'RegExp.prototype', key: "'test'", make: returning('true') },
  { name: 'RegExp.prototype.test always false', target: 'RegExp.prototype', key: "'test'", make: returning('false') },
  { name: 'RegExp.prototype.test reads the pattern source', target: 'RegExp.prototype', key: "'test'", make: wrap('return this.source.indexOf("(?:") < 0 && r') },
  { name: 'RegExp.prototype.global getter returns false', target: 'RegExp.prototype', key: "'global'", get: 'function () { return false }' },
  { name: 'RegExp.prototype.flags getter returns nothing', target: 'RegExp.prototype', key: "'flags'", get: 'function () { return "" }' },
  { name: 'RegExp.prototype[Symbol.replace] removed', target: 'RegExp.prototype', key: 'Symbol.replace', make: 'function () { return undefined }' },
  { name: 'RegExp.prototype[Symbol.split] removed', target: 'RegExp.prototype', key: 'Symbol.split', make: 'function () { return undefined }' },
  ...common('Math', "'min'", 'Math.min'),
  { name: 'Math.min returns 0', target: 'Math', key: "'min'", make: returning(0) },
  { name: 'Math.min returns NaN', target: 'Math', key: "'min'", make: returning('NaN') },
  { name: 'Math.min returns an object', target: 'Math', key: "'min'", make: returning('{}') },
  ...common('globalThis', "'parseInt'", 'parseInt'),
  { name: 'parseInt returns NaN', target: 'globalThis', key: "'parseInt'", make: returning('NaN') },
  { name: 'parseInt returns an object', target: 'globalThis', key: "'parseInt'", make: returning('{}') },
]

/** Source of an expression that installs the tamper and evaluates to a function that undoes it. */
export function install(t) {
  const replacement = t.get ? `{ configurable: true, get: (${t.get}) }` : `{ configurable: true, writable: true, value: (${t.make})(saved && saved.value) }`
  return `(function () {
    var target = ${t.target}, key = ${t.key}, saved = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, ${replacement})
    return function () { if (saved) Object.defineProperty(target, key, saved); else delete target[key] }
  })()`
}

/**
 * How a reading under a tamper compares with the reference build's under the same tamper, field by field. `clean` is
 * the current build's reading with no tamper, the right answer. Where the two builds differ on a field:
 * - better: the current build has the right value and the reference does not;
 * - worse: the reference has the right value and the current build does not (a failure);
 * - both wrong: neither has the right value; the standard allows it when the current reading is not missing and its id
 *   does not outlast the tampering, which the caller checks.
 * A missing current reading where the reference has one is a failure.
 */
// JSON, except that NaN and Infinity stay apart from null and from each other
const show = (value) => JSON.stringify(value, (key, x) => (typeof x === 'number' && !isFinite(x) ? String(x) : x))

export function compare(ref, cur, clean, fields) {
  if (ref === undefined) ref = null
  if (cur === undefined) cur = null
  if (cur === null) return ref === null ? { verdict: 'same', moved: [], tags: [] } : { verdict: 'FAIL', moved: ['the current reading is missing'], tags: ['missing reading (worse)'] }
  if (ref === null) return { verdict: 'better', moved: ['the reference has no reading'], tags: ['reference has no reading (better)'] }
  const moved = []
  const tags = []
  const kinds = new Set()
  for (const field of fields(ref, cur)) {
    const a = show(field.get(ref))
    const b = show(field.get(cur))
    if (a === b) continue
    const right = clean ? show(field.get(clean)) : undefined
    const kind = b === right ? 'better' : a === right ? 'worse' : 'both wrong'
    kinds.add(kind)
    moved.push(`${field.name}: ${a} -> ${b} (${kind})`)
    tags.push(`${field.name} (${kind})`)
  }
  const verdict = kinds.has('worse') ? 'FAIL' : kinds.has('both wrong') ? 'both wrong' : kinds.size ? 'better' : 'same'
  return { verdict, moved, tags }
}
