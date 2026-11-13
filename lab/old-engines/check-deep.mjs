// Reads the output of run.sh with BUNDLE=dist/deep.min.js and applies the pass rule to every image: it ran the Chrome its tag
// stands for, the page reported no error, get() called back once and after it returned, the reading is well formed with every
// part read and every check "ok" (so the factory-method audio path and every canvas call work there), the rule did not exclude
// a desktop Chrome, and the deep id equals the one Node recomputes from c by the recipe in docs/SIGNALS.md. It prints each
// version's deep id and, where the id changes between versions, the parts that moved: the only browser-update evidence here.
// Usage: node check-deep.mjs <output file> --build deep [--all-tags]
import { readFileSync } from 'node:fs'
import { deepProblems, DEEP_PARTS } from '../deep-schema.mjs'
import { TAGS } from './tags.mjs'

const args = process.argv.slice(3)
if (args[args.indexOf('--build') + 1] !== 'deep' || args.indexOf('--build') < 0) {
  console.log('usage: check-deep.mjs <output file> --build deep [--all-tags]')
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
  let reading
  if (!version) failures.push('no browser version')
  if (!(tag in TAGS)) failures.push(`image tag ${tag} has no expected Chrome version`)
  else if (major !== TAGS[tag]) failures.push(`image tag ${tag} should hold Chrome ${TAGS[tag]}, not ${major || 'an unknown version'}`)
  if (/^RUN_FAILED$/m.test(block)) failures.push('RUN_FAILED: docker run exited with an error')
  if (!encoded) failures.push((/^NO_RESULT.*$/m.exec(block) || ['the page never reported'])[0].slice(0, 200))
  else {
    const out = JSON.parse(decodeURIComponent(encoded))
    reading = out.got
    for (const error of out.errors) failures.push(`page error: ${error}`)
    if (out.threw) failures.push(out.threw)
    if (out.defined !== 'object') failures.push(`VisitoDeep is ${out.defined}`)
    if (!out.called) failures.push('get() never called back')
    else if (out.calls !== 1) failures.push(`get() called back ${out.calls} times`)
    if (out.early) failures.push('the callback ran before get() returned')
    const agent = (/Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(out.ua || '') || [])[1]
    if (!shown || !agent) failures.push(`cannot cross-check the version: the image says "${version}", the user agent "${out.ua}"`)
    else if (shown !== agent) failures.push(`the image says ${version} but the user agent says Chrome/${agent}`)
    if (out.called && !reading) failures.push('no reading')
    if (reading) {
      failures.push(...deepProblems(reading).map((p) => `schema: ${p}`))
      const c = reading.c || {}
      if (c['x.rule'] !== '') failures.push(`x.rule is ${JSON.stringify(c['x.rule'])}: a desktop Chrome must be read`)
      for (const key of ['r.cchk', 'r.achk']) if (c[key] !== 'ok') failures.push(`${key} is ${c[key]}`)
      if (!reading.id) failures.push('no deep id to compare')
    }
  }
  if (failures.length) failed++
  const summary = reading && reading.id ? `deep id same ${reading.id.slice(0, 16)} ${DEEP_PARTS.map((k) => `${k}=${reading.c[k]}`).join(' ')} ms=${reading.ms}` : 'no deep id'
  console.log(`${failures.length ? 'FAIL' : 'ok  '} ${(version || 'unknown version').padEnd(34)} ${summary}${failures.length ? '  <- ' + failures.join(' | ') : ''}   (${image})`)
  seen.push({ tag, fullTag, major, reading })
}
for (let i = 1; i < seen.length; i++) {
  const [before, after] = [seen[i - 1], seen[i]]
  if (!before.reading || !after.reading || !before.reading.id || !after.reading.id || before.reading.id === after.reading.id) continue
  const moved = DEEP_PARTS.filter((key) => before.reading.c[key] !== after.reading.c[key]).map((key) => `${key} ${before.reading.c[key]} -> ${after.reading.c[key]}`)
  console.log(`deep id changes from Chrome ${before.major} (${before.fullTag}) to Chrome ${after.major} (${after.fullTag}): ${moved.join(', ')}`)
}
if (allTags) {
  for (const tag of Object.keys(TAGS)) {
    if (seen.some((block) => block.tag === tag)) continue
    console.log(`FAIL no block for ${tag} (Chrome ${TAGS[tag]}): run.sh did not run every image`)
    failed++
  }
}
process.exit(failed || !blocks.length ? 1 : 0)
