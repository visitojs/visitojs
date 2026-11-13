// Rendering reads: Math results, two canvas scenes and an offline audio render, each with its own checks for altered output.
// Built from the HTML, Web Audio and ECMAScript standards (sources in docs/DECISIONS.md). Each read stands alone for later entries.
import { ERR, NA, NOISE, Raw, TIMEOUT } from './guard.js'
import { short } from './hash.js'
import { Parts } from './reading.js'
import { Win } from './reads.js'

// ---- Math ----------------------------------------------------------------------------------------

// Literals, not Math.PI, so a page that replaced the constant cannot move every slot at once.
const HALF_PI = 1.5707963267948966
const PI = 3.141592653589793

// Arguments where maths libraries are known or likely to differ: near zero, near a pole, huge, tiny, extreme scales.
// Why each one is where it is: docs/DECISIONS.md, "Math arguments", in the rendering reads section.
const CALLS: any[][] = [
  ['cos', HALF_PI], ['sin', PI], ['tan', 1.5707963267948966], ['sin', 8.9e307], ['cos', -7.5e17], ['tan', 3e8],
  ['exp', 1], ['exp', -708.3], ['expm1', 1e-10], ['log1p', 1e-10], ['log', 7], ['log10', 7], ['log2', 10],
  ['pow', 1.0000001, 1e8], ['pow', 0.93, 7777.7], ['sinh', 0.0042], ['cosh', 10], ['tanh', 0.5],
  ['asinh', 0.5], ['acosh', 1e10], ['atanh', 0.97], ['cbrt', 3],
  ['atan2', 0.5, -0.7], ['atan', 2.5], ['asin', 0.3], ['acos', 0.3], ['hypot', 1, 1e-9], ['hypot', 3e-200, 4e-200],
]

function mathCall(entry: any[]): string {
  try {
    const m: any = Math
    if (typeof m[entry[0]] !== 'function') return NA
    const result = entry.length > 2 ? m[entry[0]](entry[1], entry[2]) : m[entry[0]](entry[1])
    // a replacement that returns something other than a number cannot be the library's answer
    return typeof result === 'number' ? String(result) : ERR
  } catch (e) {
    // a page replaced this one function: the slot says so and the others still count
    return ERR
  }
}

/** A digest of a fixed list of implementation-approximated Math results, or a status when no slot holds a number. Synchronous. */
export function math(): Parts {
  try {
    const out: string[] = []
    let numbers = 0
    let thrown = 0
    for (let i = 0; i < CALLS.length; i++) {
      const slot = mathCall(CALLS[i])
      if (slot === ERR) thrown++
      else if (slot !== NA) numbers++
      out.push(slot)
    }
    // a digest of statuses alone would look like a value and describe only the page
    if (!numbers) return { 'r.math': thrown ? ERR : NA }
    return { 'r.math': short('r.math:' + out.join(',')) }
  } catch (e) {
    return { 'r.math': ERR }
  }
}

// ---- Shared ------------------------------------------------------------------------------------

const CHUNK = 4096

/** 16 hex digits over raw bytes from `from` on, one character per byte so every byte reaches the digest unchanged. */
function digest(prefix: string, bytes: any, from?: number): string {
  let text = prefix
  for (let i = from || 0; i < bytes.length; i += CHUNK) {
    const end = i + CHUNK < bytes.length ? i + CHUNK : bytes.length
    const part = typeof bytes.subarray === 'function' ? bytes.subarray(i, end) : Array.prototype.slice.call(bytes, i, end)
    text += String.fromCharCode.apply(null, part)
  }
  return short(text)
}

/** Whether two arrays hold the same numbers from index `from` on. */
function same(a: any, b: any, from?: number): boolean {
  if (a.length !== b.length) return false
  for (let i = from || 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---- Canvas ----------------------------------------------------------------------------------

// Known cells: single opaque pixels at whole coordinates, so nothing is left for a rasteriser to round, each unlike all eight
// of its neighbours by 28 or more in some channel, so a protection that spares flat areas or pixels like their neighbours still
// reaches every cell. The pattern and the strips share no colour, so one colour-keyed draw that spares the pattern cannot
// spare a strip.
const CELL_COLOURS = 16
// every channel stays within 20 to 237, so an offset of a few units is never clamped away at 0 or 255
const level = function (n: number): number {
  return 20 + 7 * (n & 31)
}
/**
 * Pattern cell (x, y) of the 16 by 16: red steps five levels with x and green five with y, so all 256 cells differ and each
 * differs from every neighbour by 35 or more. A canvas that holds as many colours as it has pixels is spared by no threshold
 * of "few colours".
 */
function patternAt(x: number, y: number): number[] {
  return [level(5 * x + 1), level(5 * y + 2), level(3 * x + 7 * y + 5)]
}
/**
 * Strip cell (x, y) of drawing d: colour (x + 4y + 8d) mod 16 of a set of 16 the pattern does not use. Three odd multipliers
 * make each channel a permutation of the 32 levels. The two drawings of a scene take strips that differ at every cell, so an
 * alteration chosen from a canvas's contents lands differently in each and the pair check sees it.
 */
function stripAt(d: number, x: number, y: number): number[] {
  return stripColour((x + 4 * y + 8 * d) & 15)
}
function stripColour(c: number): number[] {
  const k = CELL_COLOURS + c
  return [level(5 * k + 11), level(11 * k + 3), level(29 * k + 21)]
}
// Each scene sits below a strip of known cells, drawn after the scene, so every read carries its own known answer.
const STRIP = 2
const GEOMETRY_W = 200
const GEOMETRY_H = 60
// The widest row (the serif line, 223 px in all three engines here) plus margins; three rows, the middle one tilted.
const TEXT_W = 236
const TEXT_H = 68
const TEXT = 'Hamburgefonstiv 0123 fi ffl AV To.'
const TILTED = 'Ty Wo Pa LT 47/89 (Qj) 1,056.3%'
// e with a combining acute, precomposed e acute, Greek, Arabic and three symbols, from code points so the bundle stays ASCII
// and the character encoding of the page that loads it cannot change the string
const MIXED = String.fromCharCode(0x65, 0x301, 0x20, 0xe9, 0x20, 0x3a9, 0x3bc, 0x3ad, 0x3b3, 0x3b1, 0x20,
  0x645, 0x631, 0x62d, 0x628, 0x627, 0x20, 0x2211, 0x221a, 0x221e)
const MARKS = 'Wq@&%'
const SERIF = '15.5px serif'
const SANS = '13px sans-serif'
const MIXED_FONT = '14px sans-serif'
const MONO = '18px monospace'
// Each row's font and string. A font's first use in a page costs tens of milliseconds on a slow machine, so each row is measured
// in a step of its own before the scene is drawn; the measurement is not used, it only does that first use early.
const ROWS: { [step: string]: string[] } = {
  'font-serif': [SERIF, TEXT],
  'font-sans': [SANS, TILTED],
  'font-mixed': [MIXED_FONT, MIXED],
  'font-mono': [MONO, MARKS],
}
const READBACK = { willReadFrequently: true }
// Thrown by a read the browser refused, so it can be told from our own failure.
const BLOCKED = { blocked: true }

/**
 * A detached 2D context of the given bitmap size, or null when the browser has none. Throws when the page broke the DOM. `noText`:
 * the canvas never holds text, so it gets no language.
 */
function board(doc: any, width: number, height: number, attributes?: any, noText?: boolean): any {
  const element = doc.createElement('canvas')
  if (typeof element.getContext !== 'function') return null
  // A detached canvas has no language, and Chromium then picks text fallback from its interface language; set before any context.
  // The content attribute, not the lang property, which a page can replace; read back, since text in a language the page chose
  // would describe the page.
  if (!noText) {
    element.setAttribute('lang', 'en')
    if (element.getAttribute('lang') !== 'en') throw new Error('lang')
  }
  element.width = width
  element.height = height
  return (attributes ? element.getContext('2d', attributes) : element.getContext('2d')) || null
}

/** Frees a canvas's bitmap once it has been read, so a page that keeps a reference to it holds no pixels. */
function release(ctx: any): void {
  try {
    const element = ctx.canvas
    element.width = 0
    element.height = 0
  } catch (e) {
    // the collector frees it later
  }
}

function pixels(ctx: any, width: number, height: number): any {
  let image: any
  try {
    image = ctx.getImageData(0, 0, width, height)
  } catch (e) {
    const error: any = e
    if (error && error.name === 'SecurityError') throw BLOCKED
    throw e
  }
  const data = image.data
  if (!data || data.length !== width * height * 4) throw new Error('size')
  return data
}

function setFill(ctx: any, rgb: number[]): void {
  ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'
}

/** Paints the strip of drawing `d` over rows 0 and 1, one colour at a time. The context must have no transform, shadow or blend. */
function paintStrip(ctx: any, d: number, width: number): void {
  for (let c = 0; c < CELL_COLOURS; c++) {
    setFill(ctx, stripColour(c))
    for (let y = 0; y < STRIP; y++) {
      // the cells of colour c in row y: x + 4y + 8d = c (mod 16)
      for (let x = (c - 4 * y - 8 * d) & 15; x < width; x += CELL_COLOURS) ctx.fillRect(x, y, 1, 1)
    }
  }
}

/** Whether the first `rows` rows of the bytes read back are exactly `at(x, y)` at full opacity. */
function cellsHold(data: any, width: number, rows: number, at: (x: number, y: number) => number[]): boolean {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const want = at(x, y)
      const byte = (y * width + x) * 4
      if (data[byte] !== want[0] || data[byte + 1] !== want[1] || data[byte + 2] !== want[2] || data[byte + 3] !== 255) return false
    }
  }
  return true
}

function patternHolds(ctx: any): boolean {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      setFill(ctx, patternAt(x, y))
      ctx.fillRect(x, y, 1, 1)
    }
  }
  return cellsHold(pixels(ctx, 16, 16), 16, 16, patternAt)
}

/** Font-free: gradients, translucency, curves, shadow blur, transforms, a blend mode, image scaling and dashes. */
function geometry(doc: any, ctx: any, noText?: boolean): void {
  const linear = ctx.createLinearGradient(0, 0, GEOMETRY_W, 0)
  linear.addColorStop(0, '#e8174b')
  linear.addColorStop(0.17, '#f5c518')
  linear.addColorStop(0.41, '#12b886')
  linear.addColorStop(0.66, '#3b5bdb')
  linear.addColorStop(1, '#ae3ec9')
  ctx.fillStyle = linear
  ctx.fillRect(0, 0, GEOMETRY_W, GEOMETRY_H)

  const radial = ctx.createRadialGradient(61.7, 27.3, 2.1, 61.7, 27.3, 23.6)
  radial.addColorStop(0, 'rgba(255,128,0,1)')
  radial.addColorStop(1, 'rgba(255,128,0,0.2)')
  ctx.fillStyle = radial
  ctx.beginPath()
  ctx.arc(61.7, 27.3, 23.6, 0, 2 * PI)
  ctx.fill()

  ctx.strokeStyle = 'rgb(20,30,120)'
  ctx.lineWidth = 2.5
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(103.4, 31.2, 17.7, 0.3, 4.1)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(118.9, 26.6, 13.3, 2.2, 5.9, true)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(8.3, 52.1)
  ctx.bezierCurveTo(40.7, 3.9, 77.2, 70.4, 140.6, 12.7)
  ctx.stroke()

  // a pentagram drawn point to every second point, so it crosses itself
  ctx.globalAlpha = 0.6
  ctx.fillStyle = 'rgb(40,200,90)'
  ctx.beginPath()
  ctx.moveTo(78, 8)
  ctx.lineTo(90.931, 47.798)
  ctx.lineTo(57.077, 23.202)
  ctx.lineTo(98.923, 23.202)
  ctx.lineTo(65.069, 47.798)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1

  // a rounded rectangle from arcs, which every engine has, with a blurred coloured shadow
  const x = 12.5, y = 6.5, wd = 34, ht = 18, r = 5
  ctx.shadowBlur = 6
  ctx.shadowColor = 'rgba(200,0,120,0.8)'
  ctx.shadowOffsetX = 3
  ctx.fillStyle = 'rgb(250,250,240)'
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + wd - r, y)
  ctx.arc(x + wd - r, y + r, r, -HALF_PI, 0)
  ctx.lineTo(x + wd, y + ht - r)
  ctx.arc(x + wd - r, y + ht - r, r, 0, HALF_PI)
  ctx.lineTo(x + r, y + ht)
  ctx.arc(x + r, y + ht - r, r, HALF_PI, PI)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, PI, PI + HALF_PI)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowColor = 'rgba(0,0,0,0)'

  ctx.save()
  ctx.translate(150.5, 44.2)
  ctx.rotate(0.37)
  ctx.scale(1.3, 0.7)
  ctx.fillStyle = 'rgb(90,10,160)'
  ctx.fillRect(-20, -2.5, 40, 5)
  ctx.restore()

  // soft-light takes a square root and branches on both colours, the most arithmetic of the separable blend modes; an engine
  // that ignores the mode keeps source-over and skips the shapes, so its value stays the same every time
  ctx.globalCompositeOperation = 'soft-light'
  if (ctx.globalCompositeOperation === 'soft-light') {
    ctx.fillStyle = 'rgba(30,200,170,0.75)'
    ctx.beginPath()
    ctx.moveTo(121.3, 57.2)
    ctx.lineTo(138.9, 33.4)
    ctx.lineTo(149.6, 55.8)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(240,90,20,0.65)'
    ctx.beginPath()
    ctx.moveTo(126.1, 38.7)
    ctx.lineTo(147.3, 42.9)
    ctx.lineTo(141.8, 58.6)
    ctx.lineTo(120.6, 54.4)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'

  const tiny = board(doc, 4, 4, undefined, noText)
  tiny.fillStyle = 'rgb(255,0,0)'
  tiny.fillRect(0, 0, 2, 2)
  tiny.fillStyle = 'rgb(0,255,0)'
  tiny.fillRect(2, 0, 2, 2)
  tiny.fillStyle = 'rgb(0,0,255)'
  tiny.fillRect(0, 2, 2, 2)
  tiny.fillStyle = 'rgb(255,255,0)'
  tiny.fillRect(2, 2, 2, 2)
  ctx.drawImage(tiny.canvas, 168.4, 30.2, 29, 29)
  release(tiny)

  if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([5, 2.5])
    ctx.lineDashOffset = 1.25
    ctx.lineWidth = 1.3
    ctx.strokeStyle = 'rgb(0,0,0)'
    ctx.beginPath()
    ctx.moveTo(4.5, 3.5)
    ctx.lineTo(196.2, 57.7)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

/** Generic families only: the OS's default faces and the user's font settings, kerning, ligatures, shaping and fallback. */
function text(ctx: any): void {
  // rows are placed by their top edge, so each row's band follows from its font size alone
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgb(25,25,40)'
  ctx.font = SERIF
  ctx.fillText(TEXT, 4.2, 3.3)

  // tilted off the pixel grid and filled with a gradient, so glyph coverage meets gradient arithmetic
  ctx.save()
  ctx.translate(4.6, 22.4)
  ctx.rotate(0.05)
  const run = ctx.createLinearGradient(0, 0, 200, 0)
  run.addColorStop(0, 'rgb(150,20,60)')
  run.addColorStop(1, 'rgb(20,110,170)')
  ctx.fillStyle = run
  ctx.font = SANS
  ctx.fillText(TILTED, 0, 0)
  ctx.restore()

  ctx.font = MIXED_FONT
  ctx.fillStyle = 'rgb(60,60,60)'
  ctx.fillText(MIXED, 4.1, 48.7)

  ctx.font = MONO
  ctx.lineWidth = 0.6
  ctx.strokeStyle = 'rgb(10,90,70)'
  ctx.strokeText(MARKS, 150.4, 46.5)
}

function canvasParts(cg: Raw, ct: Raw, check: Raw, cgcpu: Raw, ctcpu: Raw, diagnose?: boolean): Parts {
  // the check that decided is always given: it is the evidence a reading carries for its values
  const out: Parts = { 'r.cg': cg, 'r.ct': ct, 'r.cchk': check }
  if (diagnose) {
    out['r.cgcpu'] = cgcpu
    out['r.ctcpu'] = ctcpu
  }
  return out
}

/** A read cut into named pieces of work. `next` runs one and says whether any is left; `parts` is the result once none is. */
export interface Steps {
  names: string[]
  next: () => boolean
  parts: () => Parts
}

const CANVAS_STEPS = ['pattern', 'geometry', 'geometry2', 'font-serif', 'font-sans', 'font-mixed', 'font-mono', 'text', 'text2', 'hash-geometry', 'hash-text']
const DIAGNOSTIC_STEPS = ['cpu-geometry', 'hash-cpu-geometry', 'cpu-text', 'hash-cpu-text']

/**
 * The canvas read as steps, so a caller can give the page a turn between any two. Making the sequence does no work, and no step
 * throws. No canvas is read twice: a browser may change how a canvas is backed once it has been read (Chromium with a GPU draws
 * text differently afterwards), so each scene is drawn on two canvases, under different strips, that are read once each and
 * compared below the strips. Every read also
 * carries known cells (the pattern, or the strip above a scene), checked in the same bytes before anything is hashed, so an
 * alteration that is the same on every read still shows wherever it reaches those cells.
 */
export function canvasSteps(w: Win, diagnose?: boolean): Steps {
  const names = diagnose ? CANVAS_STEPS.concat(DIAGNOSTIC_STEPS) : CANVAS_STEPS.slice()
  let index = 0
  let doc: any = null
  let geometryPixels: any = null
  let textPixels: any = null
  let cpuPixels: any = null
  let measure: any = null
  let cg: Raw = TIMEOUT, ct: Raw = TIMEOUT, check: Raw = TIMEOUT, cgcpu: Raw = TIMEOUT, ctcpu: Raw = TIMEOUT

  // one status for every key, and nothing left to run: noise in one canvas is evidence about the browser, not about a scene
  const settle = function (status: Raw, which: Raw): void {
    cg = ct = cgcpu = ctcpu = status
    check = which
    index = names.length
    geometryPixels = textPixels = cpuPixels = null
    if (measure) release(measure)
    measure = null
  }
  // Drawing `d` (0 or 1) of a scene below its strip, read once; null when the strip did not come back as drawn. The strip is
  // painted last, with the context back in its initial state, so whatever the scene leaves behind cannot touch it.
  const scene = function (isText: boolean, d: number, attributes?: any): any {
    const width = isText ? TEXT_W : GEOMETRY_W
    const height = (isText ? TEXT_H : GEOMETRY_H) + STRIP
    const ctx = board(doc, width, height, attributes)
    ctx.save()
    ctx.translate(0, STRIP)
    if (isText) text(ctx)
    else geometry(doc, ctx)
    ctx.restore()
    paintStrip(ctx, d, width)
    const data = pixels(ctx, width, height)
    release(ctx)
    return cellsHold(data, width, STRIP, function (x: number, y: number) {
      return stripAt(d, x, y)
    }) ? data : null
  }
  // the first or second drawing of a scene; its strip is judged before the pair is compared, since a strip names the cause
  const drawing = function (isText: boolean, d: number): any {
    const data = scene(isText, d)
    if (!data) settle(NOISE, isText ? 'text-patch' : 'geometry-patch')
    return data
  }
  // the strips differ by design, so the pair is compared over the scene's own pixels only
  const pair = function (isText: boolean, first: any, second: any): void {
    if (second && !same(first, second, STRIP * (isText ? TEXT_W : GEOMETRY_W) * 4)) settle(NOISE, isText ? 'text' : 'geometry')
  }
  // the diagnostics never decide the main values: a failure there is recorded in its own key
  const diagnostic = function (isText: boolean): void {
    let status: Raw = NOISE
    try {
      cpuPixels = scene(isText, 0, READBACK)
    } catch (e) {
      cpuPixels = null
      if (e !== BLOCKED) status = ERR
    }
    if (cpuPixels) return
    if (isText) ctcpu = status
    else cgcpu = status
  }
  // a warm-up only: whatever happens here, the scene is drawn and judged the same way afterwards
  const warm = function (step: string): void {
    try {
      measure = measure || board(doc, 1, 1)
      measure.font = ROWS[step][0]
      measure.measureText(ROWS[step][1])
    } catch (e) {
      // a page that broke measureText makes the text step slower, nothing else
    }
    if (step === 'font-mono') {
      if (measure) release(measure)
      measure = null
    }
  }
  const hashDiagnostic = function (isText: boolean): void {
    if (!cpuPixels) return
    if (isText) ctcpu = digest('r.ctcpu:236x68:', cpuPixels, STRIP * TEXT_W * 4)
    else cgcpu = digest('r.cgcpu:200x60:', cpuPixels, STRIP * GEOMETRY_W * 4)
    cpuPixels = null
  }
  const work: { [name: string]: () => void } = {
    'pattern': function () {
      let pattern: any
      try {
        doc = w.document
        pattern = board(doc, 16, 16)
      } catch (e) {
        return settle(ERR, ERR)
      }
      if (!pattern) return settle(NA, NA)
      if (!patternHolds(pattern)) return settle(NOISE, 'pattern')
      release(pattern)
    },
    'geometry': function () {
      geometryPixels = drawing(false, 0)
    },
    'geometry2': function () {
      pair(false, geometryPixels, drawing(false, 1))
    },
    'font-serif': function () {
      warm('font-serif')
    },
    'font-sans': function () {
      warm('font-sans')
    },
    'font-mixed': function () {
      warm('font-mixed')
    },
    'font-mono': function () {
      warm('font-mono')
    },
    'text': function () {
      textPixels = drawing(true, 0)
    },
    'text2': function () {
      pair(true, textPixels, drawing(true, 1))
    },
    'hash-geometry': function () {
      cg = digest('r.cg:200x60:', geometryPixels, STRIP * GEOMETRY_W * 4)
      geometryPixels = null
    },
    'hash-text': function () {
      ct = digest('r.ct:236x68:', textPixels, STRIP * TEXT_W * 4)
      textPixels = null
      check = 'ok'
    },
    'cpu-geometry': function () {
      diagnostic(false)
    },
    'hash-cpu-geometry': function () {
      hashDiagnostic(false)
    },
    'cpu-text': function () {
      diagnostic(true)
    },
    'hash-cpu-text': function () {
      hashDiagnostic(true)
    },
  }

  return {
    names: names,
    next: function () {
      if (index >= names.length) return false
      const name = names[index++]
      try {
        work[name]()
      } catch (e) {
        // a refused read on our own untainted canvas is the browser withholding it on purpose, not a failure of ours
        if (e === BLOCKED) settle(NOISE, 'blocked')
        else settle(ERR, ERR)
      }
      return index < names.length
    },
    parts: function () {
      if (index < names.length) return canvasParts(TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT, diagnose)
      return canvasParts(cg, ct, check, cgcpu, ctcpu, diagnose)
    },
  }
}

const GEOMETRY_STEPS = ['pattern', 'geometry', 'geometry2', 'hash-geometry']

/**
 * The geometry scene alone as steps, for the deep entry: the pattern, two drawings of the scene under different strips, and the
 * digest. No text is drawn or measured and no canvas gets a language, so no font, interface language or text setting reaches the
 * value. The checks are those of `canvasSteps` for the geometry scene, with the same values and names. `parts` gives `r.cg` and
 * `r.cchk`. No step throws.
 */
export function geometrySteps(w: Win): Steps {
  let index = 0
  let doc: any = null
  let first: any = null
  let cg: Raw = TIMEOUT, check: Raw = TIMEOUT
  const settle = function (status: Raw, which: Raw): void {
    cg = status
    check = which
    index = GEOMETRY_STEPS.length
    first = null
  }
  // drawing `d` below its strip, read once and judged by the strip first, as in canvasSteps
  const drawing = function (d: number): any {
    const ctx = board(doc, GEOMETRY_W, GEOMETRY_H + STRIP, undefined, true)
    ctx.save()
    ctx.translate(0, STRIP)
    geometry(doc, ctx, true)
    ctx.restore()
    paintStrip(ctx, d, GEOMETRY_W)
    const data = pixels(ctx, GEOMETRY_W, GEOMETRY_H + STRIP)
    release(ctx)
    if (cellsHold(data, GEOMETRY_W, STRIP, function (x: number, y: number) { return stripAt(d, x, y) })) return data
    settle(NOISE, 'geometry-patch')
    return null
  }
  const work: { [name: string]: () => void } = {
    'pattern': function () {
      let pattern: any
      try {
        doc = w.document
        pattern = board(doc, 16, 16, undefined, true)
      } catch (e) {
        return settle(ERR, ERR)
      }
      if (!pattern) return settle(NA, NA)
      if (!patternHolds(pattern)) return settle(NOISE, 'pattern')
      release(pattern)
    },
    'geometry': function () {
      first = drawing(0)
    },
    'geometry2': function () {
      const second = drawing(1)
      if (second && !same(first, second, STRIP * GEOMETRY_W * 4)) settle(NOISE, 'geometry')
    },
    'hash-geometry': function () {
      cg = digest('r.cg:200x60:', first, STRIP * GEOMETRY_W * 4)
      first = null
      check = 'ok'
    },
  }
  return {
    names: GEOMETRY_STEPS.slice(),
    next: function () {
      if (index >= GEOMETRY_STEPS.length) return false
      try {
        work[GEOMETRY_STEPS[index++]]()
      } catch (e) {
        if (e === BLOCKED) settle(NOISE, 'blocked')
        else settle(ERR, ERR)
      }
      return index < GEOMETRY_STEPS.length
    },
    parts: function () {
      return index < GEOMETRY_STEPS.length ? { 'r.cg': TIMEOUT, 'r.cchk': TIMEOUT } : { 'r.cg': cg, 'r.cchk': check }
    },
  }
}

/**
 * `r.cg` (geometry) and `r.ct` (text), each 16 hex digits over the raw pixels, or one status for both, and the check that decided
 * (`r.cchk`), in one call. `diagnose` adds both scenes on canvases created for reading back (`r.cgcpu`, `r.ctcpu`).
 */
export function canvas(w: Win, diagnose?: boolean): Parts {
  const steps = canvasSteps(w, diagnose)
  while (steps.next()) {
    // each call runs one step
  }
  return steps.parts()
}

// ---- Audio -----------------------------------------------------------------------------------

const FRAMES = 5120
const RATE = 44100
const KNOWN = 256
const AUDIO_MS = 1000

/**
 * The known-answer buffer: odd 24-bit significands over every binary exponent from 2^-1 down to 2^-126, the smallest normal
 * single-precision number, alternating in sign. Each value is exact in single precision and uses its lowest bit, so an absolute
 * perturbation of any size above about 2^-150 changes the smallest of them, and a relative one above half a step changes them all.
 * Subnormals are left out because audio code commonly flushes them to zero.
 */
function knownValues(): Float32Array {
  const out = new Float32Array(KNOWN)
  // a 24-bit significand times 2^-(23 + e) lies in [2^-e, 2^(1-e))
  let scale = 1 / 16777216
  let exponent = 1
  for (let k = 0; k < KNOWN; k++) {
    const e = 1 + ((k * 126 / KNOWN) | 0)
    while (exponent < e) {
      scale /= 2
      exponent++
    }
    // a fixed odd multiplier spreads the significands, so neighbouring values do not share their low bits
    const m = 8388609 + 2 * ((k * 40503) % 4194304)
    out[k] = k % 2 ? m * scale : -m * scale
  }
  return out
}

/** A hump that folds back past its peak of about 0.9, from multiplications alone, so no maths library shapes the curve. */
function shaperCurve(): Float32Array {
  const curve = new Float32Array(257)
  for (let i = 0; i < 257; i++) {
    const x = (i - 128) / 128
    curve[i] = x * (1.95 - 1.365 * x * x)
  }
  return curve
}

function buildGraph(ctx: any, known: Float32Array): void {
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = 6000
  osc.detune.value = 7
  const shaper = ctx.createWaveShaper()
  shaper.curve = shaperCurve()
  shaper.oversample = '4x'
  const peak = ctx.createBiquadFilter()
  peak.type = 'peaking'
  peak.frequency.value = 3100
  peak.Q.value = 2.2
  peak.gain.value = 9
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -38
  comp.knee.value = 24
  comp.ratio.value = 9
  comp.attack.value = 0.002
  comp.release.value = 0.2
  const gain = ctx.createGain()
  gain.gain.value = 0.8
  // Mono into the merger, said outright: WebKit before late 2020 (the prefixed path, Safari 7 to 14.0) gives its compressor
  // a stereo output and builds the merger's output from every channel of its inputs, which would push the known buffer out of
  // the two channels rendered. The specification's engines already pass one channel here, so their samples do not change.
  gain.channelCount = 1
  gain.channelCountMode = 'explicit'
  const merger = ctx.createChannelMerger(2)

  const answers = ctx.createBuffer(1, KNOWN, RATE)
  const data = answers.getChannelData(0)
  for (let k = 0; k < KNOWN; k++) data[k] = known[k]
  const source = ctx.createBufferSource()
  source.buffer = answers

  osc.connect(shaper)
  shaper.connect(peak)
  peak.connect(comp)
  comp.connect(gain)
  gain.connect(merger, 0, 0)
  source.connect(merger, 0, 1)
  merger.connect(ctx.destination)
  osc.start(0)
  source.start(0)
}

/** The samples as bytes in little-endian order, written out explicitly so a server can recompute the digest from the numbers. */
function sampleBytes(samples: any): Uint8Array {
  const bytes = new Uint8Array(FRAMES * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < FRAMES; i++) view.setFloat32(i * 4, samples[i], true)
  return bytes
}

/** Root mean square of the fingerprint channel, to 9 significant digits: a lab diagnostic for how far apart two outputs are. */
function rms(samples: any): Raw {
  try {
    let squares = 0
    for (let i = 0; i < FRAMES; i++) squares += samples[i] * samples[i]
    return Math.sqrt(squares / FRAMES).toPrecision(9)
  } catch (e) {
    // a page that broke Math costs the diagnostic only
    return ERR
  }
}

/** [value, check, rms] for a rendered buffer: the known channel first, then sanity, then the copy path, then the digest. */
function judge(buffer: any, known: Float32Array): Raw[] {
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.getChannelData(1)
  if (!ch0 || !ch1 || ch0.length !== FRAMES || ch1.length !== FRAMES) return [ERR, ERR, ERR]
  for (let k = 0; k < FRAMES; k++) {
    if (ch1[k] !== (k < KNOWN ? known[k] : 0)) return [NOISE, 'pattern', NOISE]
  }
  let silent = true
  for (let i = 0; i < FRAMES; i++) {
    const s = ch0[i]
    if (s !== s || s === Infinity || s === -Infinity) return [ERR, 'nan', ERR]
    if (s !== 0) silent = false
  }
  if (silent) return [ERR, 'silent', ERR]
  if (typeof buffer.copyFromChannel === 'function') {
    const copy = new Float32Array(FRAMES)
    buffer.copyFromChannel(copy, 0)
    if (!same(copy, ch0)) return [NOISE, 'copy', NOISE]
  }
  return [digest('r.audio:5120@44100:', sampleBytes(ch0)), 'ok', rms(ch0)]
}

/**
 * `r.audio`: 16 hex digits over the exact samples of a short offline render, or a status. Calls `done` exactly once, at the
 * latest `ms` (default 1,000) after the call, with the check that decided (`r.achk`). No retry: a failed render is evidence. `diagnose` adds `r.arms`.
 */
export function audio(w: Win, done: (values: Parts) => void, ms?: number, diagnose?: boolean): void {
  let finished = false
  let timer: any = null
  let ctx: any = null
  const finish = function (result: Raw[]): void {
    if (finished) return
    finished = true
    try {
      if (timer !== null) w.clearTimeout(timer)
      if (ctx) ctx.oncomplete = null
    } catch (e) {
      // a timer that still fires finds the read settled
    }
    ctx = null
    const out: Parts = { 'r.audio': result[0], 'r.achk': result[1] }
    if (diagnose) out['r.arms'] = result[2]
    try {
      done(out)
    } catch (e) {
      // the caller's own fault must not surface as ours
    }
  }
  const fail = function (status: string): void {
    finish([status, status, status])
  }
  // the limit runs from the call, so building the graph counts against it too
  try {
    timer = w.setTimeout(function () {
      fail(TIMEOUT)
    }, ms || AUDIO_MS)
  } catch (e) {
    // no timer on this window: the render's own answer is the only way out
    timer = null
  }
  try {
    const Offline = w.OfflineAudioContext || w.webkitOfflineAudioContext
    if (!Offline) return fail(NA)
    ctx = new Offline(2, FRAMES, RATE)
    const known = knownValues()
    buildGraph(ctx, known)
    const rendered = function (buffer: any): void {
      if (finished) return
      try {
        finish(judge(buffer, known))
      } catch (e) {
        fail(ERR)
      }
    }
    ctx.oncomplete = function (event: any) {
      try {
        rendered(event.renderedBuffer)
      } catch (e) {
        fail(ERR)
      }
    }
    const started = ctx.startRendering()
    if (started && typeof started.then === 'function') {
      started.then(rendered, function () {
        fail(ERR)
      })
    }
  } catch (e) {
    fail(ERR)
  }
}

// ---- Digest self-test ---------------------------------------------------------------------------

// The known answer of digest() through both paths the reads take: clamped bytes from an offset, over more than one chunk, as a
// canvas gives them, then samples written out as bytes, as audio gives them, with the first digest as the second one's prefix. A
// page that replaced what the digest calls (fromCharCode, apply, subarray, the DataView writes) can change its answer without
// anything throwing, and a value made that way would describe the page, or be one constant for every machine.
const DIGEST_ANSWER = '5d644d10f895d8f6'

/** Whether digest() gives its known answer on this page now. Never throws. */
export function digestHolds(): boolean {
  try {
    const bytes = new Uint8ClampedArray(CHUNK + 40)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 151 + 7) & 255
    const known = knownValues()
    const samples = new Float32Array(FRAMES)
    for (let i = 0; i < FRAMES; i++) samples[i] = known[i & 255]
    return digest(digest('k:', bytes, 12), sampleBytes(samples)) === DIGEST_ANSWER
  } catch (e) {
    return false
  }
}
