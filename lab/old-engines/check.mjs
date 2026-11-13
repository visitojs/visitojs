// Reads the output of run.sh and applies the pass rule to every image: it ran the Chrome its tag stands for and named its
// version, the page reported no error, the callback fired with a well-formed reading from the build that was meant to
// run, and the reading's id and idStrict equal the ones recomputed here from its own c values by the recipe in
// docs/SIGNALS.md. That proves the library's SHA-256 and canonical text in each old engine. It also proves each one is
// classified as the desktop Blink it is: engine blink, not Android, no memory, screen or core part excluded, and in the
// lab build all five Blink feature tests holding and no other engine's tests reaching the three that would vote.
// The deferred build (--build defer) reads as the product build does, and the page must have found its start() and called it.
// Usage: node check.mjs <output file> --build product|lab|defer [--all-tags]
//   --all-tags  run.sh ran its default list: every tag in TAGS below must have a block
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { problems } from '../schema.mjs'
import { TAGS } from './tags.mjs'

// a value only the lab build reads (syncReads in src/reads.ts): it tells which bundle the page loaded
const LAB_ONLY = 'x.tzo'
// the parts src/stages.ts and seal() set to '!ex' for a browser that randomises them; Chrome randomises none of them
const EXCLUDABLE = ['hw.mem', 'hw.scr', 'hw.cores']
const EXCLUDED = '!ex'
// the per-test results the lab build records (featureMarks in src/env.ts), printed in this order
const EVIDENCE = ['blink', 'webkit', 'gecko', 'android', 'safari17', 'firefox143', 'brave']
// three of an engine's five tests choose it (detectBuild in src/env.ts)
const VOTE = 3

const positions = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : `${list[0]}`)
const fiveResults = (value) => typeof value === 'string' && /^[01]{5}$/.test(value)

// what an old desktop Chrome must be classified as; `lab` adds the per-test results only the lab build carries
function classification(c, lab) {
  const failures = []
  if (c['x.engine'] !== 'blink') failures.push(`x.engine is ${c['x.engine']}, not blink`)
  if (c['x.android'] !== false) failures.push(`x.android is ${c['x.android']}: a desktop Chrome read as Android`)
  for (const key of EXCLUDABLE) if (c[key] === EXCLUDED) failures.push(`${key} is excluded (${EXCLUDED}): no exclusion applies in Chrome`)
  if (!lab) return failures
  for (const key of ['x.ev.blink', 'x.ev.webkit', 'x.ev.gecko']) if (!fiveResults(c[key])) failures.push(`${key} is ${JSON.stringify(c[key])}, not five test results`)
  const blink = c['x.ev.blink']
  if (fiveResults(blink) && blink !== '11111') {
    const missing = blink.split('').map((mark, i) => (mark === '1' ? 0 : i + 1)).filter(Boolean)
    failures.push(`x.ev.blink is ${blink}, not 11111: Blink ${missing.length > 1 ? 'tests' : 'test'} ${positions(missing)} of 5 missing`)
  }
  for (const name of ['webkit', 'gecko']) {
    const marks = c[`x.ev.${name}`]
    const held = fiveResults(marks) ? marks.split('1').length - 1 : 0
    if (held >= VOTE) failures.push(`x.ev.${name} is ${marks}: ${held} of 5 ${name} tests hold, enough to vote`)
  }
  return failures
}

// the classification on each engine's line; the lab build adds every test's result, so the log is the per-test table
function described(c, lab) {
  const base = `engine=${c['x.engine']} android=${c['x.android']}`
  return lab ? `${base} tests: ${EVIDENCE.map((name) => `${name}=${c[`x.ev.${name}`]}`).join(' ')}` : base
}

// docs/SIGNALS.md, "How an id is computed": hw. and p. parts as sorted key=value lines, a line break in a value written as
// a space
const line = (parts, key) => `${key}=${String(parts[key]).replace(/[\r\n]/g, ' ')}`
const text = (parts) => Object.keys(parts).sort().map((key) => line(parts, key)).join('\n')
const hash = (version, parts) => createHash('sha256').update(`visito:${version}\n${text(parts)}`, 'utf8').digest('hex')

function idParts(c) {
  const parts = {}
  for (const key of Object.keys(c)) if (key.startsWith('hw.') || key.startsWith('p.')) parts[key] = c[key]
  return parts
}

function recompute(reading) {
  const parts = idParts(reading.c)
  const id = hash(reading.v, parts)
  parts['v.os'] = reading.osVer || '!na'
  parts['v.app'] = reading.app
  parts['v.appVer'] = reading.appVer || '!na'
  parts['v.engine'] = reading.engineVer || '!na'
  return { id, idStrict: hash(reading.v, parts) }
}

const args = process.argv.slice(3)
const buildAt = args.indexOf('--build')
const build = buildAt >= 0 ? args[buildAt + 1] : undefined
if (build !== 'product' && build !== 'lab' && build !== 'defer') {
  console.log('usage: check.mjs <output file> --build product|lab|defer [--all-tags]')
  process.exit(1)
}
const allTags = args.includes('--all-tags')

const blocks = readFileSync(process.argv[2], 'utf8').split(/^IMAGE /m).filter((block) => block.trim())
const seen = []
let failed = 0
for (const block of blocks) {
  const image = block.split('\n')[0].trim()
  const tag = (/:(\d+(?:\.\d+)*)/.exec(image) || [])[1] || image
  const fullTag = (/:([^@\s]+)/.exec(image) || [])[1] || image
  const version = ((/^VERSION (.*)$/m.exec(block) || [])[1] || '').trim()
  const encoded = (/VISITO_RESULT (\S+) END/.exec(block) || [])[1]
  const shown = (/(\d+\.\d+\.\d+\.\d+)/.exec(version) || [])[1]
  const major = shown && Number(shown.split('.')[0])
  const failures = []
  let summary = 'no result'
  let classes = ''
  let reading
  if (!version) failures.push('no browser version: the image did not run google-chrome --version')
  if (!(tag in TAGS)) failures.push(`image tag ${tag} has no expected Chrome version in check.mjs`)
  else if (major !== TAGS[tag]) failures.push(`image tag ${tag} should hold Chrome ${TAGS[tag]}, not ${major || 'an unknown version'}`)
  if (/^RUN_FAILED$/m.test(block)) failures.push('RUN_FAILED: docker run exited with an error')
  if (!encoded) failures.push((/^NO_RESULT.*$/m.exec(block) || ['the page never reported'])[0].slice(0, 200))
  else {
    const out = JSON.parse(decodeURIComponent(encoded))
    reading = out.got
    for (const error of out.errors) failures.push(`page error: ${error}`)
    if (out.threw) failures.push(out.threw)
    if (!out.called) failures.push('get() never called back')
    if (out.defined !== 'object') failures.push(`Visito is ${out.defined}`)
    // which bundle ran: only the deferred build has start(), and the page calls it before anything else
    if (build === 'defer' && out.started !== true) failures.push('deferred build expected but the page found no start()')
    if (build !== 'defer' && out.started === true) failures.push(`${build} build expected but the page found start()`)
    const agent = (/Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(out.ua || '') || [])[1]
    // fail closed: two missing versions are not a match
    if (!shown || !agent) failures.push(`cannot cross-check the version: the image says "${version}", the user agent "${out.ua}"`)
    else if (shown !== agent) failures.push(`the image says ${version} but the user agent says Chrome/${agent}`)
    if (out.called && !reading) failures.push('no reading: the library exited silently')
    if (reading) {
      failures.push(...problems(reading).map((p) => `schema: ${p}`))
      if (JSON.stringify(reading) !== JSON.stringify(out.sync)) failures.push('get() and getSync() disagree')
      const lab = reading.c && LAB_ONLY in reading.c
      if (build === 'lab' && !lab) failures.push(`lab build expected but the reading has no ${LAB_ONLY}: the product bundle ran`)
      if (build !== 'lab' && lab) failures.push(`${build === 'defer' ? 'deferred' : 'product'} build expected but the reading has ${LAB_ONLY}: the lab bundle ran`)
      if (reading.c) {
        failures.push(...classification(reading.c, build === 'lab'))
        classes = ` ${described(reading.c, build === 'lab')}`
      }
      if (!reading.id) {
        failures.push(`no id to compare (partial=[${reading.flags && reading.flags.partial}])`)
        summary = 'id=none'
      } else {
        const expected = recompute(reading)
        const same = reading.id === expected.id
        const sameStrict = reading.idStrict === expected.idStrict
        if (!same) failures.push(`id differs from SHA-256 of c: browser ${reading.id}, node ${expected.id}`)
        if (!sameStrict) failures.push(`idStrict differs from SHA-256 of c: browser ${reading.idStrict}, node ${expected.idStrict}`)
        summary = `id=${same ? 'same' : 'DIFFERS'} idStrict=${sameStrict ? 'same' : 'DIFFERS'} id ${reading.id.slice(0, 12)} c=${Object.keys(reading.c).length} partial=[${reading.flags.partial}]`
      }
    }
  }
  if (failures.length) failed++
  console.log(`${failures.length ? 'FAIL' : 'ok  '} ${(version || 'unknown version').padEnd(34)} ${summary}${classes}${failures.length ? '  <- ' + failures.join(' | ') : ''}   (${image})`)
  if (reading && reading.c) {
    // what the id is built from, so that an id that moves between engines can be explained from the log
    const parts = idParts(reading.c)
    console.log(`     id parts: ${Object.keys(parts).sort().map((key) => line(parts, key)).join(' ')}`)
  }
  seen.push({ tag, fullTag, major, reading })
}

// name the id parts that changed wherever the id changes from one engine to the next
for (let i = 1; i < seen.length; i++) {
  const [before, after] = [seen[i - 1], seen[i]]
  if (!before.reading || !after.reading || !before.reading.id || !after.reading.id || before.reading.id === after.reading.id) continue
  const [a, b] = [idParts(before.reading.c), idParts(after.reading.c)]
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((key) => String(a[key]) !== String(b[key]))
  const changes = keys.map((key) => `${key} ${key in a ? a[key] : '(absent)'} -> ${key in b ? b[key] : '(absent)'}`)
  console.log(`id changes from Chrome ${before.major} (${before.fullTag}) to Chrome ${after.major} (${after.fullTag}): ${changes.join(', ') || 'no id part differs'}`)
}

if (allTags) {
  for (const tag of Object.keys(TAGS)) {
    if (seen.some((block) => block.tag === tag)) continue
    console.log(`FAIL no block for ${tag} (Chrome ${TAGS[tag]}): run.sh did not run every image`)
    failed++
  }
}
process.exit(failed || !blocks.length ? 1 : 0)
