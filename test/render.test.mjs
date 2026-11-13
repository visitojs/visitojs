import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as render from '../build/esm/render.js'
import { short } from '../build/esm/hash.js'
import { fakeAudio, fakeDocument, fnv } from './fake-render.mjs'

const { math, canvas, canvasSteps, geometrySteps, audio } = render

const HEX16 = /^[0-9a-f]{16}$/

// ---- Math -------------------------------------------------------------------------------------

test('math: the read gives the same 16-hex digest every time it runs', () => {
  const a = math()
  assert.deepEqual(Object.keys(a), ['r.math'])
  assert.match(a['r.math'], HEX16)
  assert.deepEqual(math(), a)
})

test('math: a function that returns another result gives another digest', () => {
  const before = math()['r.math']
  const saved = Math.cbrt
  try {
    Math.cbrt = (x) => saved(x) + 1e-15
    assert.notEqual(math()['r.math'], before)
  } finally {
    Math.cbrt = saved
  }
  assert.equal(math()['r.math'], before)
})

test('math: a missing or throwing function fills its own slot and the read still gives a digest, without throwing', () => {
  const before = math()['r.math']
  const saved = Math.hypot
  try {
    delete Math.hypot
    const missing = math()['r.math']
    assert.match(missing, HEX16)
    assert.notEqual(missing, before)
    Math.hypot = () => { throw new Error('page replaced it') }
    const throwing = math()['r.math']
    assert.match(throwing, HEX16)
    assert.notEqual(throwing, before)
    assert.notEqual(throwing, missing)
  } finally {
    Math.hypot = saved
  }
})

const NAMES = ['cos', 'sin', 'tan', 'exp', 'expm1', 'log1p', 'log', 'log10', 'log2', 'pow', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'cbrt', 'atan2', 'atan', 'asin', 'acos', 'hypot']

/** Runs `fn` with every Math function the read calls replaced by `make(name)`, then puts them back. */
const withMath = (make, fn) => {
  const saved = {}
  for (const name of NAMES) saved[name] = Math[name]
  try {
    for (const name of NAMES) {
      const replacement = make(name, saved[name])
      if (replacement === undefined) delete Math[name]
      else Math[name] = replacement
    }
    return fn()
  } finally {
    for (const name of NAMES) Math[name] = saved[name]
  }
}

test('math: when no slot holds a number the read is a status, not a digest of statuses', () => {
  assert.deepEqual(withMath(() => undefined, math), { 'r.math': '!na' }, 'every function missing')
  const thrower = () => () => { throw new Error('replaced') }
  assert.deepEqual(withMath(thrower, math), { 'r.math': '!err' }, 'every function throwing')
  let n = 0
  const mixed = () => (n++ % 2 ? undefined : () => { throw new Error('replaced') })
  assert.deepEqual(withMath(mixed, math), { 'r.math': '!err' }, 'some missing, the rest throwing')
  const one = (name, real) => (name === 'cbrt' ? real : undefined)
  assert.match(withMath(one, math)['r.math'], HEX16, 'one real result is enough for a value')
})

test('math: the arguments sit where libraries part: a huge sine argument, a large non-integer power, atanh near its pole, sinh near zero', () => {
  const calls = []
  withMath((name, real) => (...args) => { calls.push([name, ...args]); return real(...args) }, math)
  const of = (name) => calls.filter((c) => c[0] === name)
  assert.ok(of('sin').some(([, x]) => Math.abs(x) > 1e307), 'a sine argument near the top of the double range')
  assert.ok(of('pow').some(([, b, e]) => Math.abs(e) > 1000 && !Number.isInteger(e) && b !== Math.PI), 'a large exponent that is not an integer')
  assert.ok(of('atanh').some(([, x]) => x > 0.9 && x < 1), 'atanh close to 1')
  assert.ok(of('sinh').some(([, x]) => x > 0 && x < 0.01), 'sinh where the textbook formula cancels')
  for (const [name, ...args] of calls) assert.ok(Number.isFinite(Math[name](...args)), `${name}(${args}) must be a finite number`)
})

test('math: when the digest itself cannot be computed the read is "!err", not an exception', () => {
  const saved = String.prototype.charCodeAt
  let out
  try {
    String.prototype.charCodeAt = () => { throw new Error('broken') }
    out = math()
  } finally {
    String.prototype.charCodeAt = saved
  }
  assert.deepEqual(out, { 'r.math': '!err' })
})

// ---- Canvas -----------------------------------------------------------------------------------


const win = (options) => {
  const fake = fakeDocument(options)
  return { w: { document: fake.document }, made: fake.made, measured: fake.measured }
}
// each scene canvas is the scene plus a strip of two known rows above it
const STRIP = 2
const TEXT_SIZE = [236, 68 + STRIP]
const GEOMETRY_SIZE = [200, 60 + STRIP]
const readAt = (size) => (c) => c.readSize && c.readSize[0] === size[0] && c.readSize[1] === size[1]
/** The byte offset of a pixel in the scene of a canvas `width` wide, below the strip. */
const sceneByte = (width, offset) => STRIP * width * 4 + offset
const scenes = (made) => made.filter((c) => c.readSize && c.readSize[0] > 16)
const colourAt = (data, width, x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
/** Problems with a block of single-pixel cells: too few colours, a translucent cell, or a cell too close to a neighbour. */
const cellProblems = (data, width, rows) => {
  const out = []
  const colours = new Set()
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const c = colourAt(data, width, x, y)
      colours.add(c.join())
      if (c[3] !== 255) out.push(`(${x},${y}) is not opaque`)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= rows) continue
          const n = colourAt(data, width, nx, ny)
          if (Math.max(Math.abs(n[0] - c[0]), Math.abs(n[1] - c[1]), Math.abs(n[2] - c[2])) <= 8) out.push(`(${x},${y}) is within 8 of (${nx},${ny})`)
        }
      }
    }
  }
  if (colours.size < 16) out.push(`only ${colours.size} colours`)
  return { problems: out.slice(0, 5), colours }
}

test('canvas: an unaltered canvas gives one 16-hex digest per scene, and the two scenes differ', () => {
  const a = canvas(win().w)
  assert.deepEqual(Object.keys(a).sort(), ['r.cchk', 'r.cg', 'r.ct'])
  assert.match(a['r.cg'], HEX16)
  assert.match(a['r.ct'], HEX16)
  assert.notEqual(a['r.cg'], a['r.ct'])
  assert.deepEqual(canvas(win().w), a)
})

test('canvas: a missing or broken document is "!err" and a browser without a 2D context is "!na", and neither throws', () => {
  assert.deepEqual(canvas({}), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
  assert.deepEqual(canvas(win({ createThrows: true }).w), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
  assert.deepEqual(canvas(win({ noContext: true }).w), { 'r.cg': '!na', 'r.ct': '!na', 'r.cchk': '!na' })
  const noMethod = fakeDocument()
  const element = noMethod.document.createElement
  noMethod.document.createElement = (tag) => Object.assign(element(tag), { getContext: undefined })
  assert.deepEqual(canvas({ document: noMethod.document }), { 'r.cg': '!na', 'r.ct': '!na', 'r.cchk': '!na' })
  assert.deepEqual(canvas(win({ getContext: () => { throw new Error('nope') } }).w), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
  assert.deepEqual(canvas(win({ getContext: () => ({}) }).w), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
  assert.deepEqual(canvas(win({ throwOn: 'fillText' }).w), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
})

test('canvas: a read the browser refuses with a SecurityError is "!noise"; any other read error is "!err"', () => {
  const refused = new Error('blocked')
  refused.name = 'SecurityError'
  assert.deepEqual(canvas(win({ readThrows: refused }).w), { 'r.cg': '!noise', 'r.ct': '!noise', 'r.cchk': 'blocked' })
  assert.deepEqual(canvas(win({ readThrows: new Error('other') }).w), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' })
  assert.equal(canvas(win({ readThrows: refused }).w, true)['r.cchk'], 'blocked')
})

test('canvas: the pattern check catches a browser that alters a few pixels of every read, even one that spares single-colour canvases', () => {
  // the documented randomiser: up to 255 pixels per read, one channel flipped in its lowest bits, constant colours left alone
  const randomiser = (data) => {
    const first = data.slice(0, 4).join()
    let constant = true
    for (let i = 4; i < data.length; i += 4) if (data.slice(i, i + 4).join() !== first) { constant = false; break }
    if (constant) return
    for (let p = 0; p < 20; p++) data[((p * 7919) % (data.length / 4)) * 4 + (p % 3)] ^= 1
  }
  const fake = win({ alter: randomiser })
  const out = canvas(fake.w, true)
  assert.equal(out['r.cg'], '!noise')
  assert.equal(out['r.ct'], '!noise')
  assert.equal(out['r.cchk'], 'pattern')
  assert.deepEqual(canvas(win({ alter: randomiser }).w), { 'r.cg': '!noise', 'r.ct': '!noise', 'r.cchk': 'pattern' })
})

test('canvas: an alteration of the first read only is caught by the pattern, which is read first', () => {
  let reads = 0
  const firstOnly = (data) => { if (++reads === 1) data[0] ^= 1 }
  const out = canvas(win({ alter: firstOnly }).w, true)
  assert.equal(out['r.cchk'], 'pattern')
  assert.equal(out['r.cg'], '!noise')
})

test('canvas: the pattern is 16 by 16 single-pixel cells, every one its own opaque colour and unlike its eight neighbours, read once before any scene', () => {
  const fake = win()
  canvas(fake.w)
  const pattern = fake.made[0]
  assert.equal(pattern.tag, 'canvas')
  assert.deepEqual(pattern.readSize, [16, 16])
  assert.equal(pattern.ops.length, 0, 'only whole-pixel opaque rectangles, so nothing is left to the rasteriser')
  assert.equal(pattern.reads, 1)
  // a protection that spares flat or few-colour canvases, or a pixel whose neighbours share its colour, cannot spare these
  const cells = cellProblems(pattern.read, 16, 16)
  assert.deepEqual(cells.problems, [])
  assert.equal(cells.colours.size, 256, 'as many colours as a 16 by 16 canvas can hold, so no "few colours" threshold spares it')
})

test('canvas: every scene canvas, the readback variants included, has a strip of two known rows above its scene, in colours the pattern does not use', () => {
  const fake = win()
  canvas(fake.w, true)
  const patternColours = cellProblems(fake.made[0].read, 16, 16).colours
  const read = scenes(fake.made)
  assert.equal(read.length, 6, 'two geometry drawings, two text drawings and the two readback variants')
  for (const c of read) {
    assert.ok(readAt(GEOMETRY_SIZE)(c) || readAt(TEXT_SIZE)(c), `canvas ${c.index} is ${c.readSize}`)
    const strip = cellProblems(c.read, c.readSize[0], STRIP)
    assert.deepEqual(strip.problems, [], `canvas ${c.index}`)
    for (const colour of strip.colours) assert.ok(!patternColours.has(colour), `${colour} is in the pattern too, so one colour-keyed draw could spare both`)
  }
})

test('canvas: the two drawings of a scene carry different strips, unlike at every cell, so an alteration keyed by contents lands differently in each', () => {
  const fake = win()
  canvas(fake.w, true)
  for (const size of [GEOMETRY_SIZE, TEXT_SIZE]) {
    const [first, second, variant] = fake.made.filter(readAt(size))
    const width = size[0]
    for (let y = 0; y < STRIP; y++) {
      for (let x = 0; x < width; x++) {
        assert.notEqual(colourAt(second.read, width, x, y).join(), colourAt(first.read, width, x, y).join(), `(${x},${y}) of the ${width}-wide scene`)
      }
    }
    assert.equal(variant.read.subarray(0, STRIP * width * 4).join(), first.read.subarray(0, STRIP * width * 4).join(), 'the readback variant carries the first strip')
    assert.equal(second.read.subarray(STRIP * width * 4).join(), first.read.subarray(STRIP * width * 4).join(), 'and the scenes below the strips are the same')
  }
})

/** Whether `data` holds `limit` colours or fewer. */
const fewColours = (data, limit) => {
  const seen = new Set()
  for (let i = 0; i < data.length; i += 4) {
    seen.add(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))
    if (seen.size > limit) return false
  }
  return true
}
const mix = (h) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}
/**
 * The review's alteration: a canvas of `limit` colours or fewer is left alone; on any other, 20 different pixels chosen from a
 * hash of the session's salt and the contents get one channel flipped in a low bit. Deterministic within a session, so two
 * identical drawings get the same change.
 */
const sparseKeyed = (salt, limit) => (data) => {
  if (fewColours(data, limit)) return
  let h = fnv('session ' + salt)
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619) >>> 0
  const pixels = data.length / 4
  const chosen = new Set()
  for (let p = 0; chosen.size < 20; p++) {
    h = mix(h + p + 1)
    const pixel = h % pixels
    if (chosen.has(pixel)) continue
    chosen.add(pixel)
    data[pixel * 4 + ((h >>> 24) % 3)] ^= 1 + ((h >>> 20) & 1)
  }
}

test('canvas: 20 pixels keyed by a session salt and the contents, sparing canvases of 16 colours or fewer, are "!noise" in every one of 200 sessions', () => {
  const missed = []
  for (let session = 1; session <= 200; session++) {
    const out = canvas(win({ alter: sparseKeyed(session, 16) }).w, true)
    if (out['r.cg'] !== '!noise' || out['r.ct'] !== '!noise' || out['r.cchk'] === 'ok') missed.push(`${session}: ${out['r.cg']} ${out['r.ct']} ${out['r.cchk']}`)
  }
  assert.deepEqual(missed, [])
})

test('canvas: the same alteration sparing canvases of 256 colours or fewer, the pattern included, is still "!noise" in every one of 200 sessions, from the strips or the pair', () => {
  const missed = []
  const checks = new Set()
  for (let session = 1; session <= 200; session++) {
    const out = canvas(win({ alter: sparseKeyed(session, 256) }).w, true)
    checks.add(out['r.cchk'])
    if (out['r.cg'] !== '!noise' || out['r.ct'] !== '!noise' || !['geometry-patch', 'geometry'].includes(out['r.cchk'])) missed.push(`${session}: ${out['r.cg']} ${out['r.ct']} ${out['r.cchk']}`)
  }
  assert.deepEqual(missed, [])
  assert.ok(checks.has('geometry'), 'most sessions miss both strips and are caught by the two drawings differing')
})

test('canvas: a deterministic alteration that spares the pattern is caught by the strip of the first scene read ("altered from the second read")', () => {
  let reads = 0
  const fromSecond = (data) => { if (++reads > 1) data[5] ^= 2 }
  const out = canvas(win({ alter: fromSecond }).w, true)
  assert.deepEqual([out['r.cg'], out['r.ct'], out['r.cchk']], ['!noise', '!noise', 'geometry-patch'])
})

test('canvas: colour-keyed offsets on every pixel unlike its neighbours, sparing the 16 by 16 read (the shape WebKit describes), are caught by the strip', () => {
  const keyed = (data, element) => {
    if (element.width <= 16) return
    const w = element.width, h = element.height
    const source = new Uint8ClampedArray(data)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4
        const own = source.subarray(at, at + 4).join()
        let alike = true
        for (let dy = -1; dy <= 1 && alike; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && source.subarray((ny * w + nx) * 4, (ny * w + nx) * 4 + 4).join() !== own) { alike = false; break }
        }
        if (alike) continue
        const offset = (fnv('salt 3|' + own) % 7) - 3
        for (let k = 0; k < 3; k++) data[at + k] = source[at + k] + offset
      }
    }
  }
  const out = canvas(win({ alter: keyed }).w, true)
  assert.deepEqual([out['r.cg'], out['r.ct'], out['r.cchk']], ['!noise', '!noise', 'geometry-patch'])
})

test('canvas: an alteration of text-sized reads only is caught by the text strip', () => {
  const textOnly = (data, element) => { if (readAt(TEXT_SIZE)(element)) data[13] ^= 4 }
  const out = canvas(win({ alter: textOnly }).w, true)
  assert.deepEqual([out['r.cg'], out['r.ct'], out['r.cchk']], ['!noise', '!noise', 'text-patch'])
})

test('canvas: a readback variant whose strip comes back altered is "!noise" in its own key, and the main values stand', () => {
  const variants = (data, element) => { if (element.contextArgs && element.contextArgs[1]) data[0] ^= 1 }
  const base = canvas(win().w, true)
  const out = canvas(win({ alter: variants }).w, true)
  assert.deepEqual([out['r.cgcpu'], out['r.ctcpu']], ['!noise', '!noise'])
  assert.deepEqual([out['r.cg'], out['r.ct'], out['r.cchk']], [base['r.cg'], base['r.ct'], 'ok'])
})

test('canvas: the strip is checked, not hashed: r.cg is the digest of "r.cg:200x60:" and the 200 by 60 scene below the strip', () => {
  const fake = win()
  const out = canvas(fake.w)
  const [first] = fake.made.filter(readAt(GEOMETRY_SIZE))
  const [text] = fake.made.filter(readAt(TEXT_SIZE))
  const digestOf = (prefix, bytes) => short(prefix + String.fromCharCode(...bytes))
  assert.equal(out['r.cg'], digestOf('r.cg:200x60:', first.read.subarray(STRIP * 200 * 4)))
  assert.equal(out['r.ct'], digestOf('r.ct:236x68:', text.read.subarray(STRIP * 236 * 4)))
})

test('canvas: an alteration that spares the pattern and the strip and is the same on every read passes every check, the limit docs/SIGNALS.md names', () => {
  const base = canvas(win().w, true)
  const sceneOnly = (data, element) => { if (element.width > 16) data[sceneByte(element.width, 40)] ^= 1 }
  const out = canvas(win({ alter: sceneOnly }).w, true)
  assert.equal(out['r.cchk'], 'ok')
  assert.match(out['r.cg'], HEX16)
  assert.notEqual(out['r.cg'], base['r.cg'])
})

test('canvas: no canvas is ever read twice, because a browser may change how a canvas is backed once it has been read', () => {
  const fake = win()
  canvas(fake.w, true)
  const read = fake.made.filter((c) => c.reads)
  assert.ok(read.length >= 7, 'pattern, two geometry drawings, two text drawings and the two diagnostics')
  for (const c of read) assert.equal(c.reads, 1, `canvas ${c.index} (${c.readSize}) was read ${c.reads} times`)
})

test('canvas: noise that changes on every read, and spares the pattern, is caught by comparing two drawings of a scene', () => {
  let reads = 0
  const perRead = (data, element) => { if (element.width > 16) data[sceneByte(element.width, 5)] ^= (++reads & 3) + 1 }
  const out = canvas(win({ alter: perRead }).w, true)
  assert.equal(out['r.cg'], '!noise')
  assert.equal(out['r.ct'], '!noise')
  assert.equal(out['r.cchk'], 'geometry')
})

test('canvas: two drawings of the geometry, or of the text, that differ are "!noise", and the check names the scene', () => {
  // stable per canvas, different per canvas: per-draw noise, or rendering that is not reproducible
  const perCanvas = (size) => (data, element) => { if (readAt(size)(element)) data[sceneByte(size[0], 9)] ^= element.index & 0xff }
  const g = canvas(win({ alter: perCanvas(GEOMETRY_SIZE) }).w, true)
  assert.deepEqual([g['r.cg'], g['r.ct'], g['r.cchk']], ['!noise', '!noise', 'geometry'])
  const t = canvas(win({ alter: perCanvas(TEXT_SIZE) }).w, true)
  assert.deepEqual([t['r.cg'], t['r.ct'], t['r.cchk']], ['!noise', '!noise', 'text'])
})

test('canvas: the value is the pixels, so one changed byte in a scene changes that scene\'s digest and only that one', () => {
  const base = canvas(win().w)
  const geometryOnly = (data, element) => { if (readAt(GEOMETRY_SIZE)(element)) data[sceneByte(200, 1234)] ^= 1 }
  const textOnly = (data, element) => { if (readAt(TEXT_SIZE)(element)) data[sceneByte(236, 4321)] ^= 1 }
  const g = canvas(win({ alter: geometryOnly }).w)
  const t = canvas(win({ alter: textOnly }).w)
  assert.notEqual(g['r.cg'], base['r.cg'])
  assert.equal(g['r.ct'], base['r.ct'])
  assert.equal(t['r.cg'], base['r.cg'])
  assert.notEqual(t['r.ct'], base['r.ct'])
})

test('canvas: the geometry scene is 200 by 60 and draws no text, so fonts change only the text scene (236 by 68); each is drawn twice, below its strip', () => {
  const fake = win()
  canvas(fake.w)
  const geometry = fake.made.filter(readAt(GEOMETRY_SIZE))
  const text = fake.made.filter(readAt(TEXT_SIZE))
  assert.equal(geometry.length, 2, 'the geometry is drawn on two canvases')
  assert.equal(text.length, 2, 'the text is drawn on two canvases')
  for (const g of geometry) assert.ok(!g.ops.some((op) => /Text"/.test(op)), 'no text in the geometry scene')
  assert.ok(text[0].ops.some((op) => /fillText"/.test(op)) && text[0].ops.some((op) => /strokeText"/.test(op)))
  assert.equal(geometry[0].ops.join(), geometry[1].ops.join(), 'the second drawing is the same drawing')
  assert.equal(text[0].ops.join(), text[1].ops.join(), 'the second drawing is the same drawing')

  const base = canvas(win().w)
  const otherFonts = canvas(win({ fontSalt: 'another machine' }).w)
  assert.equal(otherFonts['r.cg'], base['r.cg'])
  assert.notEqual(otherFonts['r.ct'], base['r.ct'])
})

test('canvas: every canvas is released once it has been read', () => {
  const fake = win()
  canvas(fake.w, true)
  for (const c of fake.made) assert.deepEqual([c.width, c.height], [0, 0], `canvas ${c.index} still holds a bitmap`)
})

test('canvas: the text scene lays its rows out from their tops, in generic families only, with marks, Greek, Arabic and symbols', () => {
  const fake = win()
  canvas(fake.w)
  const text = fake.made.find(readAt(TEXT_SIZE))
  const drawn = text.ops.map((op) => JSON.parse(op)).filter((op) => /Text$/.test(op[0]))
  for (const op of drawn) {
    assert.equal(op[op.length - 3], 'top', 'rows are placed by their top edge')
    assert.match(op[op.length - 2], /^\d+(\.\d+)?px (serif|sans-serif|monospace)$/)
  }
  assert.ok(drawn.some((op) => op[1][0] === 'Hamburgefonstiv 0123 fi ffl AV To.' && op[op.length - 2] === '15.5px serif'))
  const strings = drawn.map((op) => op[1][0])
  assert.equal(new Set(strings).size, strings.length, 'each row draws its own string')
  const mixed = strings.find((s) => /م/.test(s))
  assert.ok(mixed.includes('é') && mixed.includes('é'), 'a combining accent and the precomposed letter')
  assert.ok(mixed.includes('Ωμέγα') && mixed.includes('مرحبا') && mixed.includes('∑√∞'))
  assert.ok(!/[぀-ヿ㐀-鿿가-힯Ѐ-ӿ]/.test(strings.join('')), 'nothing whose glyph depends on the language')
})

test('canvas: blending is exercised in soft-light mode, and a browser without that mode skips the element and still gives a value', () => {
  const fake = win()
  const base = canvas(fake.w)
  const geometry = fake.made.find(readAt(GEOMETRY_SIZE))
  assert.ok(geometry.ops.some((op) => JSON.parse(op)[4] === 'soft-light'))
  assert.ok(!geometry.ops.some((op) => JSON.parse(op)[4] === 'multiply'))
  const out = canvas(win({ unsupportedMode: 'soft-light' }).w)
  assert.match(out['r.cg'], HEX16)
  assert.notEqual(out['r.cg'], base['r.cg'])
})

test('canvas: with diagnostics, the check is "ok" and both scenes are hashed again, once each, on canvases meant for reading back', () => {
  const fake = win()
  const out = canvas(fake.w, true)
  assert.equal(out['r.cchk'], 'ok')
  assert.match(out['r.cgcpu'], HEX16)
  assert.match(out['r.ctcpu'], HEX16)
  const cpu = fake.made.filter((c) => c.contextArgs && c.contextArgs[1] && c.contextArgs[1].willReadFrequently === true)
  assert.deepEqual(cpu.map((c) => c.readSize), [GEOMETRY_SIZE, TEXT_SIZE])
  assert.equal(canvas(win({ noContext: true }).w, true)['r.cchk'], '!na')
  assert.ok(!('r.cgcpu' in canvas(win().w)), 'no diagnostics unless asked for')
})

test('canvas: as steps, the read is named pieces of work run one call at a time, with the same result as one call', () => {
  const fake = win()
  const steps = canvasSteps(fake.w, true)
  assert.equal(fake.made.length, 0, 'making the sequence does no work')
  assert.deepEqual(steps.names, ['pattern', 'geometry', 'geometry2', 'font-serif', 'font-sans', 'font-mixed', 'font-mono', 'text', 'text2', 'hash-geometry', 'hash-text', 'cpu-geometry', 'hash-cpu-geometry', 'cpu-text', 'hash-cpu-text'])
  assert.deepEqual(steps.parts(), { 'r.cg': '!to', 'r.ct': '!to', 'r.cchk': '!to', 'r.cgcpu': '!to', 'r.ctcpu': '!to' }, 'unfinished')
  const readsPerStep = []
  let more = true
  for (let i = 0; i < steps.names.length; i++) {
    const before = fake.made.reduce((n, c) => n + c.reads, 0)
    more = steps.next()
    readsPerStep.push(fake.made.reduce((n, c) => n + c.reads, 0) - before)
    assert.equal(more, i < steps.names.length - 1)
  }
  assert.deepEqual(readsPerStep, [1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0], 'one canvas read per drawing step, none in a font or digest step')
  assert.equal(steps.next(), false, 'nothing is left')
  assert.deepEqual(steps.parts(), canvas(win().w, true))
  assert.equal(canvasSteps(win().w).names.length, 11, 'no diagnostic steps unless asked for')
})

test('canvas: each font the text scene uses is measured in a step of its own before the text is drawn, so its first use is not one long task', () => {
  const fake = win()
  const steps = canvasSteps(fake.w)
  const fonts = []
  for (let i = 0; i < steps.names.length; i++) {
    const before = fake.measured.length
    const drawnBefore = fake.made.filter(readAt(TEXT_SIZE)).length
    steps.next()
    if (/^font-/.test(steps.names[i])) {
      assert.equal(fake.measured.length - before, 1, `${steps.names[i]} measures one row`)
      assert.equal(fake.made.filter(readAt(TEXT_SIZE)).length, drawnBefore, 'and draws no text')
      fonts.push(fake.measured[fake.measured.length - 1])
    }
  }
  const text = fake.made.find(readAt(TEXT_SIZE))
  const drawn = text.ops.map((op) => JSON.parse(op)).filter((op) => /Text$/.test(op[0])).map((op) => [op[op.length - 2], op[1][0]])
  assert.deepEqual(fonts, drawn, 'the rows measured are the rows drawn, font for font')
})

test('geometrySteps: the geometry scene alone, in four steps, with the value and the check canvasSteps gives for it, and no text, font or language', () => {
  const run = (options) => {
    const fake = win(options)
    const steps = geometrySteps(fake.w)
    assert.equal(fake.made.length, 0, 'making the sequence does no work')
    assert.deepEqual(steps.parts(), { 'r.cg': '!to', 'r.cchk': '!to' }, 'unfinished')
    while (steps.next()) {
      // one step per call
    }
    assert.equal(steps.next(), false)
    const text = fake.made.reduce((n, c) => n + c.ops.filter((op) => /^\["(fillText|strokeText)"/.test(op)).length + (c.getAttribute('lang') !== null ? 1 : 0), 0) + fake.measured.length
    assert.equal(text, 0, 'no text drawn or measured, no canvas given a language')
    assert.ok(!fake.made.some(readAt(TEXT_SIZE)), 'no text-sized canvas')
    return { steps, parts: steps.parts() }
  }
  const refused = new Error('blocked')
  refused.name = 'SecurityError'
  let drawn
  const cases = {
    'no fault': {},
    'no 2D context': { noContext: true },
    'createElement throws': { createThrows: true },
    'a refused readback': { readThrows: refused },
    'a readback that throws': { readThrows: new Error('broken') },
    'every read altered': { alter: (data) => { for (let i = 0; i < 20; i++) data[(i * 7919) % data.length] ^= 1 } },
    'the first geometry drawing altered below its strip': { alter: (data, element) => { if (element.width === 200 && drawn++ === 0) data[sceneByte(200, 400)] ^= 1 } },
    'a geometry strip altered': { alter: (data, element) => { if (element.width === 200) data[4] ^= 1 } },
  }
  for (const name of Object.keys(cases)) {
    drawn = 0
    const { steps, parts } = run(cases[name])
    assert.deepEqual(steps.names, ['pattern', 'geometry', 'geometry2', 'hash-geometry'], name)
    drawn = 0
    const lab = canvas(win(cases[name]).w)
    assert.deepEqual(parts, { 'r.cg': lab['r.cg'], 'r.cchk': lab['r.cchk'] }, name)
  }
  assert.match(run({}).parts['r.cg'], HEX16)
})

test('canvas: a page that broke measureText only loses the warm-up; the values are the same', () => {
  const base = canvas(win().w, true)
  assert.deepEqual(canvas(win({ measureThrows: true }).w, true), base)
})

test('canvas: as steps, a check that fires settles the result and the remaining steps do nothing', () => {
  const fake = win({ noContext: true })
  const steps = canvasSteps(fake.w, true)
  assert.equal(steps.next(), false)
  assert.equal(steps.next(), false)
  assert.deepEqual(steps.parts(), { 'r.cg': '!na', 'r.ct': '!na', 'r.cchk': '!na', 'r.cgcpu': '!na', 'r.ctcpu': '!na' })
})

test('canvas: the check that decided is given without diagnostics too, so an entry that shows no diagnostics still says why', () => {
  const out = canvas(win().w)
  assert.deepEqual(Object.keys(out).sort(), ['r.cchk', 'r.cg', 'r.ct'])
  assert.equal(out['r.cchk'], 'ok')
  assert.deepEqual(canvas(win({ noContext: true }).w), { 'r.cg': '!na', 'r.ct': '!na', 'r.cchk': '!na' })
  const steps = canvasSteps(win().w)
  assert.deepEqual(steps.parts(), { 'r.cg': '!to', 'r.ct': '!to', 'r.cchk': '!to' }, 'unfinished')
})

test('canvas: every canvas the read makes has lang "en" before its context exists, so the browser\'s interface language cannot pick the text fallback', () => {
  const fake = fakeDocument()
  const make = fake.document.createElement
  fake.document.createElement = (tag) => {
    const element = make(tag)
    const getContext = element.getContext
    element.getContext = function (...args) {
      element.langAtContext = element.getAttribute('lang')
      return getContext.apply(this, args)
    }
    return element
  }
  canvas({ document: fake.document }, true)
  assert.ok(fake.made.length > 6)
  for (const c of fake.made) assert.equal(c.langAtContext, 'en', `canvas ${c.index} (${c.readSize || 'not read'})`)
})

test('canvas: the language is set as the lang attribute and read back; a page that changed the lang property changes nothing', () => {
  const intact = canvas(win().w)
  for (const [label, define] of [
    ['a setter that throws', { get() { return 'en' }, set() { throw new Error('page') } }],
    ['a setter that writes another language', { get() { return 'ja' }, set() { this.setAttribute('lang', 'ja') } }],
    ['a getter that throws', { get() { throw new Error('page') }, set() {} }],
    ['garbage', { get() { return { toString() { throw new Error('page') } } }, set() {} }],
  ]) {
    const fake = fakeDocument()
    const make = fake.document.createElement
    fake.document.createElement = (tag) => Object.defineProperty(make(tag), 'lang', { configurable: true, ...define })
    assert.deepEqual(canvas({ document: fake.document }), intact, label)
  }
})

test('canvas: a lang attribute that does not read back as "en" is "!err": the text would be drawn in a language the page chose', () => {
  for (const [label, change] of [
    ['setAttribute writes another language', (e) => { const set = e.setAttribute; e.setAttribute = (name) => set.call(e, name, 'ja') }],
    ['setAttribute does nothing', (e) => { e.setAttribute = () => {} }],
    ['setAttribute throws', (e) => { e.setAttribute = () => { throw new Error('page') } }],
    ['setAttribute missing', (e) => { e.setAttribute = undefined }],
    ['getAttribute garbage', (e) => { e.getAttribute = () => ({ toString() { throw new Error('page') } }) }],
    ['getAttribute throws', (e) => { e.getAttribute = () => { throw new Error('page') } }],
  ]) {
    const fake = fakeDocument()
    const make = fake.document.createElement
    fake.document.createElement = (tag) => { const e = make(tag); change(e); return e }
    assert.deepEqual(canvas({ document: fake.document }), { 'r.cg': '!err', 'r.ct': '!err', 'r.cchk': '!err' }, label)
  }
})

test('canvas: an element that is not a canvas, without getContext or setAttribute, is "!na" as in a browser without 2D canvas', () => {
  const doc = { createElement: () => ({}) }
  assert.deepEqual(canvas({ document: doc }), { 'r.cg': '!na', 'r.ct': '!na', 'r.cchk': '!na' })
})

test('digestHolds: the digest the reads use gives its known answers on intact built-ins, through the canvas and the audio paths', () => {
  assert.equal(render.digestHolds(), true)
})

test('digestHolds: a page that broke what the digest calls, without anything throwing, fails it', () => {
  const tampers = {
    'String.fromCharCode returns an empty string': [String, 'fromCharCode', () => ''],
    'String.fromCharCode appends randomness': [String, 'fromCharCode', ((real) => function () { return real.apply(String, arguments) + Math.random() })(String.fromCharCode)],
    'Function.prototype.apply ignores its arguments': [Function.prototype, 'apply', ((real) => function (self) { return real.call(this, self) })(Function.prototype.apply)],
    'Uint8ClampedArray subarray truncated': [Uint8ClampedArray.prototype, 'subarray', ((real) => function (a, b) { return real.call(this, a, b - 1) })(Uint8ClampedArray.prototype.subarray)],
    'Uint8Array subarray truncated': [Uint8Array.prototype, 'subarray', ((real) => function (a, b) { return real.call(this, a, b - 1) })(Uint8Array.prototype.subarray)],
    'DataView setFloat32 writes nothing': [DataView.prototype, 'setFloat32', () => {}],
  }
  for (const name of Object.keys(tampers)) {
    const [target, key, value] = tampers[name]
    const saved = Object.getOwnPropertyDescriptor(target, key)
    let held
    try {
      Object.defineProperty(target, key, { configurable: true, writable: true, value })
      held = render.digestHolds()
    } finally {
      if (saved) Object.defineProperty(target, key, saved)
      else delete target[key]
    }
    assert.equal(held, false, name)
  }
  assert.equal(render.digestHolds(), true, 'restored')
})

// ---- Audio ------------------------------------------------------------------------------------


const listen = (w, ms, diagnose) => new Promise((resolve) => {
  const calls = []
  audio(w, (values) => {
    calls.push(values)
    // give stray late deliveries a chance to show up
    setTimeout(() => resolve(calls), (ms || 50) + 60)
  }, ms, diagnose)
})

const audioWin = (options) => {
  const fake = fakeAudio(options)
  return { w: { OfflineAudioContext: fake.Context, setTimeout, clearTimeout }, log: fake.log }
}

/** The known-answer buffer the read plays into channel 1. */
const knownBuffer = async () => {
  const a = audioWin()
  await listen(a.w)
  return a.log.contexts[0].nodes.find((n) => n.kind === 'source').buffer.getChannelData(0)
}

test('audio: no offline audio context is "!na"; the prefixed one is used when it is the only one', async () => {
  assert.deepEqual(await listen({ setTimeout, clearTimeout }), [{ 'r.audio': '!na', 'r.achk': '!na' }])
  const fake = fakeAudio()
  const prefixed = await listen({ webkitOfflineAudioContext: fake.Context, setTimeout, clearTimeout })
  assert.equal(prefixed.length, 1)
  assert.match(prefixed[0]['r.audio'], HEX16)
})

test('audio: on a prefixed engine whose merger concatenates the channels of its inputs (WebKit before 2020), the read is a value, not "!noise"', async () => {
  const fake = fakeAudio({ oldMerger: true })
  const out = await listen({ webkitOfflineAudioContext: fake.Context, setTimeout, clearTimeout }, 50, true)
  assert.equal(out.length, 1)
  assert.equal(out[0]['r.achk'], 'ok')
  assert.match(out[0]['r.audio'], HEX16)
  assert.equal(out[0]['r.audio'], (await listen(audioWin().w, 50, true))[0]['r.audio'], 'the same value as an engine that follows the specification')
})

test('audio: the node that feeds merger input 0 is explicitly mono, set before it is connected', async () => {
  const a = audioWin()
  await listen(a.w)
  const nodes = a.log.contexts[0].nodes
  const gain = nodes.find((n) => n.kind === 'gain')
  const merger = nodes.find((n) => n.kind === 'merger')
  assert.ok(gain.links.some(([t, , input, count, mode]) => t === merger && input === 0 && count === 1 && mode === 'explicit'))
  assert.deepEqual([gain.channelCount, gain.channelCountMode], [1, 'explicit'])
})

test('audio: a context that cannot be built, cannot start or rejects is "!err", reported once', async () => {
  assert.deepEqual(await listen(audioWin({ constructThrows: true }).w), [{ 'r.audio': '!err', 'r.achk': '!err' }])
  assert.deepEqual(await listen(audioWin({ startThrows: true }).w), [{ 'r.audio': '!err', 'r.achk': '!err' }])
  assert.deepEqual(await listen(audioWin({ rejects: true }).w), [{ 'r.audio': '!err', 'r.achk': '!err' }])
  const throwingGetter = { setTimeout, clearTimeout }
  Object.defineProperty(throwingGetter, 'OfflineAudioContext', { get() { throw new Error('denied') } })
  assert.deepEqual(await listen(throwingGetter), [{ 'r.audio': '!err', 'r.achk': '!err' }])
})

test('audio: a faithful render gives one 16-hex digest, reported once even when the event and the promise both arrive', async () => {
  const a = audioWin({ twice: true })
  const calls = await listen(a.w)
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0]), ['r.audio', 'r.achk'])
  assert.match(calls[0]['r.audio'], HEX16)
  assert.deepEqual(await listen(audioWin().w), calls)
  assert.deepEqual(await listen(audioWin({ legacy: true }).w), calls, 'an engine whose startRendering returns nothing still answers through the event')
  assert.deepEqual(await listen(audioWin({ noEvent: true }).w), calls, 'and one that only resolves the promise')
})

test('audio: the context is two channels of 5,120 frames at 44,100 Hz, built from factory methods, as the specification says', async () => {
  const a = audioWin()
  await listen(a.w)
  assert.deepEqual(a.log.constructed, [[2, 5120, 44100]])
  const nodes = a.log.contexts[0].nodes
  const find = (kind) => nodes.find((n) => n.kind === kind)
  const osc = find('oscillator')
  assert.equal(osc.type, 'sawtooth')
  assert.equal(osc.frequency.value, 6000)
  assert.equal(osc.detune.value, 7)
  assert.equal(osc.started, 0)
  const shaper = find('shaper')
  assert.equal(shaper.oversample, '4x')
  assert.equal(shaper.curve.length, 257)
  assert.ok(shaper.curve instanceof Float32Array)
  const peak = Math.max(...shaper.curve)
  assert.ok(peak > 0.85 && peak <= 0.9, 'scaled to about plus or minus 0.9')
  assert.equal(Math.min(...shaper.curve), -peak, 'odd')
  assert.equal(shaper.curve[128], 0)
  assert.ok(shaper.curve[256] < peak, 'it folds back past its peak, which a smooth sine-like hump does')
  const biquad = find('biquad')
  assert.deepEqual([biquad.type, biquad.frequency.value, biquad.Q.value, biquad.gain.value], ['peaking', 3100, 2.2, 9])
  const comp = find('compressor')
  assert.deepEqual([comp.threshold.value, comp.knee.value, comp.ratio.value, comp.attack.value, comp.release.value], [-38, 24, 9, 0.002, 0.2])
  assert.equal(find('gain').gain.value, 0.8)
  const merger = find('merger')
  assert.equal(merger.inputs, 2)
  assert.ok(find('gain').links.some(([t, , input]) => t === merger && input === 0))
  const source = find('source')
  assert.ok(source.links.some(([t, , input]) => t === merger && input === 1))
  assert.equal(source.started, 0)
  assert.ok(merger.links.some(([t]) => t === a.log.contexts[0].destination))
  assert.equal(source.buffer.getChannelData(0).length, 256)
})

test('audio: the known answers are exact single-precision normals spread over every binary exponent from 2^-1 to 2^-126', async () => {
  const known = await knownBuffer()
  const exponents = new Set()
  for (let k = 0; k < known.length; k++) {
    const v = known[k]
    assert.ok(Math.abs(v) >= 2 ** -126 && Math.abs(v) < 1, `frame ${k}: ${v} is a normal number below 1`)
    assert.equal(Math.sign(v), k % 2 ? 1 : -1, 'alternating in sign')
    const e = Math.floor(Math.log2(Math.abs(v)))
    exponents.add(e)
    const mantissa = Math.abs(v) / 2 ** (e - 23)
    assert.ok(Number.isInteger(mantissa) && mantissa % 2 === 1, `frame ${k}: an odd 24-bit significand, so its lowest bit is in use`)
  }
  for (let e = -126; e <= -1; e++) assert.ok(exponents.has(e), `some known value has exponent ${e}`)
})

// only the 256 known frames are touched: the silent frames after them would give any noise away on their own
test('audio: small absolute noise, down to far below what a value near 0.5 can hold, changes known values and is "!noise"', async () => {
  for (const size of [1e-8, 2.9e-8, 1e-9, 1e-12, 1e-20, 1e-30]) {
    const absolute = (ch0, ch1) => { for (let i = 0; i < 256; i++) { ch0[i] += size; ch1[i] += size } }
    const out = await listen(audioWin({ alter: absolute }).w, 50, true)
    assert.deepEqual([out[0]['r.audio'], out[0]['r.achk']], ['!noise', 'pattern'], `noise of ${size}`)
  }
  // normally distributed, the shape WebKit describes, with a standard deviation of 1e-9
  let seed = 7
  const uniform = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const gaussian = (ch0, ch1) => {
    for (let i = 0; i < 256; i++) {
      const n = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()) * 1e-9
      ch0[i] += n
      ch1[i] += n
    }
  }
  assert.equal((await listen(audioWin({ alter: gaussian }).w, 50, true))[0]['r.achk'], 'pattern')
})

test('audio: relative noise just above the single-precision step, and noise on a few samples only, is "!noise"', async () => {
  const relative = (ch0, ch1) => { for (let i = 0; i < 256; i++) { ch0[i] *= 1 + 1e-7; ch1[i] *= 1 + 1e-7 } }
  assert.equal((await listen(audioWin({ alter: relative }).w, 50, true))[0]['r.achk'], 'pattern')
  const sparse = (_ch0, ch1) => { for (let i = 0; i < 256; i += 64) ch1[i] += 1e-9 * ch1[i] / Math.abs(ch1[i]) }
  assert.equal((await listen(audioWin({ alter: sparse }).w, 50, true))[0]['r.achk'], 'pattern')
})

test('audio: the value is the exact sample bits, so a one-bit change in one sample changes it', async () => {
  const base = (await listen(audioWin().w))[0]['r.audio']
  const flip = (ch0) => { new Uint32Array(ch0.buffer)[4000] ^= 1 }
  const changed = (await listen(audioWin({ alter: flip }).w))[0]['r.audio']
  assert.match(changed, HEX16)
  assert.notEqual(changed, base)
})

test('audio: noise on every sample shows in the known-answer channel and is "!noise"', async () => {
  const noisy = (ch0, ch1) => { for (let i = 0; i < ch0.length; i++) { ch0[i] += 1e-7 * ((i % 5) - 2); ch1[i] += 1e-7 * ((i % 5) - 2) } }
  assert.deepEqual(await listen(audioWin({ alter: noisy }).w), [{ 'r.audio': '!noise', 'r.achk': 'pattern' }])
  const late = (_ch0, ch1) => { ch1[300] = 1e-9 }
  assert.deepEqual(await listen(audioWin({ alter: late }).w), [{ 'r.audio': '!noise', 'r.achk': 'pattern' }], 'the known channel must be silent after its 256 frames')
  const out = await listen(audioWin({ alter: noisy }).w, 50, true)
  assert.equal(out[0]['r.achk'], 'pattern')
})

test('audio: a copy that disagrees with the channel data is "!noise"; a browser without copyFromChannel skips that check', async () => {
  const out = await listen(audioWin({ copyDiffers: true }).w, 50, true)
  assert.equal(out[0]['r.audio'], '!noise')
  assert.equal(out[0]['r.achk'], 'copy')
  const plain = (await listen(audioWin().w))[0]['r.audio']
  assert.equal((await listen(audioWin({ noCopy: true }).w))[0]['r.audio'], plain)
})

test('audio: a silent fingerprint channel beside a correct known channel is our graph failing: "!err"; so is a NaN sample', async () => {
  const silent = await listen(audioWin({ silent: true }).w, 50, true)
  assert.equal(silent[0]['r.audio'], '!err')
  assert.equal(silent[0]['r.achk'], 'silent')
  assert.equal((await listen(audioWin({ nan: true }).w))[0]['r.audio'], '!err')
  const both = (_ch0, ch1) => ch1.fill(0)
  assert.equal((await listen(audioWin({ silent: true, alter: both }).w))[0]['r.audio'], '!noise')
})

test('audio: a render that never finishes is "!to" at the time limit, and a later completion is ignored', async () => {
  assert.deepEqual(await listen(audioWin({ hangs: true }).w, 30), [{ 'r.audio': '!to', 'r.achk': '!to' }])
  assert.deepEqual(await listen(audioWin({ hangs: true, legacy: true }).w, 30), [{ 'r.audio': '!to', 'r.achk': '!to' }])
  const slow = audioWin({ delay: 80 })
  const calls = await listen(slow.w, 20)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.deepEqual(calls, [{ 'r.audio': '!to', 'r.achk': '!to' }])
  assert.equal(slow.log.renders, 1)
})

test('audio: the time limit defaults to one second and runs from the call, before the context is built', async () => {
  const timers = []
  let atConstruct = null
  const fake = fakeAudio({ hangs: true, onConstruct: () => { atConstruct = timers.length } })
  audio({ OfflineAudioContext: fake.Context, setTimeout: (fn, ms) => timers.push(ms), clearTimeout() {} }, () => {})
  assert.deepEqual(timers, [1000])
  assert.equal(atConstruct, 1, 'the timer was already running when the context was constructed')
})

test('audio: a callback that throws does not escape, and a window without timers still answers', async () => {
  const a = audioWin()
  await new Promise((resolve) => {
    assert.doesNotThrow(() => audio(a.w, () => { setTimeout(resolve, 10); throw new Error('caller bug') }))
  })
  const fake = fakeAudio()
  const calls = await new Promise((resolve) => audio({ OfflineAudioContext: fake.Context }, (v) => resolve([v])))
  assert.match(calls[0]['r.audio'], HEX16)
})

test('audio: with diagnostics, the check is "ok" and the fingerprint channel\'s root mean square is given to 9 significant digits', async () => {
  const a = audioWin()
  const out = (await listen(a.w, 50, true))[0]
  assert.equal(out['r.achk'], 'ok')
  assert.ok(!('r.asum' in out))
  assert.match(String(out['r.arms']), /^0\.\d+$/)
  assert.equal(String(out['r.arms']).replace('0.', '').replace(/^0+/, '').length, 9)
  // the same channel the fake renders: 0.3 sin(...), halved on every seventh frame
  const seedOf = () => {
    const nodes = a.log.contexts[0].nodes
    const osc = nodes.find((n) => n.kind === 'oscillator')
    const shaper = nodes.find((n) => n.kind === 'shaper')
    return osc.frequency.value + osc.detune.value / 1000 + nodes.find((n) => n.kind === 'compressor').threshold.value / 100 + shaper.curve[200]
  }
  const ch0 = new Float32Array(5120)
  for (let i = 0; i < 5120; i++) ch0[i] = 0.3 * Math.sin(i * seedOf() / 977) * (i % 7 === 0 ? 0.5 : 1)
  let squares = 0
  for (let i = 0; i < 5120; i++) squares += ch0[i] * ch0[i]
  assert.equal(out['r.arms'], Math.sqrt(squares / 5120).toPrecision(9))
  assert.equal((await listen({ setTimeout, clearTimeout }, 50, true))[0]['r.achk'], '!na')
})

test('audio: a page that broke Math.sqrt loses only the diagnostic, not the value', async () => {
  const base = (await listen(audioWin().w, 50, true))[0]
  const saved = Math.sqrt
  let out
  try {
    Math.sqrt = () => { throw new Error('replaced') }
    out = (await listen(audioWin().w, 50, true))[0]
  } finally {
    Math.sqrt = saved
  }
  assert.equal(out['r.audio'], base['r.audio'])
  assert.equal(out['r.achk'], 'ok')
  assert.equal(out['r.arms'], '!err')
})

test('audio: the check that decided is given without diagnostics too; the root mean square only with them', async () => {
  const out = (await listen(audioWin().w))[0]
  assert.deepEqual(Object.keys(out).sort(), ['r.achk', 'r.audio'])
  assert.equal(out['r.achk'], 'ok')
  assert.deepEqual(await listen({ setTimeout, clearTimeout }), [{ 'r.audio': '!na', 'r.achk': '!na' }])
  assert.deepEqual(await listen(audioWin({ copyDiffers: true }).w), [{ 'r.audio': '!noise', 'r.achk': 'copy' }])
})
