// Pretend canvas and offline audio contexts for the rendering reads, shared by the unit tests of the lab reads and the deep entry.

const rgb = (s) => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(s))
  return m ? [+m[1], +m[2], +m[3], 255] : null
}
export const fnv = (s) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return h
}

/**
 * A pretend 2D canvas: a whole-pixel opaque fillRect with no transform, shadow or blend mode paints exactly; every other
 * drawing call is logged and mixed into every pixel not painted exactly since, so the same drawing gives the same bytes.
 * `alter` lets a test play a browser that adds noise. Each element remembers the size it was read at and what the browser
 * gave before any alteration, since the read releases the canvas afterwards.
 */
export function fakeDocument(options = {}) {
  const made = []
  const measured = []
  const document = {
    createElement(tag) {
      if (options.createThrows) throw new Error('no elements here')
      const element = { tag, width: 300, height: 150, reads: 0, readSize: null, read: null, contextArgs: null, ops: [], index: made.length, ctx: null }
      // content attributes, as the DOM keeps them: strings, and null for one never set
      const attributes = {}
      element.setAttribute = (name, value) => void (attributes[name] = String(value))
      element.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null)
      element.getContext = options.getContext || function (type, attributes) {
        element.contextArgs = [type, attributes]
        if (options.noContext) return null
        element.ctx = element.ctx || context(element)
        return element.ctx
      }
      made.push(element)
      return element
    },
    appendChild() { throw new Error('a canvas must never be attached') },
    body: { appendChild() { throw new Error('a canvas must never be attached') } },
  }
  const context = (element) => {
    let pixels = null
    // which pixels a whole-pixel fill has painted since the last drawing call that may have touched any pixel
    let exact = null
    const ensure = () => {
      if (!pixels || pixels.length !== element.width * element.height * 4) {
        pixels = new Uint8ClampedArray(element.width * element.height * 4)
        exact = new Uint8Array(element.width * element.height)
      }
    }
    let transformed = false
    const stack = []
    const STATE = ['fillStyle', 'strokeStyle', 'globalAlpha', 'font', 'textBaseline', 'lineWidth', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY']
    const log = (name) => function (...args) {
      if (options.throwOn === name) throw new Error(name + ' failed')
      const state = name === 'fillText' || name === 'strokeText' ? [ctx.textBaseline, ctx.font, options.fontSalt || ''] : []
      const style = ctx.fillStyle && ctx.fillStyle.id ? ctx.fillStyle.id : ctx.fillStyle
      element.ops.push(JSON.stringify([name, args.map((a) => (a && typeof a === 'object' ? a.id || 'obj' : a)), style, ctx.globalAlpha, ctx.globalCompositeOperation, ...state]))
      ensure()
      exact.fill(0)
      if (name === 'translate' || name === 'rotate' || name === 'scale' || name === 'setTransform') transformed = true
      if (name === 'save') stack.push([transformed, composite, STATE.map((k) => ctx[k])])
      if (name === 'restore' && stack.length) {
        const [t, c, values] = stack.pop()
        transformed = t
        composite = c
        STATE.forEach((k, i) => { ctx[k] = values[i] })
      }
    }
    const gradient = (kind) => function (...args) {
      log(kind).apply(null, args)
      const stops = []
      return { id: kind + element.ops.length, addColorStop: (o, c) => stops.push([o, c]) }
    }
    let composite = 'source-over'
    const ctx = {
      canvas: element,
      fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, font: '10px sans-serif',
      lineWidth: 1, shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, lineDashOffset: 0,
      imageSmoothingEnabled: true, textBaseline: 'alphabetic',
      get globalCompositeOperation() { return composite },
      // the HTML Standard: a value the context does not support is ignored
      set globalCompositeOperation(v) { if (v !== options.unsupportedMode) composite = v },
      fillRect(x, y, w, h) {
        if (options.throwOn === 'fillRect') throw new Error('fillRect failed')
        ensure()
        const colour = rgb(ctx.fillStyle)
        const plain = !transformed && composite === 'source-over' && (!ctx.shadowBlur || /,\s*0\)$/.test(ctx.shadowColor))
        const whole = [x, y, w, h].every(Number.isInteger) && ctx.globalAlpha === 1 && plain
        if (colour && whole) {
          for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
              pixels.set(colour, (py * element.width + px) * 4)
              exact[py * element.width + px] = 1
            }
          }
        } else log('fillRect')(x, y, w, h)
      },
      getImageData(x, y, w, h) {
        if (options.readThrows) throw options.readThrows
        ensure()
        const data = new Uint8ClampedArray(pixels)
        if (element.ops.length) {
          const seed = fnv(element.ops.join('|'))
          // a byte of its own for every position, so a drawn scene holds thousands of colours as a real one does
          for (let i = 0; i < data.length; i++) if (!exact[i >> 2]) data[i] = data[i] ^ ((Math.imul(seed ^ i, 2654435761) >>> 13) & 0xff)
        }
        element.reads++
        element.readSize = [element.width, element.height]
        element.read = new Uint8ClampedArray(data)
        if (options.alter) options.alter(data, element, element.reads)
        return { data, width: w, height: h }
      },
    }
    for (const name of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'bezierCurveTo', 'quadraticCurveTo', 'fill', 'stroke', 'save', 'restore',
      'translate', 'rotate', 'scale', 'setTransform', 'drawImage', 'setLineDash', 'fillText', 'strokeText', 'rect']) ctx[name] = log(name)
    ctx.measureText = function (text) {
      if (options.measureThrows) throw new Error('measureText failed')
      measured.push([ctx.font, text])
      return { width: text.length * 7 }
    }
    ctx.createLinearGradient = gradient('linear')
    ctx.createRadialGradient = gradient('radial')
    return ctx
  }
  return { document, made, measured }
}

const param = (value) => ({ value })

/**
 * A pretend offline audio context. Channel 0 is a deterministic function of the graph's settings; channel 1 is whatever buffer
 * the source plays into the merger's second input, as the specification says a faithful renderer gives.
 */
export function fakeAudio(options = {}) {
  const log = { constructed: [], contexts: [], renders: 0 }
  function Context(channels, length, rate) {
    if (options.onConstruct) options.onConstruct()
    if (options.constructThrows) throw new Error('cannot construct')
    log.constructed.push([channels, length, rate])
    log.contexts.push(this)
    this.length = length
    this.sampleRate = rate
    this.destination = { name: 'destination' }
    this.nodes = []
  }
  const node = (ctx, kind, extra) => {
    const n = { kind, links: [], started: null, connect(target, output, input) { n.links.push([target, output || 0, input || 0, n.channelCount, n.channelCountMode]); return target }, start(at) { n.started = at }, ...extra }
    ctx.nodes.push(n)
    return n
  }
  Context.prototype.createOscillator = function () { return node(this, 'oscillator', { type: 'sine', frequency: param(440), detune: param(0) }) }
  Context.prototype.createWaveShaper = function () { return node(this, 'shaper', { curve: null, oversample: 'none' }) }
  Context.prototype.createBiquadFilter = function () { return node(this, 'biquad', { type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }) }
  Context.prototype.createDynamicsCompressor = function () {
    return node(this, 'compressor', { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) })
  }
  // the specification's defaults: two channels, "max"
  Context.prototype.createGain = function () { return node(this, 'gain', { gain: param(1), channelCount: 2, channelCountMode: 'max' }) }
  Context.prototype.createBufferSource = function () { return node(this, 'source', { buffer: null }) }
  Context.prototype.createChannelMerger = function (inputs) { return node(this, 'merger', { inputs }) }
  Context.prototype.createBuffer = function (channels, length, rate) { return buffer(channels, length, rate) }
  const buffer = (channels, length, rate) => {
    const data = []
    for (let c = 0; c < channels; c++) data.push(new Float32Array(length))
    const b = { numberOfChannels: channels, length, sampleRate: rate, getChannelData: (c) => data[c] }
    if (!options.noCopy) b.copyFromChannel = (dest, c) => { dest.set(data[c].subarray(0, dest.length)); if (options.copyDiffers) dest[3] += 0.001 }
    return b
  }
  const render = (ctx) => {
    log.renders++
    const out = buffer(2, ctx.length, ctx.sampleRate)
    const osc = ctx.nodes.find((n) => n.kind === 'oscillator')
    const shaper = ctx.nodes.find((n) => n.kind === 'shaper')
    const comp = ctx.nodes.find((n) => n.kind === 'compressor')
    const source = ctx.nodes.find((n) => n.kind === 'source')
    const seed = osc.frequency.value + osc.detune.value / 1000 + comp.threshold.value / 100 + (shaper.curve ? shaper.curve[200] : 0)
    const ch0 = out.getChannelData(0)
    if (!options.silent) for (let i = 0; i < ch0.length; i++) ch0[i] = 0.3 * Math.sin(i * seed / 977) * (i % 7 === 0 ? 0.5 : 1)
    if (options.nan) ch0[100] = NaN
    const ch1 = out.getChannelData(1)
    // WebKit before September 2020: the compressor's output is stereo, a gain node passes on the channel count of its input
    // unless it is explicit, and the merger's output is every channel of its inputs one after another, so the two-channel
    // destination keeps input 0's two channels and drops the known buffer
    const gain = ctx.nodes.find((n) => n.kind === 'gain')
    const gainChannels = gain.channelCountMode === 'explicit' ? gain.channelCount : 2
    if (options.oldMerger && gainChannels > 1) ch1.set(ch0)
    else if (source && source.buffer) ch1.set(source.buffer.getChannelData(0).subarray(0, ch1.length))
    if (options.alter) options.alter(ch0, ch1)
    return out
  }
  Context.prototype.startRendering = function () {
    const ctx = this
    if (options.startThrows) throw new Error('cannot render')
    if (options.rejects) return Promise.reject(new Error('render failed'))
    if (options.hangs) return options.legacy ? undefined : new Promise(() => {})
    const delay = options.delay || 0
    const rendered = new Promise((resolve) => setTimeout(() => resolve(render(ctx)), delay))
    rendered.then((b) => {
      // a browser may deliver both the event and the promise; an old one only the event
      if (!options.noEvent && typeof ctx.oncomplete === 'function') ctx.oncomplete({ renderedBuffer: b })
      if (options.twice && typeof ctx.oncomplete === 'function') ctx.oncomplete({ renderedBuffer: b })
    })
    return options.legacy ? undefined : rendered
  }
  return { Context, log }
}
