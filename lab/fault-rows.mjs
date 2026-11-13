// How the fault matrix judges one row: whether its fault was applied at all, and whether the reading says what it must.
const HEX16 = /^[0-9a-f]{16}$/

/**
 * `targets` are the objects a row edits, `missing` those that did not resolve in this browser, `absentHere` the known-absence
 * lookup. A row is applied when every target resolved, not applicable when none did and each is a known absence, and partly
 * applied when some did: then part of the fault never happened, so the row cannot count as a fault handled. `unknown` lists
 * missing targets that are not known absences, which fail the row.
 */
export function rowState(targets, missing, absentHere) {
  const unknown = missing.filter((target) => !absentHere(target))
  const resolved = targets.filter((target) => missing.indexOf(target) < 0)
  const state = !missing.length ? 'applied' : resolved.length ? 'partial' : 'absent'
  return { state, unknown }
}

const describe = (want) => (want === 'value' ? 'a value' : want === 'same' ? 'the baseline' : want === 'changed' ? 'a value other than the baseline' : want)

function matches(want, got, before) {
  if (want === 'value') return HEX16.test(got)
  if (want === 'same') return got === before
  if (want === 'changed') return HEX16.test(got) && got !== before
  return got === want
}

/**
 * Problems with the keys of `c` against `expect`, which maps a key to what it must be: a status (`!noise`), a check value
 * (`pattern`), `value` (16 hex digits), `same` (the baseline's value), `changed` (a value other than the baseline's), or a list
 * of these, any of which will do.
 */
export function outcomeProblems(expect, c, baseline) {
  const out = []
  for (const key of Object.keys(expect)) {
    const wants = [].concat(expect[key])
    const got = c[key]
    const before = baseline && baseline[key]
    if (wants.some((want) => matches(want, got, before))) continue
    const said = wants.map((want) => (want === 'same' ? `the baseline ${before}` : want === 'changed' ? `a value other than the baseline ${before}` : describe(want)))
    out.push(`${key} is ${got === undefined ? 'missing' : got}, expected ${said.join(' or ')}`)
  }
  return out
}

/** `outcomeProblems` for a whole reading against the baseline reading: no reading at all is a problem, never an outcome met. */
export function readingProblems(expect, reading, baseline) {
  if (!reading || !reading.c) return ['no reading']
  return outcomeProblems(expect, reading.c, baseline ? baseline.c : undefined)
}
