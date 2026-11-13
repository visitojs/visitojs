import { load, save } from './cache.js'
import { Did, readDid } from './did.js'
import { Build, detectBuild } from './env.js'
import { ERR, EXCLUDED, NA, Raw, safe, TIMEOUT } from './guard.js'
import { short } from './hash.js'
import { failed, hintedOs, ID_VERSION, Parts, seal } from './reading.js'
import { automation, cores, language, memory, screenSize, Win } from './reads.js'
import { parseUa } from './ua.js'

export interface Reading extends Did {
  v: number
  model: string | null
  os: string
  osVer: string | null
  app: string
  appVer: string | null
  engineVer: number | null
  /** Raw values: "hw." and "p." build the id, "x." are hints, "r." are rendering values. */
  c: Parts
  id: string | null
  idStrict: string | null
  /** `private`: true when this session's storage is not kept (a private window, or an app's in-memory web view), false when the browser shows it is kept, null when unknown or, in the product build, when the stored id is not new. `weak`: no model anchors the id. */
  flags: { partial: string[]; auto: string[]; private: boolean | null; weak: boolean }
  /** Milliseconds of work so far. */
  ms: number
  /** Milliseconds per step, so a slow read can be found on a real phone. */
  t: { [step: string]: number }
}

/** The reads that touch the DOM or wait. Passed in so tests can replace them. */
export interface Probes {
  textSize: (w: Win, env: Build) => Parts
  hints: (w: Win, done: (values: Parts) => void) => void
  privateWindow: (w: Win, env: Build, done: (values: Parts) => void) => void
}

export interface Task {
  name: string
  keys: string[]
  run: (done: (values: Parts) => void) => void
}

/** A further stage after stage B. Only the lab build has one. */
export interface Stage {
  tasks: (w: Win) => Task[]
  /** Calls `go` when the stage may start; a second call is ignored. */
  wait: (w: Win, go: () => void) => void
}

export interface Session {
  reading: () => Reading | null
  /** Calls back once, never before returning, when every stage has finished or the time cap was reached. */
  whenDone: (callback: (reading: Reading | null) => void) => void
}

interface Context {
  w: Win
  reading: Reading
  env: Build
  reduced: boolean
  skip: { [name: string]: boolean }
  store: Storage | null
  cacheKey: string
  uaKey: string
  /** Milliseconds of running time left after stage A. */
  budget: number
  /** Values read after stage A: what the cache holds. */
  late: Parts
}

const DEFAULT_NAME = '_visito'
const BUDGET_MS = 4000
const PARSE_WAIT_MS = 10000
const WATCHDOG_MS = 30000

/** The fine clock, else the coarse one. Always a finite number: a page can break either after script start, and arithmetic on what it answers could throw. */
export function now(w: Win): number {
  let t: unknown
  try {
    t = w.performance.now()
  } catch (e) {
    // fall through to the coarse clock
  }
  try {
    if (typeof t !== 'number') t = Date.now()
  } catch (e) {
    // time then stands still, and the watchdog still ends the session
  }
  // typeof first: the subtraction converts nothing that is not already a number
  return typeof t === 'number' && t - t === 0 ? t : 0
}

export function round(ms: number): number {
  // no Math call: a page may replace Math after script start
  return ((ms * 100 + 0.5) | 0) / 100
}

function storageOf(w: Win, name: string): Storage | null {
  try {
    return w[name] || null
  } catch (e) {
    // reading the property itself throws when storage is disabled
    return null
  }
}

function randomBytes(w: Win): number[] {
  const out: number[] = []
  try {
    const buffer = new Uint8Array(16)
    ;(w.crypto || w.msCrypto).getRandomValues(buffer)
    for (let i = 0; i < 16; i++) out[i] = buffer[i]
    return out
  } catch (e) {
    // engines without a crypto source: a weaker id is still better than none
    for (let i = 0; i < 16; i++) out[i] = Math.floor(Math.random() * 256)
    return out
  }
}

/** `fn`, made to run once at most: a channel or a timer a page has wrapped can deliver it and still throw, and then each fallback would run it again. */
function one(fn: () => void): () => void {
  return function () {
    const run = fn
    fn = function () {}
    run()
  }
}

/** Runs `fn` once, after the current task, on the page's timer when it has one. */
export function later(w: Win, fn: () => void, ms: number): void {
  fn = one(fn)
  try {
    w.setTimeout(fn, ms)
  } catch (e) {
    try {
      setTimeout(fn, ms)
    } catch (e) {
      // no timer at all: run it now, through safe() so that a callback that throws cannot stop the ones after it (its error is dropped)
      safe(fn)
    }
  }
}

/**
 * Continues in a task of its own, so the page can handle input first. A message is delivered as its own task and, unlike a timer,
 * is not held back by the nesting clamp (HTML, "Message ports" and "Timers"). Setting `onmessage` enables the port's queue.
 */
export function yieldTo(w: Win, fn: () => void): void {
  fn = one(fn)
  try {
    const ports = new w.MessageChannel()
    ports.port1.onmessage = function () {
      try {
        // one message per channel: closing lets the browser drop both ports at once
        ports.port1.close()
      } catch (e) {
        // an unclosed port is collected anyway
      }
      fn()
    }
    ports.port2.postMessage(0)
  } catch (e) {
    later(w, fn, 0)
  }
}

/** The id parts each browser alters on purpose: recorded as excluded and left out of the id. Sources are in docs/DECISIONS.md. */
function exclusions(env: Build): { [name: string]: boolean } {
  return {
    // Brave randomises both per session and site at its default level (its own documentation), and both moved between our visits
    mem: env.brave,
    cores: env.brave || env.firefox143,
    // Brave alters the screen resolution too; on Android it read the same as Chrome's on one phone, so only its desktop builds lose it
    scr: env.safari17 || env.firefox143 || (env.brave && !env.android),
  }
}

/** Stage A: everything that needs no DOM and no waiting, run once at script start. `bare`: no cookie and no storage is read or written. */
function begin(w: Win, bare?: boolean): Context | null {
  try {
    // a frame, or a cross-origin top that throws when read (caught below), gets no reading
    if (typeof Object.keys !== 'function' || typeof Date.now !== 'function' || w.top !== w.self) return null
    const start = now(w)
    const t: { [step: string]: number } = {}
    let mark = start
    const lap = function (step: string): void {
      const at = now(w)
      t[step] = round(at - mark)
      mark = at
    }

    let userAgent = ''
    try {
      userAgent = String(w.navigator.userAgent)
    } catch (e) {
      // an empty user agent parses to "unknown", which is the truth here
    }
    const ua = parseUa(userAgent)
    lap('ua')

    const config = w.VisitoConfig || {}
    const name = typeof config.did === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(config.did) ? config.did : DEFAULT_NAME
    // bare: readDid then finds no id, keeps none and reports none, as where the browser blocks storage
    const local = bare ? null : storageOf(w, 'localStorage')
    const did = readDid({
      doc: bare ? null : w.document || null,
      storage: local,
      name: name,
      secure: !!w.location && w.location.protocol === 'https:',
      random: function () {
        return randomBytes(w)
      },
    })
    lap('did')

    const env = detectBuild(w)
    const skip = exclusions(env)
    lap('env')

    // a reduced user agent means the model is still to come from client hints
    const c: Parts = { 'hw.model': ua.model || (ua.reduced ? TIMEOUT : NA) }
    c['hw.mem'] = skip.mem ? EXCLUDED : memory(w)
    lap('hw.mem')
    c['p.lang'] = language(w)
    lap('p.lang')
    // the text size needs the document: the id waits for it
    c['p.txt'] = TIMEOUT
    c['x.engine'] = env.engine
    c['x.android'] = env.android
    const marks = automation(w, ua, env)
    lap('auto')

    return {
      w: w,
      env: env,
      reduced: ua.reduced,
      skip: skip,
      store: bare ? null : local || storageOf(w, 'sessionStorage'),
      cacheKey: name + '_c',
      uaKey: short(userAgent),
      budget: BUDGET_MS,
      late: {},
      reading: {
        v: ID_VERSION,
        did: did.did,
        didNew: did.didNew,
        didSrc: did.didSrc,
        model: ua.model,
        os: ua.os,
        osVer: ua.osVer,
        app: ua.app,
        appVer: ua.appVer,
        engineVer: ua.engineVer,
        c: c,
        id: null,
        idStrict: null,
        flags: { partial: failed(c), auto: marks, private: null, weak: c['hw.model'] === NA },
        ms: round(now(w) - start),
        t: t,
      },
    }
  } catch (e) {
    return null
  }
}

/** Stage A alone, for callers and tests that want only what is available at script start. */
export function stageA(w: Win): Reading | null {
  const context = begin(w)
  return context ? context.reading : null
}

function put(context: Context, values: Parts): void {
  for (const key in values) {
    // skips what a page added to Object.prototype, with an operator: hasOwnProperty is a built-in the page may have replaced
    if (key in {}) continue
    context.reading.c[key] = values[key]
    context.late[key] = values[key]
  }
}

/** After stage B: the model and OS version of a reduced user agent, the text size, the stand-ins for a missing model, then both ids. */
function settle(context: Context): void {
  const reading = context.reading
  const c = reading.c
  reading.id = reading.idStrict = null
  try {
    if (context.reduced) {
      const model: Raw = c['x.ch.model']
      if (typeof model === 'string' && model && model[0] !== '!') {
        c['hw.model'] = model
        reading.model = model
      } else if (model !== TIMEOUT && model !== ERR) {
        c['hw.model'] = NA
      }
      // the same user agent hides the OS version
      reading.osVer = reading.osVer || hintedOs(c)
    }
    if (c['hw.model'] === NA) {
      // read only now, and only because nothing else stands in for the missing model
      c['x.scr'] = screenSize(context.w)
      c['x.cores'] = cores(context.w)
    }
    const ids = seal(c, context.skip, reading)
    reading.id = ids.id
    reading.idStrict = ids.idStrict
  } catch (e) {
    // a page that replaced a built-in this needs (Math, String, RegExp, sorting) cannot be hashed: the reading says so instead of throwing into the page
    c['x.id'] = ERR
  }
  // set after the try, which can stop once the model is settled
  reading.flags.weak = c['hw.model'] === NA
  reading.flags.partial = failed(c)
}

/** Runs tasks one after another, each in its own turn so the page can handle a tap between any two, within the running-time budget. */
function runTasks(context: Context, tasks: Task[], end: () => void, ended: () => boolean): void {
  const w = context.w
  let index = 0
  const record = function (task: Task, values: Parts | null, status: Raw): void {
    if (!values) {
      values = {}
      for (let i = 0; i < task.keys.length; i++) values[task.keys[i]] = status
    }
    put(context, values)
  }
  const step = function (): void {
    if (ended()) return
    // out of running time: every task left is named as timed out
    while (index < tasks.length && context.budget <= 0) {
      const skipped = tasks[index++]
      record(skipped, null, TIMEOUT)
      context.reading.t[skipped.name] = 0
    }
    if (index >= tasks.length) return end()
    // taken outside the loop above, so the callback below closes over one task without a scope per iteration
    const task = tasks[index++]
    const started = now(w)
    let inCall = true
    let answered = false
    try {
      task.run(function (values: Parts) {
        if (answered || ended()) return
        answered = true
        record(task, values, ERR)
        if (!inCall) yieldTo(w, step)
      })
    } catch (e) {
      if (!answered) {
        answered = true
        record(task, null, ERR)
      }
    }
    inCall = false
    // only the time the page was kept busy counts: a read waiting on the browser costs the page nothing
    const busy = now(w) - started
    context.budget -= busy
    context.reading.t[task.name] = round(busy)
    context.reading.ms = round(context.reading.ms + busy)
    // an unanswered task is waiting on the browser: its callback continues the run
    if (answered) yieldTo(w, step)
  }
  step()
}

/** Starts a session: stage A now, stage B at DOMContentLoaded. The lab build passes one more stage and then nothing is cached. `bare` stores nothing. Never throws. */
export function start(w: Win, p: Probes, lab?: Stage, bare?: boolean): Session {
  const context = begin(w, bare)
  const waiting: Array<(reading: Reading | null) => void> = []
  let done = !context
  const reading = context ? context.reading : null

  let watchdog: unknown
  const finish = function (): void {
    if (done || !context) return
    done = true
    try {
      w.clearTimeout(watchdog)
    } catch (e) {
      // the timer is a no-op once the session is done
    }
    const answer = context.reading.c['x.private']
    context.reading.flags.private = typeof answer === 'boolean' ? answer : null
    // the answer is about this visit only: it is never replayed from the cache
    delete context.late['x.private']
    context.reading.flags.partial = failed(context.reading.c)
    if (!lab && !context.reading.flags.partial.length) save(context.store, context.cacheKey, context.uaKey, context.late)
    for (let i = 0; i < waiting.length; i++) notify(waiting[i])
    waiting.length = 0
  }
  const notify = function (callback: (reading: Reading | null) => void): void {
    // later() runs it once, even where a wrapped timer schedules it and still throws
    later(w, function () {
      callback(reading)
    }, 0)
  }

  if (context) {
    const sync = function (name: string, keys: string[], read: () => Parts): Task {
      return { name: name, keys: keys, run: function (answer) { answer(read()) } }
    }
    const tasksB: Task[] = [sync('text', ['x.txt.env', 'x.txt.fs', 'x.txt.w', 'x.txt.apple'], function () { return p.textSize(w, context.env) })]
    // client hints are asked only when the user agent hides the model; no push() here or below, since a page may have replaced it
    if (context.reduced || lab) tasksB[tasksB.length] = { name: 'hints', keys: ['x.ch.model'], run: function (answer) { p.hints(w, answer) } }
    // a stored id that was already there proves the storage is not fresh, and only WebKit and Gecko can be told at all;
    // bare asks nothing: the check opens the origin's file system, which Gecko creates on disk
    const freshStorage = context.reading.didNew || context.reading.did === null
    const tells = context.env.engine === 'webkit' || context.env.engine === 'gecko'
    if (tells && !bare && (lab || freshStorage)) {
      tasksB[tasksB.length] = { name: 'private', keys: ['x.private'], run: function (answer) { p.privateWindow(w, context.env, answer) } }
    }
    const tasksC: Task[] = lab ? lab.tasks(w) : []

    const isDone = function (): boolean {
      return done
    }
    let startedB = false
    let startedC = false
    const runC = function (): void {
      if (startedC || done) return
      startedC = true
      runTasks(context, tasksC, finish, isDone)
    }
    const afterB = function (): void {
      settle(context)
      if (lab && tasksC.length) lab.wait(w, runC)
      else finish()
    }
    const runB = function (): void {
      if (startedB || done) return
      startedB = true
      runTasks(context, tasksB, afterB, isDone)
    }
    // last resort: whatever the page does, the caller hears back, with the unread values named as timed out
    const expire = function (): void {
      if (done) return
      const mark = function (tasks: Task[]): void {
        for (let i = 0; i < tasks.length; i++) {
          for (let k = 0; k < tasks[i].keys.length; k++) {
            if (!(tasks[i].keys[k] in context.reading.c)) context.reading.c[tasks[i].keys[k]] = TIMEOUT
          }
        }
      }
      // two calls, not concat(): a page may have replaced it
      mark(tasksB)
      mark(tasksC)
      settle(context)
      finish()
    }

    const cached = lab ? null : load(context.store, context.cacheKey, context.uaKey)
    if (cached) {
      put(context, cached)
      context.reading.t.cache = 0
      settle(context)
      done = true
    } else {
      try {
        watchdog = w.setTimeout(expire, WATCHDOG_MS)
      } catch (e) {
        // no timer on this window: the stages below still run
      }
      try {
        if (w.document.readyState === 'loading') {
          w.document.addEventListener('DOMContentLoaded', runB)
          later(w, runB, PARSE_WAIT_MS)
        } else yieldTo(w, runB)
      } catch (e) {
        yieldTo(w, runB)
      }
    }
  }

  return {
    reading: function () {
      return reading
    },
    whenDone: function (callback) {
      if (done) notify(callback)
      else waiting[waiting.length] = callback
    },
  }
}
