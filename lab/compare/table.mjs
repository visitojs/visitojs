// Turns one or more lab/report/raw/compare-<engine>.json files into a Markdown table with its method.
// Usage: node lab/compare/table.mjs lab/report/raw/compare-chromium.json [more files] > table.md
// Several runs of one engine share one section: a cell that differed between runs shows each run.
// Every cell is a count or a measurement from the files; nothing here grades a library.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classify, sameAs, faultOutcome, spread, baseId } from './judge.mjs'

// the conditions a profile is put through; the first two are compared as their labels say, the others by where they ran
const CONDITIONS = [
  ['cleared', 'cookies and storage cleared, same context, compared with the reloads as shipped'],
  ['second', 'second context (stands in for a private window), compared with the recomputed reloads'],
  ['uaBump', 'user-agent version raised by one'],
  ['rotation', 'rotation (viewport and screen swapped)'],
  ['viewport', 'viewport changed, screen kept'],
]
const APPLIED = { same: 'in the same context, compared with a visit just before it there', new: 'in a new context, compared with the recomputed reloads' }
const NEW_CONTEXT_ALSO = 'changed (a new context alone also changes it)'
const PROFILES = [['phone', 'Phone profile'], ['desktop', 'Desktop profile']]

const n = (value) => value.toLocaleString('en-US')
const ms = (value) => value.toFixed(1)
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const row = (cells) => `| ${cells.join(' | ')} |`
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

// one cell per library: outputs side by side for a library that returns several
function cell(lib, each) {
  if (lib.outputs.length === 1) return each(lib.outputs[0])
  return lib.outputs.map((output) => `${output}: ${each(output)}`).join('; ')
}

const valueOf = (visit, output) => (visit && visit.values ? visit.values[output] : null)

function reloadText(visits, output) {
  const k = classify(visits.map((v) => valueOf(v, output)))
  if (k.verdict === 'no id') return `no id in ${plural(k.runs, 'visit')}`
  if (k.verdict === 'incomplete') return `incomplete (1 id; ${k.answered} of ${k.runs} visits answered)`
  if (k.verdict === 'split') {
    const ids = visits.map((v) => valueOf(v, output))
    const base = baseId(ids)
    return `split (${plural(k.distinct, 'id')} in ${plural(k.runs, 'visit')}, ${ids.filter((id) => id === base).length} with the most frequent)`
  }
  return `${k.verdict} (${plural(k.distinct, 'id')} in ${plural(k.runs, 'visit')})`
}

// what the package says about a request, beside the request
function noteText(lib, url) {
  const note = (lib.requests || []).find((r) => url.startsWith(r.match))
  if (!note) return '(not described in the package)'
  return `(documented rate: ${note.rate}; turned off by ${note.off}; carries ${note.carries}; ${note.where})`
}

function requestsText(lib, record) {
  const visits = plural(record.visits, 'visit')
  if (!record.requests.length) return `none in ${visits}`
  const counts = new Map()
  for (const r of record.requests) {
    const url = new URL(r.url)
    const key = `${r.method} ${url.origin}${url.pathname}`
    counts.set(key, { count: ((counts.get(key) || {}).count || 0) + 1, url: url.origin + url.pathname })
  }
  const shown = [...counts].map(([key, { count, url }]) => `${key}${count > 1 ? ` (${count} times)` : ''} ${noteText(lib, url)}`).join(', ')
  return `${plural(record.requests.length, 'request')}: ${shown} (${visits})`
}

function timingText(spreadOf) {
  if (!spreadOf.n) return 'no id in any run'
  return `${ms(spreadOf.median)} ms (quartiles ${ms(spreadOf.p25)} to ${ms(spreadOf.p75)}, range ${ms(spreadOf.min)} to ${ms(spreadOf.max)}, ${plural(spreadOf.n, 'run')})`
}

function timingCell(lib, runs) {
  const shown = []
  const parts = []
  for (const output of lib.outputs) {
    const values = runs.map((r) => r[output])
    const twin = shown.find((other) => JSON.stringify(runs.map((r) => r[other])) === JSON.stringify(values))
    if (twin) {
      parts.push(`${output}: with ${twin}`)
      continue
    }
    shown.push(output)
    const text = timingText(spread(values))
    parts.push(lib.outputs.length === 1 ? text : `${output}: ${text}`)
  }
  return parts.join('; ')
}

// the properties of a fault that the visit's page reached, or null where the run did not count them
function reachedOf(visit) {
  if (!visit || !visit.hits) return null
  return Object.keys(visit.hits).filter((name) => visit.hits[name] > 0)
}

function reachText(fault, visit) {
  const reached = reachedOf(visit)
  if (!fault || fault.origin === 'baseline' || reached === null) return ''
  if (!reached.length) return ' (fault not reached)'
  return fault.apis.length > 1 ? ` (fault reached: ${reached.join(', ')})` : ' (fault reached)'
}

function faultText(lib, visit, fault) {
  const { outcome, escaped } = faultOutcome(visit)
  let text = outcome
  if (outcome === 'id' && lib.outputs.length > 1) {
    const got = lib.outputs.filter((o) => { const v = valueOf(visit, o); return v !== null && v !== undefined && v !== '' })
    if (got.length < lib.outputs.length) text = `id (${got.join(', ')} only)`
  }
  return (escaped ? `${text}, error reached the page` : text) + reachText(fault, visit)
}

const faultNamed = (report, name) => (report.settings.faults || []).find((f) => f.name === name)
const isBaseline = (report, visit) => { const def = faultNamed(report, visit.fault); return !!def && def.origin === 'baseline' }

// how many of a run's faults (the baselines aside) the library's code reached; null where the run did not count them
function reachedCount(report, key) {
  const faults = report.results[key].faults.filter((f) => !isBaseline(report, f))
  if (faults.some((f) => reachedOf(f) === null)) return null
  return { reached: faults.filter((f) => reachedOf(f).length > 0).length, of: faults.length }
}

// one condition visit against its base: the visit before it in its own context, or, where it needed a new context,
// the recomputed reloads, with the second-context control deciding whether a change can be put down to the condition
function conditionCell(p, key, output) {
  const baseR = baseId(p.recomputed.map((v) => valueOf(v, output)))
  if (key === 'cleared') return sameAs(baseId(p.reloads.map((v) => valueOf(v, output))), valueOf(p.cleared, output))
  if (key === 'second') return sameAs(baseR, valueOf(p.second, output))
  const c = p.conditions[key]
  if (c.in === 'same') return sameAs(valueOf(c.base, output), valueOf(c.visit, output))
  const verdict = sameAs(baseR, valueOf(c.visit, output))
  if (verdict !== 'changed') return verdict
  const control = sameAs(baseR, valueOf(p.second, output))
  if (control === 'changed') return NEW_CONTEXT_ALSO
  return control === 'no id' ? 'changed (the second context gave no id to compare with)' : verdict
}

const conditionRan = (p, key) => (key === 'cleared' || key === 'second' ? !!p[key] : !!(p.conditions && p.conditions[key]))

const harnessOf = (report) => JSON.stringify(report.harness || null)

// the libraries must be the same builds in every file, and the harness the same commit, or the columns would mix versions
function sameLibraries(reports) {
  const first = reports[0].libraries
  for (const report of reports.slice(1)) {
    for (const lib of first) {
      const other = report.libraries.find((l) => l.key === lib.key)
      if (!other || other.version !== lib.version || other.integrity !== lib.integrity || other.commit !== lib.commit || other.sha256 !== lib.sha256) {
        throw new Error(`${report.engine}: ${lib.name} is not the same version and build as in ${reports[0].engine}`)
      }
    }
    if (report.libraries.length !== first.length) throw new Error(`${report.engine}: a different set of libraries and versions`)
    if (harnessOf(report) !== harnessOf(reports[0])) throw new Error(`${report.engine}: made by the harness at ${harnessOf(report)}, not ${harnessOf(reports[0])} as ${reports[0].engine}`)
  }
  return first
}

/** The rows of one run, as { label, cells } with one cell per library. */
function runRows(report, libs) {
  const rows = []
  const add = (label, each) => rows.push({ label, cells: libs.map((l) => each(l, report.results[l.key])) })
  add('Network requests made by the library, default options', (l, r) => requestsText(l, r.network.default))
  add('Network requests, Math.random() returning 0 (any sampled request is due)', (l, r) => requestsText(l, r.network.forced))
  add('Network requests during the fault visits', (l, r) => requestsText(l, r.network.faults))
  const reloads = report.settings.reloads
  for (const [profile, label] of PROFILES) {
    add(`${label}: ${reloads} reloads, cached values removed before each (recomputed)`, (l, r) => cell(l, (o) => reloadText(r.profiles[profile].recomputed, o)))
    add(`${label}: ${reloads} reloads as shipped, one context`, (l, r) => cell(l, (o) => reloadText(r.profiles[profile].reloads, o)))
    for (const [key, text] of CONDITIONS) {
      const first = report.results[libs[0].key].profiles[profile]
      const ran = key !== 'cleared' && key !== 'second' && first.conditions && first.conditions[key]
      add(`${label}: ${text}${ran ? `, ${APPLIED[ran.in]}` : ''}`, (l, r) => {
        const p = r.profiles[profile]
        if (!conditionRan(p, key)) return 'not run'
        return cell(l, (o) => conditionCell(p, key, o))
      })
    }
  }
  const count = (r, test) => `${r.faults.filter(test).length} of ${r.faults.length}`
  add('Faults where an error reached the page (error event or unhandled rejection)', (l, r) => count(r, (f) => faultOutcome(f).escaped))
  add('Faults where the call threw or rejected', (l, r) => count(r, (f) => faultOutcome(f).outcome === 'threw or rejected'))
  add(`Faults with no answer within ${report.settings.faultWaitMs / 1000} s`, (l, r) => count(r, (f) => faultOutcome(f).outcome === 'no answer'))
  add('Faults answered with an id', (l, r) => cell(l, (o) => count(r, (f) => { const v = valueOf(f, o); return v !== null && v !== undefined && v !== '' })))
  add('Faults whose broken property the library reached (calls counted, baselines aside)', (l) => {
    const k = reachedCount(report, l.key)
    return k ? `${k.reached} of ${k.of}` : 'not counted'
  })
  add('Time from the end of the script download to first id, desktop lab timing', (l, r) => timingCell(l, r.timing))
  add('Time in the documented call pattern, where it differs from the row above', (l, r) => (l.documented && r.documentedTiming ? `${l.documented.label}: ${timingCell(l, r.documentedTiming)}` : 'as the row above'))
  return rows
}

function faultRows(report, libs) {
  const faults = (l) => report.results[l.key].faults
  return faults(libs[0]).map((f) => ({
    label: f.fault,
    cells: libs.map((l) => {
      const visit = faults(l).find((x) => x.fault === f.fault)
      return visit ? faultText(l, visit, faultNamed(report, f.fault)) : 'not run'
    }),
  }))
}

// one table from several runs: a cell that is the same in every run is shown once, otherwise each run's value
function merged(rowsByRun) {
  return rowsByRun[0].map((first, i) => ({
    label: first.label,
    cells: first.cells.map((value, k) => {
      const values = rowsByRun.map((rows) => rows[i].cells[k])
      return values.every((v) => v === value) ? value : values.map((v, run) => `run ${run + 1}: ${v}`).join('; ')
    }),
  }))
}

// libraries in order of the median of their first output, lowest first
function timingOrder(report, libs) {
  const median = (l) => spread(report.results[l.key].timing.map((r) => r[l.outputs[0]])).median
  return libs.filter((l) => median(l) !== null).sort((a, b) => median(a) - median(b)).map((l) => l.name)
}

function orderText(runs, libs) {
  const orders = runs.map((r) => timingOrder(r, libs).join(', '))
  if (runs.length === 1) return `Order of the median time to first id, lowest first, from one run and so not checked across runs: ${orders[0]}.`
  if (orders.every((o) => o === orders[0])) return `Order of the median time to first id, lowest first, the same in all ${runs.length} runs: ${orders[0]}.`
  return `Order of the median time to first id, lowest first: ${orders.map((o, i) => `run ${i + 1}: ${o}`).join('; ')}. The order differs between runs.`
}

function engineSection(runs, libs) {
  const first = runs[0]
  const builds = [...new Set(runs.map((r) => r.browserVersion))].join(', ')
  const lines = [`## ${first.engine}${first.launch && first.launch.label ? first.launch.label : ''} ${builds}`, '']
  if (runs.length > 1) lines.push(`${runs.length} runs, ${runs.map((r) => r.date.slice(0, 16).replace('T', ' ') + ' UTC').join(', ')}.`, '')
  lines.push(row(['Check', ...libs.map((l) => `${l.name} ${l.version}`)]), row(['---', ...libs.map(() => '---')]))
  for (const r of merged(runs.map((run) => runRows(run, libs)))) lines.push(row([r.label, ...r.cells]))
  lines.push('', orderText(runs, libs))
  lines.push('', `### Faults, ${first.engine}`, '', row(['Fault', ...libs.map((l) => l.name)]), row(['---', ...libs.map(() => '---')]))
  for (const r of merged(runs.map((run) => faultRows(run, libs)))) lines.push(row([r.label, ...r.cells]))
  return lines.join('\n')
}

function sizeSection(reports, libs) {
  const lines = ['## Libraries and bytes', '', 'Bytes of the browser bundle each package ships, measured from the file itself: gzip and brotli at Node\'s default levels.', '']
  lines.push(row(['Library', 'Version', 'File', 'Raw', 'Gzip', 'Brotli', 'Source', 'sha256 of the file served']), row(['---', '---', '---', '---:', '---:', '---:', '---', '---']))
  for (const lib of libs) {
    const source = lib.integrity ? `npm \`${lib.package}\`, integrity \`${lib.integrity}\`` : `local build, commit \`${lib.commit}\``
    lines.push(row([lib.name, lib.version, '`' + lib.file.replace(/^package\//, '') + '`', n(lib.bytes.raw), n(lib.bytes.gzip), n(lib.bytes.brotli), source, lib.sha256 ? '`' + lib.sha256 + '`' : 'not recorded']))
  }
  for (const lib of libs.filter((l) => l.minified)) {
    const m = lib.minified
    lines.push('', `${lib.name} ships \`${lib.file.replace(/^package\//, '')}\` unminified. Minified by this harness with ${m.tool} at its default options, the same file is ${n(m.raw)} bytes raw, ${n(m.gzip)} gzip and ${n(m.brotli)} brotli.`)
  }
  const h = reports[0].harness
  if (h) lines.push('', `Made by the harness at commit \`${h.commit}\`, with ${h.dirty ? '' : 'no '}uncommitted changes to ${list(h.files || ['lab/compare.mjs', 'lab/compare'])}.`)
  return lines.join('\n')
}

const engineKey = (report) => report.engine + (report.launch ? report.launch.suffix : '')

// a run's label within its engine, where an engine ran more than once
const runLabel = (report, reports) => {
  const same = reports.filter((r) => engineKey(r) === engineKey(report))
  return same.length > 1 ? `${report.engine} run ${same.indexOf(report) + 1}` : report.engine
}

// "engine: text" once where every run of the engine gives the same text, else one item per run; runs giving null are left out
function perEngine(reports, textOf) {
  const items = []
  for (const key of [...new Set(reports.map(engineKey))]) {
    const runs = reports.filter((r) => engineKey(r) === key)
    const texts = runs.map(textOf)
    if (texts.every((t) => t === null)) continue
    if (texts.every((t) => t === texts[0])) items.push(`${runs[0].engine}: ${texts[0]}`)
    else runs.forEach((r, i) => { if (texts[i] !== null) items.push(`${runLabel(r, reports)}: ${texts[i]}`) })
  }
  return items
}

function faultsParagraph(reports, libs) {
  const s = reports[0].settings
  const faults = s.faults || []
  const baselines = faults.filter((f) => f.origin === 'baseline')
  const fromMatrix = faults.filter((f) => f.origin === 'VisitoJS fault matrix')
  const added = faults.filter((f) => f.origin === 'added')
  const reduced = faults.filter((f) => f.profile === 'reduced')
  const reducedUa = reports[0].contexts && reports[0].contexts.phone && reports[0].contexts.phone.reduced ? reports[0].contexts.phone.reduced.options.userAgent : null
  const notRead = faults.filter((f) => f.visitoProduct === 'not read')
  const conditional = faults.filter((f) => f.visitoProduct && f.visitoProduct !== 'reads' && f.visitoProduct !== 'not read')
  const local = libs.find((l) => l.local)
  const parts = [
    `Faults: ${plural(baselines.length, 'baseline visit')} and ${plural(fromMatrix.length + added.length, 'fault visit')}, the same for every library, each installed before any page script runs, one visit each in the phone profile` +
      (reduced.length ? `, ${reduced.length} of them (${list(reduced.map((f) => f.name))}) with the phone's user agent in its reduced form${reducedUa ? `, \`${reducedUa}\`` : ''}: the form Chrome on Android sends when it hides the model, which VisitoJS parses as reduced and then, only then, asks the client hints for the model (src/ua.ts, src/stages.ts). In Chromium that context's client hints still give the phone's model, Android version and full browser version, as Chrome's do; Firefox and WebKit have no client hints` : '') +
      `. A call that had not answered within ${s.faultWaitMs / 1000} s counts as no answer.`,
    `Of the faults, ${fromMatrix.length} come from VisitoJS's own fault matrix (they break a property \`lab/fault-matrix.mjs\` also breaks, and VisitoJS was built to pass that matrix): ${list(fromMatrix.map((f) => f.name))}. ` +
      `${added.length} were added on reads that matrix does not cover and other libraries depend on: ${list(added.map((f) => f.name))}.`,
    'Each broken property counts the calls that reach it, in every frame the harness\'s init script runs in, and each cell of the fault table says whether the library\'s code reached the fault; a library that did not reach a fault met it without the broken property being called, so that cell says nothing about how its code handles the fault.',
  ]
  const counts = perEngine(reports, (r) => {
    const each = libs.map((l) => { const k = reachedCount(r, l.key); return k ? `${l.name} ${k.reached} of ${k.of}` : null })
    return each.every(Boolean) ? each.join(', ') : null
  })
  if (counts.length) parts.push(`Faults reached by each library's code, the baselines aside: ${counts.join('; ')}.`)
  if (local) {
    parts.push(`From the reads its product build makes (lab/compare/faults.mjs, checked against the names in the built bundle), ${local.name} is not expected to reach ${list(notRead.map((f) => f.name))}` +
      (conditional.length ? `, and reaches these only under a condition: ${conditional.map((f) => `${f.name} (${f.visitoProduct})`).join('; ')}` : '') + '.')
    // where the counted calls say otherwise
    const off = []
    for (const r of reports) {
      for (const visit of r.results[local.key].faults) {
        const def = faultNamed(r, visit.fault)
        const reached = reachedOf(visit)
        // a property the engine lacks cannot be reached, so it says nothing about the expectation
        if (!def || reached === null || (def.visitoProduct !== 'reads' && def.visitoProduct !== 'not read') || (r.absent && r.absent[def.name])) continue
        if ((def.visitoProduct === 'reads') !== reached.length > 0) off.push(`${local.name} ${reached.length ? 'reached' : 'did not reach'} ${def.name} in ${runLabel(r, reports)}`)
      }
    }
    if (off.length) parts.push(`Not as expected: ${off.join('; ')} (the expectation is in lab/compare/faults.mjs).`)
  }
  const absent = reports.flatMap((r) => Object.entries(r.absent || {}).map(([name, props]) => `${name} changes nothing in ${r.engine}, which has none of ${props.join(', ')}`))
  if (absent.length) parts.push(`A fault on a property the engine lacks changes nothing there: ${[...new Set(absent)].join('; ')}.`)
  return parts.join(' ')
}

function conditionsParagraph(reports, libs) {
  const placed = { same: new Map(), new: new Map() }
  for (const r of reports) {
    const phone = r.results[libs[0].key].profiles.phone
    for (const [key, text] of CONDITIONS) {
      const c = phone.conditions && phone.conditions[key]
      if (!c) continue
      const names = placed[c.in].get(r.engine) || new Set()
      names.add(text)
      placed[c.in].set(r.engine, names)
    }
  }
  const where = (map, how) => [...map].map(([engine, names]) => `${how} in ${engine}: ${[...names].join('; ')}.`).join(' ')
  return 'The conditions. Cookies and storage cleared: after the shipped run\'s reloads, its cookies and storage are cleared and one more visit is made in that context, compared with the id most of that context\'s reloads returned. ' +
    'Second context: one visit in a new context with the base options, which has storage of its own and stands in for a private window without being one, compared with the id most of the recomputed reloads returned; it is the control for every condition that needs a new context. ' +
    'Each other condition (the browser and app versions in the user agent, and in Chromium the client hints, raised by one; viewport and screen swapped, phone profile only; a smaller viewport with the same screen) is applied in the same context wherever the engine allows it: a base visit in a context of its own, then the library\'s stored computed values are removed as before a recomputed reload, the condition is applied and a second visit is made, which is compared with that base visit. ' +
    'Chromium changes the user agent with its client hints, and the viewport with the screen kept, inside one tab (CDP Emulation.setUserAgentOverride and Emulation.setDeviceMetricsOverride); rotation uses Playwright\'s page.setViewportSize, which sets the screen to the new viewport in all three engines and so swaps both where they were equal. Firefox and WebKit have no way to change the user agent, or the viewport alone, inside a context, so those conditions get a new context with the condition\'s options, and that visit is compared with the recomputed reloads. ' +
    `Where the second context alone gave another id, such a cell reads "${NEW_CONTEXT_ALSO}", since the cell then cannot show that the condition made the change. ` +
    (placed.same.size ? where(placed.same, 'Applied in the same context') + ' ' : '') +
    (placed.new.size ? where(placed.new, 'In a new context') + ' ' : '') +
    'The harness reads back the user agent and the screen size of every profile visit and stops when they are not the ones planned. ' +
    'In the same context the stored data stays, so an id a library keeps in storage stays too unless the library replaces it; in a new context it is new by construction. ' +
    'VisitoJS returns three ids (id, idStrict and the stored id did), reported separately; each of the others returns one fingerprint. ' +
    'Components are kept in the run file for each visit whose id differs from the base id, and once for the base, so a change can be traced.'
}

const ratio = (value) => String(Math.round(value * 1e4) / 1e4)

// the devicePixelRatio each engine's page saw, from the first library's visits, where it was recorded
function pixelRatios(reports, libs) {
  return perEngine(reports, (r) => {
    const profiles = r.results[libs[0].key].profiles
    const items = []
    for (const [profile] of PROFILES) {
      const p = profiles[profile]
      const at = [['base', p.recomputed[0]], ['smaller viewport', p.conditions && p.conditions.viewport && p.conditions.viewport.visit], ['rotation', p.conditions && p.conditions.rotation && p.conditions.rotation.visit]]
        .filter(([, v]) => v && typeof v.dpr === 'number')
        .map(([name, v]) => `${name} ${ratio(v.dpr)}`)
      if (at.length) items.push(`${profile} ${at.join(', ')}`)
    }
    return items.length ? items.join('; ') : null
  })
}

// the engines whose phone base context has a screen other than the phone's viewport: the machine's own, where the engine
// has no mobile emulation and the harness sets the screen its probe reports
function ownScreens(reports, s) {
  if (!s.phone) return []
  const v = s.phone.viewport
  return [...new Set(reports.filter((r) => {
    const base = r.contexts && r.contexts.phone && r.contexts.phone.base
    const screen = base && base.options.screen
    return screen && (screen.width !== v.width || screen.height !== v.height)
  }).map((r) => r.engine))]
}

function cacheParagraph(libs, reloads) {
  const caching = libs.filter((l) => l.cacheKeys && l.cacheKeys.length)
  const others = libs.filter((l) => !l.cacheKeys || !l.cacheKeys.length)
  return `Two runs of ${reloads} reloads per profile, each in a context of its own. In the first, each library's stored computed values are removed before every reload, so that every visit is recomputed: ` +
    caching.map((l) => `for ${l.name} the localStorage ${l.cacheKeys.length === 1 ? 'entry' : 'entries'} ${l.cacheKeys.map((k) => '`' + k + '`').join(', ')}${l.cacheNote ? ` (${l.cacheNote})` : ''}`).join('; ') +
    (others.length ? `; ${list(others.map((l) => l.name))} ${others.length === 1 ? 'keeps' : 'keep'} no computed values in storage with default options, so for them nothing is removed and the two runs follow the same procedure` : '') +
    '. The second run is each library as shipped, nothing removed' +
    (caching.length ? `: from reload 2 on, ${list(caching.map((l) => l.name))} serves its cached values instead of reading them again.` : '.')
}

function methodSection(reports, libs) {
  const s = reports[0].settings
  const builds = [...new Set(reports.map((r) => `${r.engine} ${r.browserVersion}`))].join(', ')
  const dates = [...new Set(reports.map((r) => r.date.slice(0, 10)))].join(', ')
  const visits = [...new Set(reports.map((r) => `${r.engine}: ${libs.map((l) => `${l.name} ${r.results[l.key].network.default.visits}`).join(', ')}`))].join('; ')
  const phone = s.phone
    ? ` (user agent \`${s.phone.userAgent}\`, viewport ${s.phone.viewport.width}x${s.phone.viewport.height}, device scale ${s.phone.deviceScaleFactor}, touch, locale ${s.phone.locale}, time zone ${s.phone.timezoneId}; Firefox has no mobile emulation in Playwright, so there it has the user agent, viewport, touch, locale and time zone only)`
    : ''
  const windows = reports.every((r) => /^win32/.test(r.os))
  const headless = reports.every((r) => r.headless !== false)
  const ratios = pixelRatios(reports, libs)
  const scale = s.phone ? s.phone.deviceScaleFactor : null
  const offScale = [...new Set(reports.filter((r) => { const v = r.results[libs[0].key].profiles.phone.recomputed[0]; return scale && v && typeof v.dpr === 'number' && Math.abs(v.dpr - scale) > 0.001 }).map((r) => r.engine))]
  const machineScreen = ownScreens(reports, s)
  const notes = libs.flatMap((l) => l.notes || [])
  const requestNotes = libs.flatMap((l) => (l.requests || []).map((r) => `${l.name}: ${r.request}, documented rate ${r.rate}, turned off by ${r.off}, carries ${r.carries} (${r.where}).`))
  const noRequests = libs.filter((l) => l.noRequests).map((l) => `${l.name}: ${l.noRequests}.`)
  const documented = libs.filter((l) => l.documented)
  const runsPerEngine = reports.length / new Set(reports.map((r) => r.engine + (r.launch ? r.launch.suffix : ''))).size
  return [
    '## Method',
    '',
    `Run on ${dates} with \`lab/compare.mjs\` in ${builds}, on ${reports[0].os}, driven by Playwright ${reports[0].playwright} under Node ${reports[0].node}. ` +
      `Each library ran the build its npm package ships, at the version and integrity above, fetched with npm pack and checked against the pinned integrity before use; VisitoJS ran its own product build, which the harness refuses to serve when it is older than its sources. ` +
      'Every library was called with its default options. A local server served a blank page and the library; every HTTP request to any other address was aborted before it left the browser and recorded with its method and URL, and every WebSocket was recorded and closed without connecting. ' +
      `The browsers are Playwright's own builds of Chromium, Firefox and WebKit${headless ? ', run headless' : ''}; WebKit is not Safari${windows ? ', and on Windows it is Playwright\'s WebKit build for Windows, which no Apple product ships' : ''}.`,
    '',
    'Facts about the libraries that bear on these rows: ' + notes.join(' ') + ' This table compares only the open-source builds; no server-side product of any library took part.',
    '',
    `Each library ran in two profiles: a phone profile${phone}, and a desktop profile with the browser's own user agent and the machine's own locale and time zone. ` +
      (machineScreen.length ? `In ${list(machineScreen)} the phone profile has the screen the machine reports, not one of the phone's viewport size, so there a rotation swaps that screen and needs a context of its own. ` : '') +
      'Every context, the base ones included, sets its user agent through the same override, the desktop base with the browser\'s own string, so that a condition differs from its base only in the field under test. ' +
      'In Chromium, which exposes client hints (navigator.userAgentData and the Sec-CH-UA headers), every context also emulates the client hints that match its user agent, from the browser\'s own values: the brand versions follow the user agent\'s Chrome version, and the phone profile has the platform, platform version, model and mobile flag its user agent states. Brand names stay the test browser\'s own. The harness reads back, in every profile visit, every field the emulated metadata sets (brands, mobile and platform, and the high-entropy architecture, bitness, form factors, full version list, model, platform version, full version and wow64) and stops if any differs from the one emulated. Firefox and WebKit expose no client hints.' +
      (ratios.length ? ` devicePixelRatio the page saw: ${ratios.join('; ')}.` : '') +
      (offScale.length ? ` In ${list(offScale)} the phone base visit saw another value than the device scale of ${scale} the phone context sets, so a library that reads devicePixelRatio met a value no phone of that scale reports.` : ''),
    '',
    cacheParagraph(libs, s.reloads) + ' ' + conditionsParagraph(reports, libs),
    '',
    faultsParagraph(reports, libs),
    '',
    `Network: the first row counts every visit made with default options (${visits}); the second is one visit per library in which Math.random() always returns 0, so that a request a library sends only on a random sample of calls is due on that visit; the third counts the fault visits. ` +
      ['Beside each recorded request is what the package says about it.', ...requestNotes, ...noRequests].join(' '),
    '',
    `Timing is a desktop lab timing on one PC, without CPU throttling: ${s.timingRuns} runs per library, each in a new context on the same blank page, in desktop profile, the order of the libraries rotated from run to run. ` +
      'A run measures from the end of the library script\'s download (Resource Timing responseEnd) to the moment the id is first available, and the table gives the median, the quartiles and the range.' +
      documented.map((l) => ` ${l.documented.method}`).join('') +
      (runsPerEngine > 1 ? ` Each engine ran ${runsPerEngine} times; a cell that differed between runs shows each run, and an order of medians is said to hold only when it is the same in every run.` : ' Each engine ran once, so no order of medians here is checked across runs.') +
      (reports.every((r) => typeof r.clockStepMs === 'number') ? ` Smallest step of performance.now() seen in the page: ${[...new Set(reports.map((r) => `${r.engine} ${r.clockStepMs} ms`))].join(', ')}.` : ''),
    '',
    'What this run cannot show: no real phone took part, so the phone profile is a desktop engine with a phone\'s user agent, viewport and touch, and every hardware value is this PC\'s; ' +
      'the engines are Playwright\'s builds, so no cell here says what Safari, Chrome or Firefox as their users install them would give; ' +
      'in Chromium the phone\'s client hints are emulated with the test browser\'s brand names, not those of an Android WebView; ' +
      'there are no runs of several browsers on one device, so whether an id stays the same across the browsers of one device is not measured here; the second context is not a private window; ' +
      'timings are desktop lab timings, not phone timings, on a machine that may have had other work running; and with one machine nothing here measures how well an id tells devices apart. A request sent on a random sample of calls may not occur in the default-options visits at all, which is why the second network row exists.',
  ].join('\n')
}

/** The Markdown for one or more run files. Throws when the files compare different library builds or harness commits. */
export function render(reports) {
  const libs = sameLibraries(reports)
  const groups = new Map()
  for (const report of reports) {
    const key = report.engine + (report.launch ? report.launch.suffix : '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(report)
  }
  return [
    '# Fingerprint library comparison',
    '',
    `Generated by \`lab/compare/table.mjs\` from ${plural(reports.length, 'run file')}.`,
    '',
    sizeSection(reports, libs),
    '',
    ...[...groups.values()].map((runs) => engineSection(runs, libs) + '\n'),
    methodSection(reports, libs),
    '',
  ].join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error('usage: node lab/compare/table.mjs lab/report/raw/compare-<engine>.json [...]')
    process.exit(2)
  }
  process.stdout.write(render(files.map((file) => JSON.parse(readFileSync(file, 'utf8')))))
}
