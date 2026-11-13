// How the comparison reads its raw observations: what counts as stable, what a fault did, and how timings are summarised.
// Pure functions, so test/compare.test.mjs checks them without a browser.

const present = (id) => typeof id === 'string' ? id !== '' : id !== null && id !== undefined

/** One verdict for a list of ids from repeated visits: stable, split, incomplete or no id. */
export function classify(ids) {
  const answered = ids.filter(present)
  const distinct = new Set(answered).size
  let verdict = 'stable'
  if (!answered.length) verdict = 'no id'
  else if (distinct > 1) verdict = 'split'
  else if (answered.length < ids.length) verdict = 'incomplete'
  return { runs: ids.length, answered: answered.length, distinct, verdict }
}

/** One visit against the base visit: same, changed, or no id when either has none. */
export function sameAs(base, other) {
  if (!present(base) || !present(other)) return 'no id'
  return base === other ? 'same' : 'changed'
}

/** What the page saw under a fault. An answer that holds any id counts as an id; escaped errors are reported beside it. */
export function faultOutcome(visit) {
  const escaped = !!(visit.escaped && visit.escaped.length)
  let outcome = 'no answer'
  if (visit.values) outcome = Object.values(visit.values).some(present) ? 'id' : 'answered without an id'
  else if (visit.error) outcome = 'threw or rejected'
  return { outcome, escaped }
}

// a browser or app update: the major version of each browser and app token goes up by one
const TOKENS = /(Chrome\/|CriOS\/|Firefox\/|FxiOS\/|rv:|FBAV\/|Instagram )(\d+)/g

/** The same user agent one major version later. Safari's Version/ counts only where no Chrome or Firefox token carries the version. */
export function bumpVersion(ua) {
  let changed = 0
  let out = ua.replace(TOKENS, (all, token, major) => {
    changed++
    return token + (Number(major) + 1)
  })
  if (!changed) {
    out = ua.replace(/(Version\/)(\d+)/, (all, token, major) => {
      changed++
      return token + (Number(major) + 1)
    })
  }
  if (!changed) throw new Error(`no browser version found to raise in "${ua}"`)
  return out
}

// linear interpolation between closest ranks
const quantile = (sorted, q) => {
  const at = (sorted.length - 1) * q
  const low = Math.floor(at)
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low)
}

/** Median, quartiles and range of the timings that exist. */
export function spread(values) {
  const sorted = values.filter((v) => typeof v === 'number' && v === v).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, median: null, p25: null, p75: null, min: null, max: null }
  return { n: sorted.length, median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75), min: sorted[0], max: sorted[sorted.length - 1] }
}

/** The id most visits of a run returned, the earliest on a tie: what the other conditions are compared with. */
export function baseId(ids) {
  let best = null
  let most = 0
  for (const id of ids) {
    if (!present(id)) continue
    const count = ids.filter((other) => other === id).length
    if (count > most) {
      best = id
      most = count
    }
  }
  return best
}

/**
 * Drops the components of every visit whose id is the base id and returns the components of one such visit, so a run
 * file keeps what is needed to say why an id changed and no more. Visits with another id keep theirs.
 */
export function pruneComponents(visits, output, base) {
  let kept = null
  for (const visit of visits) {
    if (!visit || !visit.values || visit.values[output] !== base) continue
    if (kept === null && visit.components !== undefined) kept = visit.components
    delete visit.components
  }
  return kept
}

// the high-entropy client hints a page can ask for, every one the emulated metadata sets
export const HINT_NAMES = ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64']
// the name a page reads each emulated field under: uaFullVersion carries the metadata's fullVersion
const SEEN_AS = { fullVersion: 'uaFullVersion' }

/** Whether the client hints a page saw are the ones its context emulated, in every field emulated; both null where the browser has none. */
export function hintsMatch(planned, seen) {
  if (!planned || !seen) return !planned && !seen
  return Object.keys(planned).every((field) => JSON.stringify(planned[field]) === JSON.stringify(seen[SEEN_AS[field] || field]))
}
