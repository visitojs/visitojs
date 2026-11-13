// Decides whether a new reading comes from a device seen before. It runs where stored readings live (a server, a script), never in the page.
import { Parts } from './reading.js'

/** What the matcher needs from a reading. A stored reading has all of it. */
export interface Seen {
  /** Version of the id definition (`reading.v`). When both sides have one and they differ, the parts are not compared. */
  v?: number | null
  /** The stored id. It decides alone, with or without `c`, and counts only when it is a non-empty string on both sides. */
  did: string | null
  os: string
  osVer: string | null
  app: string
  appVer: string | null
  c: Parts
}

export interface Match {
  /**
   * `same`: the stored id is equal. `likely`: the candidates that fit are one device, and it names the same model.
   * `unknown`: nothing decides. `different`: every candidate that could be compared contradicts the reading.
   */
  result: 'same' | 'likely' | 'unknown' | 'different'
  /** The rule that decided, for logs. */
  rule: string
  /** Index of the candidate that matched, or -1. */
  index: number
}

// compared when both sides have a real value; a value one browser does not give is no evidence either way
const PARTS = ['hw.model', 'hw.mem', 'p.lang', 'p.txt', 'hw.scr', 'hw.cores']

function real(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && value.charAt(0) !== '!')
}

/** True when a reading read back from a store has an object of parts to compare. */
function usable(seen: unknown): boolean {
  const c = seen && typeof seen === 'object' ? (seen as Seen).c : null
  return !!c && typeof c === 'object'
}

/** The stored id of a reading read back from a store, or '' when it has none: only a non-empty string is an id. */
function stored(seen: unknown): string {
  const did = seen && typeof seen === 'object' ? (seen as Seen).did : null
  return typeof did === 'string' ? did : ''
}

/** The text of a string or a number, or null: String() on an object from a store can throw, so nothing else is converted. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? '' + value : null
}

/** True when version `a` is lower than `b`, on the fields both have: sources give versions to different precision. A missing version is never lower. */
function lower(a: unknown, b: unknown): boolean {
  const s = text(a)
  const t = text(b)
  if (!s || !t) return false
  const x = s.split('.')
  const y = t.split('.')
  for (let i = 0; i < x.length && i < y.length; i++) {
    const m = parseInt(x[i], 10) || 0
    const n = parseInt(y[i], 10) || 0
    if (m !== n) return m < n
  }
  return false
}

/** True when both readings name an id version and they differ: a part can change meaning between versions. */
function otherVersion(now: Seen, then: Seen): boolean {
  const a = text(now.v)
  const b = text(then.v)
  return a !== null && b !== null && a !== b
}

/** Why `now` cannot be the device behind the earlier reading `then`, or '' when nothing contradicts. */
function contradiction(now: Seen, then: Seen): string {
  if (now.os !== then.os) return 'os'
  for (let i = 0; i < PARTS.length; i++) {
    const a = now.c[PARTS[i]]
    const b = then.c[PARTS[i]]
    // a store turns numbers into strings, and the id is built from String(value) too
    if (real(a) && real(b) && String(a) !== String(b)) return PARTS[i]
  }
  // a phone's system does not go back to an older version, and an app almost never does
  if (lower(now.osVer, then.osVer)) return 'os went back'
  if (now.app === then.app && lower(now.appVer, then.appVer)) return 'app went back'
  return ''
}

/**
 * Compares a reading with earlier ones. The stored id decides alone when it is equal, with or without parts and whatever the
 * id version; it counts only when it is a non-empty string on both sides. Without it, a candidate fits only when nothing
 * contradicts and both name the same model; candidates that fit but belong to several stored ids are a tie, and a tie is
 * `unknown`, never a guess. A candidate of another id version neither fits nor contradicts, and a candidate without parts is
 * not compared part by part; a `now` without parts gives `unknown`, `nothing to compare` unless its stored id decides.
 * A version that is not a string or a number counts as missing. It never throws on anything `JSON.parse` returns.
 * `likely` means "consistent and alone among these candidates": score with it, never ban on it.
 */
export function match(now: Seen, earlier: Seen[]): Match {
  if (!Array.isArray(earlier)) return { result: 'unknown', rule: 'nothing to compare', index: -1 }
  const did = stored(now)
  for (let i = 0; i < earlier.length; i++) {
    if (did && stored(earlier[i]) === did) return { result: 'same', rule: 'stored id', index: i }
  }
  if (!usable(now)) return { result: 'unknown', rule: 'nothing to compare', index: -1 }
  let fit = -1
  let tie = false
  let open = false
  let versions = false
  let reason = ''
  for (let i = 0; i < earlier.length; i++) {
    if (!usable(earlier[i])) continue
    if (otherVersion(now, earlier[i])) {
      versions = true
      continue
    }
    const why = contradiction(now, earlier[i])
    if (why) {
      reason = reason || why
    } else if (real(now.c['hw.model']) && real(earlier[i].c['hw.model'])) {
      // readings without a stored id cannot be shown to be one device
      if (fit >= 0 && (!stored(earlier[i]) || stored(earlier[fit]) !== stored(earlier[i]))) tie = true
      fit = i
    } else {
      open = true
    }
  }
  if (tie) return { result: 'unknown', rule: 'tie', index: -1 }
  if (fit >= 0) return { result: 'likely', rule: 'model and settings', index: fit }
  if (open) return { result: 'unknown', rule: 'no model to compare', index: -1 }
  if (versions) return { result: 'unknown', rule: 'other id version', index: -1 }
  // past this point every usable candidate gave a reason, so no reason means there was none
  if (!reason) return { result: 'unknown', rule: 'nothing to compare', index: -1 }
  return { result: 'different', rule: reason, index: -1 }
}
