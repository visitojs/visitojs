// What each automation mark should show in each context lab/marks.mjs runs, worked out from what the harness knows: how the browser
// was started, the user agent it set or the one the page request carried, the fixture it installed. Never from the page's own reading.
// test/mark-truth.test.mjs checks these rules on their own.

/** The automation mark candidates the lab build records as x.bot.<mark>, in its order (src/botlab.ts). None ships in 1.0. */
export const CANDIDATES = ['own-value', 'frame-window', 'frame-srcdoc', 'no-webdriver', 'app-version', 'plain-getter', 'plugins-type', 'ua-version', 'no-platform-hint', 'runtime-constructible']
/** The core's flags.auto marks, a closed list for 1.0. */
export const CORE_MARKS = ['webdriver', 'global', 'no-languages', 'headless', 'platform', 'no-touch', 'no-brands', 'not-android']
/** Marks that say two values disagree. A person can cause these by configuring their browser; the others say automation is present. */
export const INCONSISTENCY = ['platform', 'no-touch', 'no-brands', 'not-android', 'app-version', 'own-value', 'plain-getter', 'plugins-type', 'ua-version', 'no-platform-hint']

/** The OS a user agent names, by the harness's own rule (not the library's parser): enough to know what the harness asked for. */
export function uaOs(userAgent) {
  const ua = String(userAgent || '')
  if (/Android/.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Windows/.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac'
  return 'other'
}

/**
 * The truth for one mark in one context: "produced" when the harness or the tool's documented behaviour made the state (a firing is a
 * true observation, silence is a miss), "allowed" when automation or the harness's emulation may make it (a firing is a true
 * observation, silence is not a miss), "absent" when nothing made it (a firing is a false positive, or person-caused, see judge).
 * ctx: { launch: 'clean' | 'driven', browser, engine: 'blink' | 'gecko' | 'webkit', host: 'windows' | ..., userAgent, uaSet, headless, shell, fixture, testBuild }
 */
export function truth(mark, ctx) {
  const os = uaOs(ctx.userAgent)
  // the user agent the page got names another OS than the one the browser runs on: the harness's emulation, or the tool's own default
  // (Playwright's WebKit driver sends a Mac user agent from Windows, measured 2026-11-13)
  const foreign = os !== ctx.host && os !== 'other'
  const mobile = os === 'android' || os === 'ios'
  // a fixture makes one candidate's state and nothing else; the launch decides the rest
  if (ctx.fixture && CANDIDATES.indexOf(mark) >= 0) return mark === ctx.fixture ? 'produced' : 'absent'
  if (ctx.launch === 'clean') {
    // Playwright's Firefox and WebKit builds report navigator.webdriver as true even when no driver is attached (measured): the build
    // says it is automated, so the mark reports the build truly; released Firefox and Safari are not these builds and are owed
    if (mark === 'webdriver' && ctx.testBuild) return 'allowed'
    return 'absent'
  }
  switch (mark) {
    // MDN, Navigator.webdriver: Chrome sets it under --enable-automation or --headless, which every driven Chromium launch has
    case 'webdriver':
      return ctx.engine === 'blink' ? 'produced' : 'allowed'
    // the headless shell names itself in its user agent unless a context replaced it
    case 'headless':
      return ctx.engine === 'blink' && ctx.headless && !ctx.uaSet ? (ctx.shell ? 'produced' : 'allowed') : 'absent'
    case 'platform':
      return foreign ? 'allowed' : 'absent'
    // Playwright's touch emulation does not set maxTouchPoints in Firefox or WebKit (measured): a phone user agent may come with 0
    case 'no-touch':
      return mobile ? 'allowed' : 'absent'
    case 'no-brands':
      return ctx.engine === 'blink' && ctx.uaSet ? 'allowed' : 'absent'
    case 'not-android':
      return ctx.engine === 'blink' && os === 'android' ? 'allowed' : 'absent'
    // the held-back candidates compare the user agent with the engine: an emulated one may disagree with it
    case 'ua-version':
    case 'no-platform-hint':
      return foreign || ctx.uaSet ? 'allowed' : 'absent'
    default:
      return 'absent'
  }
}

/**
 * One mark in one run: "true" (a true observation), "fp" (a false positive), "person" (an inconsistency mark in a context the person
 * configured: counted apart), "miss" (produced but not seen), or "quiet" (not seen, nothing to see). ctx.configured marks a clean
 * launch the person changed: a user-agent switch, fingerprinting protection, resist fingerprinting. ran: whether the check ran, or
 * undefined where that is not known (flags.auto).
 */
export function judge(mark, ctx, fired, ran) {
  const want = truth(mark, ctx)
  // a mark that could not be looked for ("!na") is not a miss
  if (!fired) return want === 'produced' && ran !== false ? 'miss' : 'quiet'
  if (want !== 'absent') return 'true'
  return ctx.launch === 'clean' && ctx.configured && INCONSISTENCY.indexOf(mark) >= 0 ? 'person' : 'fp'
}


/** The app family a user agent names, by the harness's own rule: enough to know which side of the gate the harness put a page on. */
export function uaApp(userAgent) {
  const ua = String(userAgent || '')
  if (/\bEdg\//.test(ua)) return 'edge'
  if (/\bOPR\//.test(ua)) return 'opera'
  if (/SamsungBrowser\//.test(ua)) return 'samsung'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  return 'other'
}

/** The Blink major the harness launched: ctx.major when it set one, else the build's own version. */
export function majorOf(ctx) {
  return typeof ctx.major === 'number' ? ctx.major : parseInt(ctx.version, 10)
}

/** The gate a mark would ship behind, by the harness's own facts: Blink, a Windows Chrome or Edge user agent, and an engine at or above the floor. */
export function inGate(ctx, floor) {
  const app = uaApp(ctx.userAgent)
  return ctx.engine === 'blink' && uaOs(ctx.userAgent) === 'windows' && (app === 'chrome' || app === 'edge') && majorOf(ctx) >= floor
}

/**
 * Each anchor a mark can be gated with, and the Chrome version that first accepts it, from MDN's browser compatibility data
 * (docs/DECISIONS.md cites each entry).
 */
export const ANCHOR_VERSIONS = {
  // css.selectors.focus-visible; CSS.supports('selector(...)') is in Chrome from 83 (css.at-rules.supports.selector)
  'selector(:focus-visible)': 86,
  // css.properties.font-palette
  '(font-palette:normal)': 101,
}

/**
 * The anchor each candidate would be gated with if it shipped: the oldest Chrome its ladder rungs were clean from. A candidate with
 * none has no measured floor and counts from MIN_BLINK.
 */
export const PROPOSED_ANCHORS = { 'own-value': 'selector(:focus-visible)', 'frame-window': 'selector(:focus-visible)', 'no-webdriver': '(font-palette:normal)' }

/** The extension configurations a clean launch is run with: the kinds of extension people run (R24). */
export const EXTENSIONS = ['ua-switcher edge-windows', 'ua-switcher edge-windows-ua-only', 'ua-switcher edge-windows-full-profile', 'ua-switcher chrome-mac', 'ua-switcher firefox-windows', 'language-switcher', 'hardware-spoofer', 'plugin-emulator', 'plugin-emulator no-pdf', 'privacy', 'password-manager']
/** The page policies every mark is loaded under, in every engine. */
export const POLICIES = ['tt-enforced', 'tt-report-only', 'csp-strict']
export const POLICY_ENGINES = ['chromium', 'firefox', 'webkit']
/** Where the cost is measured, headed, on a navigated page, and the bar its median must stay under (research/designs/bot.md). */
export const COST_BROWSERS = ['chromium', 'chrome', 'msedge']
export const COST_CONTEXTS = 30
export const COST_MEDIAN_MS = 1
/** Versions between two clean rungs of the ladder this far apart or closer are counted as covered. */
export const MAX_STEP = 12
/** The oldest Chrome the library supports. */
export const MIN_BLINK = 53

/** The floor a candidate is judged from: the version of its proposed anchor, or the oldest Chrome the library supports. */
export function floorOf(mark) {
  const anchor = PROPOSED_ANCHORS[mark]
  return anchor ? ANCHOR_VERSIONS[anchor] : MIN_BLINK
}

/** Populations the gate leaves out in code, listed so the docs can say so. */
const EXCLUDED = ['macOS', 'Linux', 'ChromeOS', 'Android', 'iOS', 'Opera', 'Samsung Internet', 'Firefox', 'Safari']
/**
 * Inside the gate, and neither measured by this harness nor separable by any test a mark can make: apps that embed Blink and send a
 * Windows Chrome or Edge user agent. They block every mark until evidence.embedders says they were measured clean.
 */
export const EMBEDDERS = 'Blink embedders and forks that send a Windows Chrome or Edge user agent (Electron, CEF, WebView2 hosts, other forks)'

/**
 * Counts per mark, source ("lab": the lab build's x.bot.* keys inside the gate; "lab-outside": the same beyond it; "core": flags.auto)
 * and context. Each record is one page load: { source, key, ctx, marks, ran },
 * where key names the context, so a mark firing in only some runs of one context is flagged as nondeterministic.
 */
export function tally(records) {
  const rows = {}
  for (const record of records) {
    for (const mark of Object.keys(record.marks)) {
      const fired = record.marks[mark] === true
      const id = [mark, record.source, record.key].join('|')
      const row = (rows[id] = rows[id] || { mark, source: record.source, key: record.key, launch: record.ctx.launch, browser: record.ctx.browser, major: majorOf(record.ctx), extension: record.ctx.extension || null, ctx: record.ctx, runs: 0, ran: 0, fired: 0, true: 0, fp: 0, person: 0, miss: 0, contexts: [record.key], fpContexts: [], personContexts: [], nondeterministic: [] })
      row.runs++
      if (record.ran && record.ran[mark]) row.ran++
      if (fired) row.fired++
      const said = judge(mark, record.ctx, fired, record.ran ? record.ran[mark] === true : undefined)
      if (said !== 'quiet') row[said]++
      if (said === 'fp' && !row.fpContexts.length) row.fpContexts.push(record.key)
      if (said === 'person' && !row.personContexts.length) row.personContexts.push(record.key)
    }
  }
  for (const row of Object.values(rows)) if (row.fired && row.fired !== row.runs) row.nondeterministic.push(row.key)
  return Object.values(rows)
}

/** Branded browsers installed on the machine, started as a person starts them: a mark must have run in at least one. */
export const REAL = ['chrome', 'edge', 'brave']

/**
 * Every population inside or around a mark's gate and whether it was measured: { name, inGate, status: 'measured' | 'excluded' |
 * 'owed' | 'failed' }. evidence: { floor, newest, policies: [{ policy, engine, loads, console, violations, reports }],
 * cost: [{ browser, contexts, median, max }], ceiling, embedders }. ceiling: the newest Blink a gate would let the mark run on, which
 * must be a version that was measured; without one, every Blink newer than the newest measured build is inside the gate and owed.
 * embedders: 'measured' once the embedders inside the gate were measured clean. Rows are tally rows; only the lab source counts.
 */
export function populations(rows, mark, evidence) {
  const out = []
  const floor = evidence.floor
  const mine = rows.filter((row) => row.mark === mark && row.source === 'lab')
  // the lab build's rows beyond the gate too: an extension whose user agent leaves the gate is excluded there, not owed
  const anywhere = rows.filter((row) => row.mark === mark && (row.source === 'lab' || row.source === 'lab-outside'))
  const bad = (row) => row.fp > 0 || row.person > 0 || row.nondeterministic.length > 0
  // (b) versions: a rung is clean when clean launches at that major looked for the mark and nothing fired anywhere at that major
  const rungs = {}
  for (const row of mine) {
    if (!Number.isFinite(row.major)) continue
    const rung = (rungs[row.major] = rungs[row.major] || { ran: 0, bad: false })
    if (row.launch === 'clean') rung.ran += row.ran
    if (bad(row)) rung.bad = true
  }
  const clean = Object.keys(rungs).map(Number).filter((major) => rungs[major].ran > 0 && !rungs[major].bad).sort((a, b) => a - b)
  const newest = evidence.newest || clean[clean.length - 1] || floor
  for (let v = MIN_BLINK; v <= newest; v++) {
    const name = 'Blink ' + v
    if (v < floor) {
      out.push({ name, inGate: false, status: 'excluded' })
      continue
    }
    const below = clean.filter((major) => major <= v).pop()
    const above = clean.filter((major) => major >= v)[0]
    const covered = below === v || (below !== undefined && above !== undefined && above - below <= MAX_STEP)
    out.push({ name, inGate: true, status: covered ? 'measured' : rungs[v] && rungs[v].bad ? 'failed' : 'owed' })
  }
  // (a) extensions: run at every Chromium rung inside the gate, or left out by the gate there
  const chromiumRungs = [...new Set(mine.filter((row) => row.browser === 'chromium' && row.launch === 'clean' && row.major >= floor).map((row) => row.major))]
  for (const extension of EXTENSIONS) {
    const name = extension + ' extension'
    const runs = anywhere.filter((row) => row.extension === extension && row.launch === 'clean' && row.major >= floor)
    if (!runs.length) {
      out.push({ name, inGate: true, status: 'owed' })
      continue
    }
    if (!runs.some((row) => inGate(row.ctx, floor))) {
      out.push({ name, inGate: false, status: 'excluded' })
      continue
    }
    const missing = chromiumRungs.filter((major) => !runs.some((row) => row.major === major && row.ran > 0))
    out.push({ name, inGate: true, status: runs.some(bad) ? 'failed' : missing.length ? 'owed' : 'measured', missing })
  }
  // (c) page policies, in every engine
  for (const policy of POLICIES) {
    for (const engine of POLICY_ENGINES) {
      const seen = (evidence.policies || []).find((p) => p.policy === policy && p.engine === engine)
      const status = !seen || !seen.loads ? 'owed' : seen.console || seen.violations || seen.reports ? 'failed' : 'measured'
      out.push({ name: `${policy} page in ${engine}`, inGate: true, status })
    }
  }
  // (d) the cost at script start
  for (const browser of COST_BROWSERS) {
    const seen = (evidence.cost || []).find((c) => c.browser === browser)
    const status = !seen || seen.contexts < COST_CONTEXTS ? 'owed' : seen.median > COST_MEDIAN_MS ? 'failed' : 'measured'
    out.push({ name: 'cost in ' + browser, inGate: true, status })
  }
  // (e) Blink released after the newest build measured: inside the gate unless the gate stops at a measured version
  const capped = Number.isFinite(evidence.ceiling) && evidence.ceiling <= newest
  out.push({ name: `Blink newer than ${newest}`, inGate: !capped, status: capped ? 'excluded' : 'owed' })
  for (const name of EXCLUDED) out.push({ name, inGate: false, status: 'excluded' })
  // (f) embedders that send a Windows Chrome or Edge user agent: no test a mark makes tells them apart, so only measuring them clears them
  out.push({ name: EMBEDDERS, inGate: true, status: evidence.embedders === 'measured' ? 'measured' : 'owed' })
  return out
}

/**
 * Whether a mark ships (R24): no false positive and no person-caused firing in any context at or above its floor, no nondeterminism,
 * run on a clean launch of an installed branded browser, and every population inside its gate measured, the embedders and the Blink
 * releases after the newest measured build included. Without evidence nothing ships. Returns the counts, the populations still owed
 * and the reasons it does not ship; held is true whenever it does not.
 */
export function verdict(rows, mark, evidence) {
  const mine = rows.filter((row) => row.mark === mark && row.source !== 'lab-outside' && !(evidence && row.major < evidence.floor))
  const sum = (key, filter = () => true) => mine.filter(filter).reduce((n, row) => n + row[key], 0)
  const reasons = []
  const fp = sum('fp')
  const person = sum('person')
  // named by configuration: each repeat of one configuration is the same observation
  const named = (key) => [...new Set(mine.flatMap((row) => row[key]))]
  if (fp) reasons.push(`a false positive in ${named('fpContexts').length} configurations (${named('fpContexts').join(', ')})`)
  if (person) reasons.push(`a person-caused firing in ${named('personContexts').length} configurations (${named('personContexts').join(', ')})`)
  const wobbly = mine.flatMap((row) => row.nondeterministic)
  if (wobbly.length) reasons.push(`nondeterministic in ${[...new Set(wobbly)].join(', ')}`)
  const candidate = CANDIDATES.indexOf(mark) >= 0
  const realRuns = sum('ran', (row) => row.source === 'lab' && row.launch === 'clean' && REAL.indexOf(row.browser) >= 0)
  if (candidate && !realRuns) reasons.push('never run on a clean launch of an installed branded browser')
  let owed = []
  if (!evidence) reasons.push('no evidence for the populations inside its gate')
  else {
    owed = populations(rows, mark, evidence).filter((p) => p.inGate && p.status !== 'measured')
    if (owed.length) reasons.push('inside its gate and not measured clean: ' + compress(owed))
  }
  const ships = candidate && !reasons.length
  return { fp, person, realRuns, owed, ships, held: !ships, reasons }
}

/** "Blink 54, Blink 55, ... Blink 60" as "Blink 54 to 60", for the reasons line. */
function compress(pops) {
  const out = []
  for (const p of pops) {
    const m = /^Blink (\d+)$/.exec(p.name)
    const last = out[out.length - 1]
    if (m && last && last.blink && last.to === +m[1] - 1 && last.status === p.status) last.to = +m[1]
    else out.push(m ? { blink: true, from: +m[1], to: +m[1], status: p.status } : { name: p.name, status: p.status })
  }
  return out.map((o) => (o.blink ? `Blink ${o.from}${o.to > o.from ? ' to ' + o.to : ''}` : o.name) + (o.status === 'failed' ? ' (failed)' : '')).join(', ')
}
