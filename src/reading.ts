import { ERR, EXCLUDED, NA, Raw, TIMEOUT } from './guard.js'
import { sha256 } from './hash.js'

/** Version of the id definition. Ids are comparable only within one version. */
export const ID_VERSION = 3

export type Parts = { [key: string]: Raw }

/** Sorted "key=value" lines joined by "\n": the exact text that is hashed, so a server can recompute an id. */
export function canonical(parts: Parts): string {
  const keys = Object.keys(parts).sort()
  const lines: string[] = []
  for (let i = 0; i < keys.length; i++) {
    lines.push(keys[i] + '=' + String(parts[keys[i]]).replace(/[\r\n]/g, ' '))
  }
  return lines.join('\n')
}

/** The id of a set of parts, or null when a read failed: an id from a partial set would differ from the next complete one. */
export function makeId(parts: Parts): { id: string | null; partial: string[] } {
  const partial = failed(parts)
  if (!Object.keys(parts).length || partial.length) return { id: null, partial: partial }
  return { id: sha256('visito:' + ID_VERSION + '\n' + canonical(parts)), partial: partial }
}

/** The names of the reads that failed or timed out, sorted. Never throws: `for...in` and an index are not built-ins a page can replace. */
export function failed(parts: Parts): string[] {
  const out: string[] = []
  for (const key in parts) {
    if (parts[key] === ERR || parts[key] === TIMEOUT) out[out.length] = key
  }
  try {
    out.sort()
  } catch (e) {
    // a page that broke sorting still gets every name, in reading order; hashing sorts too, so it gets no id either
  }
  return out
}

/** The values an id is built from: hardware ("hw.") and settings ("p."). Every other value is a hint. */
export function idParts(parts: Parts): Parts {
  const keys = Object.keys(parts)
  const out: Parts = {}
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('hw.') === 0 || keys[i].indexOf('p.') === 0) out[keys[i]] = parts[keys[i]]
  }
  return out
}

/** The user's text-size setting as one value: Dynamic Type on WebKit, else the scale factor wherever the browser shows it. */
function textScale(c: Parts): Raw {
  const apple = c['x.txt.apple']
  const scale = c['x.txt.env']
  const size = c['x.txt.fs']
  if (typeof apple === 'number') return apple
  // a value that decides here and was not read leaves no id: the next one standing in would be another definition, unflagged
  if (apple === ERR || apple === TIMEOUT) return apple
  if (scale === ERR || scale === TIMEOUT) return scale
  // Chrome reports the setting only through the scale; an in-app browser before Chromium 138 only through the font size
  if (typeof scale === 'number' && scale !== 1) return scale
  if (typeof size === 'number') return Math.round(size) / 100
  // every engine computes the fixed 100px font, so no number there is a failed probe
  return size === TIMEOUT ? size : ERR
}

/** The OS version from client hints, for a user agent that hides it. "17.0.0" is written "17", as an in-app browser that names it writes it. */
export function hintedOs(c: Parts): string | null {
  const platform = c['x.ch.pv']
  return typeof platform === 'string' && /^\d/.test(platform) ? platform.replace(/(\.0)+$/, '') : null
}

/** The version fields a strict id adds. A reading has them all. */
export interface Versions {
  osVer: string | null
  app: string
  appVer: string | null
  engineVer: number | null
}

/**
 * Completes the id parts in `c` from the values read so far and returns both ids. `skip` names what this browser randomises.
 * It touches no browser object, so the lab can replay it on the values a test page stored.
 */
export function seal(c: Parts, skip: { [name: string]: boolean }, versions: Versions): { id: string | null; idStrict: string | null } {
  c['p.txt'] = textScale(c)
  if (c['hw.model'] === NA) {
    // no model: screen size and core count stand in for it
    c['hw.scr'] = skip.scr ? EXCLUDED : c['x.scr']
    c['hw.cores'] = skip.cores ? EXCLUDED : c['x.cores']
  }
  const parts = idParts(c)
  const id = makeId(parts).id
  // versions separate two phones of one model inside a short window, and move with every update
  parts['v.os'] = versions.osVer || NA
  parts['v.app'] = versions.app
  parts['v.appVer'] = versions.appVer || NA
  parts['v.engine'] = versions.engineVer || NA
  return { id: id, idStrict: id && makeId(parts).id }
}
