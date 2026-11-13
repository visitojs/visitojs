// The deep entry: a separate id from the canvas and offline audio reads, to help tell desktop computers apart. Experimental: its
// values are not frozen and DEEP_VERSION may change in a minor release. It reads only when called, stores nothing, sends nothing,
// and shares no state with the core build, so it never changes id or idStrict.
import { detectBuild } from './env.js'
import { TIMEOUT } from './guard.js'
import { whenSettled } from './settle.js'
import { Parts } from './reading.js'
import { Win } from './reads.js'
import { audio, digestHolds, geometrySteps } from './render.js'
import { DEEP_VERSION as VERSION, deepRule, excludesAll, sealDeep } from './deepseal.js'
import { now, round, yieldTo } from './stages.js'

/** Version of the deep id definition, independent of the core's. Deep ids compare only within one version. */
export const DEEP_VERSION: number = VERSION

export interface DeepReading {
  /** Version of the deep id definition. */
  v: number
  /** 64 hex characters (SHA-256 of the text in docs/SIGNALS.md), or null when a part failed, timed out, showed noise, or none holds a value. */
  id: string | null
  /**
   * Parts: `r.cg` and `r.audio`, each 16 hex digits or a status (`!na`, `!err`, `!to`, `!ex`, `!noise`); `r.ct` is always `!ex`, the
   * text scene is not read. Hints, never hashed:
   * `r.cchk` and `r.achk`, the check that decided each read, and `x.rule`, the rule that excluded the reads ('' when none did).
   */
  c: Parts
  flags: {
    /** Parts that failed or timed out. */
    partial: string[]
    /** Parts whose alteration check fired: what the browser returned was not what was drawn or rendered. */
    noise: string[]
    /** Parts this browser's rule leaves out. */
    excluded: string[]
    /** An id was built, but some part is excluded or missing in this browser. */
    weak: boolean
  }
  /** Milliseconds the page was kept busy, in total. */
  ms: number
  /** Milliseconds per step. */
  t: { [step: string]: number }
}

type Callback = (reading: DeepReading | null) => void

// Page-busy time for every step together; the audio render's own limit; the time from the first call to an answer, whatever happens.
const BUDGET_MS = 1000
const AUDIO_MS = 1000
const WATCHDOG_MS = 30000

let session: ((callback: Callback) => void) | null = null

/** Runs `fn` on a later turn: the page's timer, else a message. A window where both throw runs it at once, rather than never. */
function soon(w: Win, fn: () => void): void {
  try {
    w.setTimeout(fn, 0)
  } catch (e) {
    yieldTo(w, fn)
  }
}

/** Starts the one session of this page. Returns how a caller is answered. Never throws. */
function begin(w: Win | null): (callback: Callback) => void {
  const waiting: Callback[] = []
  let reading: DeepReading | null = null
  let done = true
  const deliver = function (callback: Callback): void {
    soon(w || {}, function () {
      // once only: a wrapped timer can schedule this and still throw, and the message after it would run it again
      const once = callback
      callback = function () {}
      once(reading)
    })
  }
  try {
    if (w && typeof Object.keys === 'function' && typeof Date.now === 'function' && w.top === w.self) {
      done = false
      const c: Parts = { 'r.audio': TIMEOUT, 'r.cg': TIMEOUT, 'r.cchk': TIMEOUT, 'r.achk': TIMEOUT }
      const current: DeepReading = { v: DEEP_VERSION, id: null, c: c, flags: { partial: [], noise: [], excluded: [], weak: false }, ms: 0, t: {} }
      reading = current
      const rule = deepRule(detectBuild(w))
      let watchdog: unknown
      const finish = function (): void {
        if (done) return
        done = true
        try {
          w.clearTimeout(watchdog)
        } catch (e) {
          // the timer finds the session done
        }
        // the digest's own known answers, checked last, so a fault the page put in while the reads ran is seen too
        let broken = false
        if (!excludesAll(rule)) {
          const at = now(w)
          broken = !digestHolds()
          const busy = now(w) - at
          current.t['check'] = round(busy)
          current.ms = round(current.ms + busy)
        }
        const seal = sealDeep(c, rule, broken)
        current.id = seal.id
        current.flags = seal.flags
        for (let i = 0; i < waiting.length; i++) deliver(waiting[i])
        waiting.length = 0
      }
      if (excludesAll(rule)) {
        // nothing is created in a browser whose reads are excluded: no canvas, no audio context
        finish()
      } else {
        try {
          watchdog = w.setTimeout(finish, WATCHDOG_MS)
        } catch (e) {
          // no timer on this window: the reads still run and answer
        }
        // the geometry scene only: the text scene's value split one machine, so it is neither drawn nor hashed (docs/DECISIONS.md)
        const steps = geometrySteps(w)
        let index = 0
        let budget = BUDGET_MS
        let started = false
        const spend = function (name: string, at: number): void {
          const busy = now(w) - at
          budget -= busy
          current.t[name] = round(busy)
          current.ms = round(current.ms + busy)
        }
        const sound = function (): void {
          if (budget <= 0) return finish()
          let inCall = true
          let answered = false
          const at = now(w)
          audio(w, function (values: Parts) {
            if (done) return
            c['r.audio'] = values['r.audio']
            c['r.achk'] = values['r.achk']
            if (inCall) answered = true
            else finish()
          }, AUDIO_MS)
          inCall = false
          spend('audio', at)
          if (answered) finish()
        }
        // one canvas step per turn, so the page can handle input between any two; past the budget the rest stay "!to"
        const step = function (): void {
          if (done) return
          try {
            if (budget <= 0) return finish()
            const name = 'canvas:' + steps.names[index++]
            const at = now(w)
            const more = steps.next()
            spend(name, at)
            if (more) return yieldTo(w, step)
            const parts = steps.parts()
            c['r.cg'] = parts['r.cg']
            c['r.cchk'] = parts['r.cchk']
            yieldTo(w, sound)
          } catch (e) {
            // whatever was not read is "!to", and the caller still hears back
            finish()
          }
        }
        whenSettled(w, function () {
          if (started || done) return
          started = true
          step()
        })
      }
    }
  } catch (e) {
    done = true
    reading = null
  }
  return function (callback) {
    if (done) deliver(callback)
    else waiting[waiting.length] = callback
  }
}

/**
 * Starts the reads on the first call, never at import or load. Calls back once per call, after returning, with the same reading
 * for every caller, or with null in a frame, outside a browser, or without Object.keys or Date.now. Never throws. The answer and the
 * 30 s watchdog go through the page's own timers: a page whose setTimeout and MessageChannel both throw can be answered before get()
 * returns, and one whose setTimeout silently drops what it is given may never be answered.
 */
export function get(callback: Callback): void {
  if (typeof callback !== 'function') return
  try {
    session = session || begin(typeof window !== 'undefined' ? (window as unknown as Win) : null)
    session(callback)
  } catch (e) {
    // the session catches its own faults; this is for a callback queue the page broke
  }
}
