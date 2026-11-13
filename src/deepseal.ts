// The deep entry's rules and id, with no browser access, so the tests and the lab tools can replay them on stored values.
import { Build } from './env.js'
import { ERR, EXCLUDED, NA, NOISE, TIMEOUT } from './guard.js'
import { sha256, short } from './hash.js'
import { Parts } from './reading.js'

/** Version of the deep id definition, independent of ID_VERSION. Deep ids compare only within one version. */
export const DEEP_VERSION = 1

// Known answers: SHA-256 of "abc" is the FIPS 180-4 example; the other is short() of the same text. A page that replaced a string or
// array built-in the hashes use can make them return something else without throwing, and that must not become an id.
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const SHORT_ABC = '1a47e90bbdd5594d'

/** What the deep id is built from, in sorted order, so the text hashed needs no sort a page could replace. */
export const DEEP_PARTS = ['r.audio', 'r.cg']
// The text scene is not read: its value split one machine (docs/DECISIONS.md). Its line stays in the hashed text as "!ex", which is
// what DEEP_VERSION 1 hashed in Firefox, so that the version needs no change.
const TEXT_LINE = '\nr.ct=' + EXCLUDED

/**
 * Which browsers the reads run in, from features only; the first rule that matches wins. '' runs both reads. 'other' is an unknown or
 * tampered engine; 'webkit' adds noise in private windows it cannot tell and protects readback from known scripts; 'android' is
 * outside desktop scope and differs between browsers of one phone; 'brave' alters canvas and audio per session and site. Those
 * four read nothing.
 */
export function deepRule(b: Build): string {
  return b.engine === 'other' ? 'other' : b.engine === 'webkit' ? 'webkit' : b.android ? 'android' : b.brave ? 'brave' : ''
}

/** Whether `rule` leaves out every part, so that nothing is read at all. */
export function excludesAll(rule: string): boolean {
  return rule !== ''
}

function isStatus(value: unknown): boolean {
  return value === ERR || value === TIMEOUT || value === NOISE || value === EXCLUDED || value === NA
}

export interface DeepFlags {
  /** Parts that failed or timed out. */
  partial: string[]
  /** Parts whose alteration check fired. */
  noise: string[]
  /** Parts this browser's rule leaves out. */
  excluded: string[]
  /** An id was built, but some part is excluded or missing in this browser. */
  weak: boolean
}

/**
 * Applies `rule` to `c` and builds the id: null when a part failed, timed out or showed noise, and when no part holds a value.
 * Writes the rule, the excluded parts and any unread part back into `c`. `broken` says that the digest the reads used failed its
 * own known-answer test (digestHolds in render.ts). Then, or when the hashes here fail theirs, every part that holds a value is
 * "!err", and so is `x.id`. Never throws: a page that broke hashing leaves `x.id` "!err".
 */
export function sealDeep(c: Parts, rule: string, broken?: boolean): { id: string | null; flags: DeepFlags } {
  const flags: DeepFlags = { partial: [], noise: [], excluded: [], weak: false }
  let id: string | null = null
  try {
    c['x.rule'] = rule
    c['r.ct'] = EXCLUDED
    const all = excludesAll(rule)
    if (all) c['r.cchk'] = c['r.achk'] = EXCLUDED
    let real = false
    for (let i = 0; i < DEEP_PARTS.length; i++) {
      const key = DEEP_PARTS[i]
      if (all) c[key] = EXCLUDED
      const value = c[key]
      // unread, or only inherited from what a page put on Object.prototype
      if (value === undefined || (key in {} && value === (<Parts>{})[key])) c[key] = TIMEOUT
      else if (!isStatus(value)) real = true
    }
    // The parts come from a digest, and the id from a hash, that a page can make answer wrongly without throwing. Their known answers
    // come first: a wrong answer gives no value, rather than one constant for every machine or a new id on every visit. A hash that
    // throws leaves the values as read and only the id missing; the flags below are filled either way, so they say what c says.
    let wrong = !!broken
    if (real && !wrong) {
      try {
        wrong = sha256('abc') !== SHA_ABC || short('abc') !== SHORT_ABC
      } catch (e) {
        c['x.id'] = ERR
        real = false
      }
    }
    if (real && wrong) {
      c['x.id'] = ERR
      for (let i = 0; i < DEEP_PARTS.length; i++) if (!isStatus(c[DEEP_PARTS[i]])) c[DEEP_PARTS[i]] = ERR
      real = false
    }
    let text = 'visito-deep:' + DEEP_VERSION
    let thin = false
    for (let i = 0; i < DEEP_PARTS.length; i++) {
      const key = DEEP_PARTS[i]
      const value = c[key]
      if (value === ERR || value === TIMEOUT) flags.partial[flags.partial.length] = key
      else if (value === NOISE) flags.noise[flags.noise.length] = key
      else if (value === EXCLUDED || value === NA) {
        if (value === EXCLUDED) flags.excluded[flags.excluded.length] = key
        thin = true
      }
      text += '\n' + key + '=' + String(value)
    }
    text += TEXT_LINE
    if (real && !flags.partial.length && !flags.noise.length) {
      id = sha256(text)
      flags.weak = thin
    }
  } catch (e) {
    id = null
    flags.weak = false
    c['x.id'] = ERR
  }
  return { id: id, flags: flags }
}
