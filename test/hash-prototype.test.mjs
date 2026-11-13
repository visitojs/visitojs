import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const HASH = new URL('../build/esm/hash.js', import.meta.url).href
const INPUT = 'visito:'
const REFERENCE = createHash('sha256').update(INPUT).digest('hex')

// Accessors a page might define on a numeric index of a prototype: one that stores per object and so changes
// nothing, one that returns a constant, one whose value depends on how often it has been read, and one that
// returns an object whose valueOf counts too, so the order of reads and conversions both show in the digest.
const ACCESSORS = {
  stores: '{ get: function () { return this[S] }, set: function (v) { this[S] = v } }',
  constant: '{ get: function () { return 0x5a5a5a5a }, set: function () {} }',
  counts: '{ get: function () { return (this[S] | 0) + reads++ }, set: function (v) { this[S] = v } }',
  objects: '{ get: function () { var v = this[S]; reads++; return { valueOf: function () { return (v | 0) + reads++ } } }, set: function (v) { this[S] = v } }',
}

// What 0.1.0 returned for INPUT while each accessor was installed. 0.1.0 had the tables as array literals,
// so these come from the message schedule alone, read in its order: bytes and w for t < 16, then w for
// t = 16 to 63, then the rounds.
const RELEASED = {
  'constant 5': '76f57017fe9f34753a0971bbfeb3f9014d678b9dc63937c409089995c306d337',
  'constant 20': '240a1e06dd4f2031d92f869f280f49745dde41c9753e3d648111dcefe6355319',
  'constant 40': 'f4a1a2f67a93c950a2f041115814a5c2547352f9b3a3812b36768b959a51c697',
  'counts 5': '4d89ab513855f7668395b16d75a2ce383b1ba708cd82264d62f73aac302b14e3',
  'counts 20': '69f02b424a073edbe9250b7da6bc31499934e13a630f5844305808e7ad364645',
  'counts 40': 'd37a5226d66fed77c740f7adca319fe5e55f122410e9ca836efcdfc7017d8fb0',
  'objects 5': 'be75b3b2f75994bb77010d5e43cb54f9fc5c5042c58b9479c0adbb96b2437330',
  'objects 40': '6c8fe56bf5aeb386f94fbdbc5c66a371ea44dd1ca07269caa66d8e051c66a8be',
  'objects 16-63':'d9d2dfb2d837927c4439cc45c3574a9e36ce6e455b58482d5b33bf9ed6a11fcb',
}

// One process per case, so the accessors and the tables computed under them cannot reach another test.
// The accessors go on indexes from to last; `before` runs ahead of everything else; `warm` makes a first
// call before they are installed.
function digests(target, [from, last], kind, warm, before = '') {
  const script = `
    import { sha256 } from ${JSON.stringify(HASH)}
    let reads = 0
    ${before}
    if (${warm}) sha256('')
    for (let i = ${from}; i <= ${last}; i++) {
      const S = Symbol()
      Object.defineProperty(${target}, i, Object.assign(${ACCESSORS[kind]}, { configurable: true }))
    }
    let during, after
    try { during = sha256(${JSON.stringify(INPUT)}) } finally { for (let i = ${from}; i <= ${last}; i++) delete ${target}[i] }
    after = sha256(${JSON.stringify(INPUT)})
    process.stdout.write(JSON.stringify({ during, after }))`
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' }))
  } catch (error) {
    return { error: error.code || error.message.split('\n')[0] }
  }
}

for (const target of ['Array.prototype', 'Object.prototype']) {
  test(`an index accessor on ${target} during the first call leaves no wrong constant behind`, () => {
    for (const index of [5, 40]) {
      for (const kind of Object.keys(ACCESSORS)) {
        const during = kind === 'stores' ? REFERENCE : RELEASED[kind + ' ' + index]
        assert.deepEqual(digests(target, [index, index], kind, false), { during, after: REFERENCE }, `${kind} ${index}`)
      }
    }
  })

  test(`with a counting accessor on ${target}, sha256 reads the schedule in 0.1.0's order`, () => {
    for (const index of [5, 20, 40]) {
      for (const warm of [true, false]) {
        const label = `counts ${index}${warm ? ' after a first call' : ''}`
        assert.deepEqual(digests(target, [index, index], 'counts', warm), { during: RELEASED['counts ' + index], after: REFERENCE }, label)
      }
    }
    // with accessors on many words at once, conversions of one word's value fall between reads of another's
    for (const warm of [true, false]) {
      const label = `objects 16-63${warm ? ' after a first call' : ''}`
      assert.deepEqual(digests(target, [16, 63], 'objects', warm), { during: RELEASED['objects 16-63'], after: REFERENCE }, label)
    }
  })
}

test('the tables do not go through Object.prototype.__proto__', () => {
  const trap = `Object.defineProperty(Object.prototype, '__proto__', {
    get: function () { throw new Error('__proto__ read') }, set: function () { throw new Error('__proto__ written') }, configurable: true })`
  assert.deepEqual(digests('Object.prototype', [5, 5], 'stores', false, trap), { during: REFERENCE, after: REFERENCE })
})
