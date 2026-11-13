import { Win } from './reads.js'
import { later, Probes, Reading, Session, Stage, start } from './stages.js'

export interface Api {
  getSync: () => Reading | null
  get: (callback: (reading: Reading | null) => void) => void
}

export interface StartOptions {
  /** Absent or true: store as the core build does. Anything else, a getter that throws included: read and write no cookie and no storage. */
  store?: boolean
}

export interface DeferredApi extends Api {
  start: (options?: StartOptions) => void
}

/** The two public calls, bound to one session. The real window enters here as untrusted input; outside a browser there is nothing to read. */
export function open(probes: Probes, lab?: Stage): Api {
  const session = typeof window !== 'undefined' ? start(window as unknown as Win, probes, lab) : null
  return {
    getSync: function () {
      return session ? session.reading() : null
    },
    get: function (callback) {
      if (typeof callback !== 'function') return
      if (session) return session.whenDone(callback)
      // no window: later() falls back to the global timer, or calls at once where there is none
      later(null as unknown as Win, function () {
        callback(null)
      }, 0)
    },
  }
}

/** The same calls, plus start(): until it runs nothing is read, not even `window`. The first start() decides for the page view. */
export function deferred(probes: Probes): DeferredApi {
  let session: Session | null = null
  let started = false
  const waiting: Array<(reading: Reading | null) => void> = []
  const hand = function (callback: (reading: Reading | null) => void): void {
    if (session) return session.whenDone(callback)
    later(null as unknown as Win, function () {
      callback(null)
    }, 0)
  }
  return {
    start: function (options) {
      if (started) return
      started = true
      // fails closed: only no options, or an object whose store is absent or true, stores
      let bare = true
      try {
        bare = !(options == null || (typeof options == 'object' && (options.store === undefined || options.store === true)))
      } catch (e) {
        // a getter that throws: store nothing
      }
      session = typeof window !== 'undefined' ? start(window as unknown as Win, probes, undefined, bare) : null
      // by index, not push(): a page may have replaced it
      for (let i = 0; i < waiting.length; i++) hand(waiting[i])
      waiting.length = 0
    },
    getSync: function () {
      return session ? session.reading() : null
    },
    get: function (callback) {
      if (typeof callback !== 'function') return
      if (started) hand(callback)
      else waiting[waiting.length] = callback
    },
  }
}
