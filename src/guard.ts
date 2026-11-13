/** A raw value is what the browser gave, or one of the status strings below. */
export type Raw = string | number | boolean

// The leading "!" cannot collide with a language code, a time zone or a model name.
export const NA = '!na'
export const ERR = '!err'
export const TIMEOUT = '!to'
export const EXCLUDED = '!ex'
export const NOISE = '!noise'

/** Runs one read. A missing value becomes NA and an exception becomes ERR, so no read can throw into the page. */
export function safe(read: () => unknown): Raw {
  try {
    const value = read()
    if (typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && value === value) return value
    return NA
  } catch (e) {
    return ERR
  }
}
