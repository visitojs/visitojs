// Whether this session's storage is kept. A session held only in memory (a private window, or an app's in-memory web view) is denied
// the origin private file system in WebKit and in Gecko, and each engine names that denial in its own documented way. See docs/DECISIONS.md.
import { Build } from './env.js'
import { ERR, NA, Raw, safe, TIMEOUT } from './guard.js'
import { once } from './probes.js'
import { Parts } from './reading.js'
import { Win } from './reads.js'

/** Answers `x.private` once, within `ms`: true for a session held in memory, false where an open file system proves storage is kept, otherwise a status. Never throws. */
export function inMemory(w: Win, env: Build, done: (values: Parts) => void, ms?: number): void {
  const webkit = env.engine === 'webkit'
  // no other engine shows it, so nothing is read there
  if (!webkit && env.engine !== 'gecko') return done({ 'x.private': NA })
  let answer = done
  // a promise handler has no caller to catch for it: nothing the page broke may surface as an unhandled rejection
  const reply = function (value: Raw): void {
    try {
      answer({ 'x.private': value })
    } catch (e) {
      // the answer was already given; the fault is the caller's
    }
  }
  try {
    // storage the user blocked for the site denies the file system too, and then reading localStorage throws
    if (safe(function () { return w.localStorage.length >= 0 }) !== true) return reply(NA)
    const storage = w.navigator.storage
    // the storage manager exists only on secure pages, so an insecure one stops here too
    if (!storage || typeof storage.getDirectory != 'function') return reply(NA)
    answer = once(w, ms || 1000, { 'x.private': TIMEOUT }, done)
    // the handle is never used: nothing is created in it, read from it or removed
    storage.getDirectory().then(function () {
      // Gecko is bringing the file system to private windows, so an open one proves nothing there
      reply(webkit ? false : NA)
    }, function (error: { name: string }) {
      // the name is the interface; the message is free text and is never read
      reply(safe(function () { return error.name === (webkit ? 'UnknownError' : 'SecurityError') || NA }))
    })
  } catch (e) {
    reply(ERR)
  }
}
