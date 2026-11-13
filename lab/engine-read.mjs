// One reading from one browser context, for lab/engines.mjs. It takes any object shaped like a Playwright context, so test/engines.test.mjs can drive it without a browser.
const BLOCKED = Symbol('blocked')

// runs in the page: the reading and the user agent come back in one answer, and the page's own timer tells a silent library from an empty reading
const ask = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ userAgent: navigator.userAgent, called: false, value: null }), ms)
  Visito.get((value) => {
    clearTimeout(timer)
    resolve({ userAgent: navigator.userAgent, called: true, value })
  })
})

/**
 * Loads the page and asks it for a reading; returns { reading, error, userAgent }, with error null only when a reading came back.
 * A page that blocks its main thread stops its own timers too, so every step that waits on the page runs under one Node-side limit.
 */
export async function readOnce(context, address, { wait, limit }) {
  let step = 'opening a tab'
  const steps = (async () => {
    const tab = await context.newPage()
    step = 'loading the page'
    await tab.goto(address, { waitUntil: 'load', timeout: limit })
    step = 'asking for the reading'
    return tab.evaluate(ask, wait)
  })()
  // left behind when the page never answers; closing the context rejects it
  steps.catch(() => {})
  let timer
  try {
    const answer = await Promise.race([steps, new Promise((resolve) => (timer = setTimeout(resolve, limit, BLOCKED)))])
    if (answer === BLOCKED) return { reading: null, userAgent: null, error: `the page did not answer within ${limit / 1000} s while ${step}: its main thread is blocked` }
    const { userAgent, called, value } = answer
    if (value) return { reading: value, userAgent, error: null }
    return { reading: null, userAgent, error: called ? `the reading was empty: Visito.get called back with ${value === undefined ? 'nothing' : JSON.stringify(value)}` : `no reading within ${wait / 1000} s` }
  } catch (e) {
    return { reading: null, userAgent: null, error: e.message.split('\n')[0] }
  } finally {
    clearTimeout(timer)
  }
}

// runs in the page: how getDirectory() settles, by the error's name only; the handle is never used
const directory = () => navigator.storage.getDirectory().then(() => 'resolves', (e) => `rejects ${e && e.name}`)

/** How navigator.storage.getDirectory() settles in a fresh tab at address, or why there is no answer, within limit ms. */
export const askDirectory = (context, address, limit) => askPage(context, address, limit, directory)

// runs in the page: how storage.persist() settles, or "waits" when it is still waiting for a permission answer after ms.
// Firefox refuses it at once in private browsing, where storage cannot be kept, and asks the user in a normal window (docs/DECISIONS.md, "Watched every week")
const persistence = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms, 'waits')
  navigator.storage.persist().then((granted) => resolve(`resolves ${granted}`), (e) => resolve(`rejects ${e && e.name}`))
})

/** How navigator.storage.persist() settles in a fresh tab at address: "resolves false", "waits", or why there is no answer, within limit ms. */
export const askPersist = (context, address, limit) => askPage(context, address, limit, persistence, Math.min(2000, limit / 2))

/** Runs fn(arg) in a fresh tab at address and gives its answer, or why there is none, within limit ms. */
async function askPage(context, address, limit, fn, arg) {
  const steps = (async () => {
    const tab = await context.newPage()
    await tab.goto(address, { waitUntil: 'load', timeout: limit })
    return tab.evaluate(fn, arg)
  })()
  steps.catch(() => {})
  let timer
  try {
    const answer = await Promise.race([steps, new Promise((resolve) => (timer = setTimeout(resolve, limit, BLOCKED)))])
    return answer === BLOCKED ? `no answer within ${limit / 1000} s` : answer
  } catch (e) {
    return e.message.split('\n')[0]
  } finally {
    clearTimeout(timer)
  }
}

// the channels Playwright 1.63.0 knows for each browser type; Mozilla's own builds are driven over WebDriver BiDi, which only a moz- channel selects
const CHANNELS = {
  chromium: ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary', 'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary'],
  firefox: ['moz-firefox', 'moz-firefox-beta', 'moz-firefox-nightly'],
  webkit: [],
}

/**
 * Reads lab/engines.mjs's arguments: an engine, then --channel <name>, --executable <path> and --evidence (the drift run's checks).
 * Throws on anything it does not know, so a typo cannot quietly run the pinned build instead of the one asked for.
 */
export function launchOptions(args) {
  const engine = args[0] && !args[0].startsWith('--') ? args[0] : 'chromium'
  if (!Object.hasOwn(CHANNELS, engine)) throw new Error(`unknown engine "${engine}": use chromium, firefox or webkit`)
  let channel = null
  let executable = null
  let evidence = false
  for (let i = args[0] === engine ? 1 : 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--evidence') evidence = true
    else if (flag === '--channel' || flag === '--executable') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      if (flag === '--channel') channel = value
      else executable = value
    } else throw new Error(`unknown argument "${flag}": use --channel <name>, --executable <path> or --evidence`)
  }
  if (channel && !CHANNELS[engine].includes(channel)) {
    throw new Error(`channel "${channel}" is not a ${engine} channel${CHANNELS[engine].length ? `: use ${CHANNELS[engine].join(', ')}` : ''}`)
  }
  if (engine === 'firefox' && executable && !channel) throw new Error('a Firefox executable from Mozilla needs a moz- channel, which selects WebDriver BiDi')
  // Playwright reports its own WebKit version for any WebKit binary, in browser.version() and the user agent, so the table would be for the wrong version
  if (engine === 'webkit' && executable) throw new Error('Playwright reports its own WebKit version whatever executable it drives: run a newer WebKit with the Playwright that ships it')
  const launch = {}
  if (channel) launch.channel = channel
  if (executable) launch.executablePath = executable
  const tag = [engine, channel || (executable ? 'executable' : null)].filter(Boolean).join('-')
  return { engine, channel, executable, evidence, launch, label: [engine, channel].filter(Boolean).join(' '), tag }
}

/** Mozilla's own Firefox builds, which a moz- channel drives over WebDriver BiDi instead of Playwright's patched Firefox. */
export const overBidi = (options) => options.engine === 'firefox' && Boolean(options.channel)

/**
 * Waits for something that opens (a browser, a context) no longer than ms: { value }, { error } with the first line of the error, or { late: true }.
 * What opens after the limit is closed, so nothing is left running.
 */
async function opened(open, ms) {
  let timer
  let late = false
  const opening = (async () => open())()
  opening.then((value) => late && value && value.close && value.close().catch(() => {}), () => {})
  try {
    return await Promise.race([
      opening.then((value) => ({ value }), (e) => ({ error: String(e && e.message).split('\n')[0] })),
      new Promise((resolve) => (timer = setTimeout(() => ((late = true), resolve({ late })), ms))),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Starts a browser with start(), within ms: { browser }, or { error } naming why it did not start. */
export async function startWithin(start, ms) {
  const got = await opened(start, ms)
  if (got.late) return { error: `the browser did not start within ${ms / 1000} s` }
  return got.error !== undefined ? { error: got.error } : { browser: got.value }
}

/** Opens a context in a browser within ms: { context }, or { error } naming why it did not open (a WebDriver BiDi Firefox may refuse an option). */
export async function openContext(target, options, ms) {
  const got = await opened(() => target.newContext(options), ms)
  if (got.late) return { error: `the context did not open within ${ms / 1000} s` }
  return got.error !== undefined ? { error: `the context did not open: ${got.error}` } : { context: got.value }
}

/** Waits for a promise to settle, but never longer than ms: true when it settled, false when it was still waiting. */
export async function within(promise, ms) {
  let timer
  try {
    return await Promise.race([promise.then(() => true, () => true), new Promise((resolve) => (timer = setTimeout(resolve, ms, false)))])
  } finally {
    clearTimeout(timer)
  }
}
