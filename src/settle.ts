// When the rendering reads may start: after load, at an idle moment, while the page is shown. The lab stage and the deep entry
// both wait with it; it lives apart from either so that neither brings the other's code into its build.
import { Win } from './reads.js'
import { later } from './stages.js'

const LOAD_WAIT_MS = 3000
const IDLE_TIMEOUT_MS = 2000
// the idle timeout plus a margin, for a browser that pads the timeout or never runs the callback
const IDLE_WAIT_MS = 2500
const NO_IDLE_MS = 200

/** `fn`, run the first time only. */
function onlyOnce(fn: () => void): () => void {
  let done = false
  return function () {
    if (done) return
    done = true
    fn()
  }
}

/** Removes a listener where the page lets it: one left behind finds its wait over and does nothing. */
function quit(target: () => Win, type: string, listener: () => void): void {
  try {
    target().removeEventListener(type, listener)
  } catch (e) {
    // see above
  }
}

/**
 * Three waits in turn, each ended once by whichever of its signals comes first: the page has loaded (or LOAD_WAIT_MS passed),
 * the browser has an idle moment (or IDLE_WAIT_MS passed), the page is shown. Then `go`, once. Never throws. The lab stage and
 * the deep entry both wait with it.
 */
export function whenSettled(w: Win, go: () => void): void {
  // a hidden page gets no rendering reads: they waste battery there and some stall. Only `true` is hidden
  const hidden = function (): boolean {
    try {
      return w.document.hidden === true
    } catch (e) {
      return false
    }
  }
  const start = onlyOnce(function () {
    quit(function () { return w.document }, 'visibilitychange', visible)
    go()
  })
  const visible = function (): void {
    if (!hidden()) start()
  }
  const shown = onlyOnce(function () {
    if (!hidden()) return start()
    try {
      w.document.addEventListener('visibilitychange', visible)
    } catch (e) {
      // no event to wait for: run rather than wait forever
      later(w, start, 0)
    }
  })
  const loaded = onlyOnce(function () {
    quit(function () { return w }, 'load', loaded)
    try {
      // an idle callback can be put off without limit while a page loads, and padded after its timeout (Cooperative Scheduling of Background Tasks)
      w.requestIdleCallback(shown, { timeout: IDLE_TIMEOUT_MS })
      later(w, shown, IDLE_WAIT_MS)
    } catch (e) {
      // no idle callback (every iPhone browser): a short timer lets the page's own load handlers run first
      later(w, shown, NO_IDLE_MS)
    }
  })
  try {
    if (w.document.readyState === 'complete') return loaded()
    // a hung request can hold `load` back for a long time: do not wait for it forever
    later(w, loaded, LOAD_WAIT_MS)
    w.addEventListener('load', loaded)
  } catch (e) {
    later(w, loaded, 0)
  }
}
