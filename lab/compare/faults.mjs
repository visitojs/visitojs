// The faults every library meets, applied the same way to each before any page script runs.
// The ones marked with VisitoJS's fault matrix break a property lab/fault-matrix.mjs also breaks, which VisitoJS was built to pass;
// the ones marked 'added' are on reads that matrix does not cover, chosen because other libraries depend on them, so the set
// is not drawn from one side alone.
// Each edit is [target expression, property, kind]. A target the engine lacks becomes a throwaway object, so the fault is a
// no-op there instead of an error in the harness. Every broken property counts the calls that reach it in window.__faultHits
// (in the top frame when a frame can reach it), so the table can say whether a library's code met the fault at all.
// apis: the property names the fault breaks; visitoProduct: whether dist/visito.min.js makes that read ('reads',
// 'not read', or the condition under which it does). test/compare.test.mjs checks the second against the built bundle.
// profile: 'reduced' runs the fault with the reduced user agent of the phone (lab/compare/contexts.mjs) instead of the phone's own.
const MATRIX = 'VisitoJS fault matrix'

// what each kind of edit installs; HIT is replaced with the call that counts the access
const KINDS = {
  'getter throws': 'get: function () { HIT; throw new Error("fault") }',
  'getter and setter throw': 'get: function () { HIT; throw new Error("fault") }, set: function () { HIT; throw new Error("fault") }',
  'method throws': 'value: function () { HIT; throw new Error("fault") }',
  'never settles': 'value: function () { HIT; return new Promise(function () {}) }',
  // reads as undefined, as a missing constructor does, and counts the read
  missing: 'get: function () { HIT; return undefined }',
}

const HE = 'getHighEntropyValues never settles'
const HE_EDITS = [['window.NavigatorUAData ? NavigatorUAData.prototype : {}', 'getHighEntropyValues', 'never settles']]

export const FAULTS = [
  { name: 'none (baseline)', origin: 'baseline', apis: [], edits: [] },
  { name: 'navigator.userAgent throws', origin: MATRIX, apis: ['userAgent'], visitoProduct: 'reads', edits: [['Navigator.prototype', 'userAgent', 'getter throws']] },
  { name: 'window.localStorage throws', origin: MATRIX, apis: ['localStorage'], visitoProduct: 'reads', edits: [['window', 'localStorage', 'getter throws']] },
  { name: 'document.cookie throws', origin: MATRIX, apis: ['cookie'], visitoProduct: 'reads', edits: [['Document.prototype', 'cookie', 'getter and setter throw']] },
  // src/stages.ts settle reads the screen size only when no model is known (flags.weak), as a stand-in for it
  { name: 'window.screen throws', origin: MATRIX, apis: ['screen'], visitoProduct: 'only when no model is known, and the phone profile\'s user agent names one', edits: [['window', 'screen', 'getter throws']] },
  { name: 'window.matchMedia throws', origin: MATRIX, apis: ['matchMedia'], visitoProduct: 'not read', edits: [['window', 'matchMedia', 'method throws']] },
  { name: 'Intl.DateTimeFormat throws', origin: MATRIX, apis: ['DateTimeFormat'], visitoProduct: 'not read', edits: [['Intl', 'DateTimeFormat', 'method throws']] },
  { name: 'canvas.getContext throws', origin: MATRIX, apis: ['getContext'], visitoProduct: 'not read', edits: [['HTMLCanvasElement.prototype', 'getContext', 'method throws']] },
  { name: 'window.OfflineAudioContext missing', origin: MATRIX, apis: ['OfflineAudioContext'], visitoProduct: 'not read', edits: [['window', 'OfflineAudioContext', 'missing'], ['window', 'webkitOfflineAudioContext', 'missing']] },
  { name: 'permissions.query never settles', origin: 'added', apis: ['permissions'], visitoProduct: 'not read', edits: [['window.Permissions ? Permissions.prototype : {}', 'query', 'never settles']] },
  // src/stages.ts asks for client hints only when src/ua.ts finds the model hidden ("K" and no model); the phone profile's user agent names it
  { name: HE, origin: MATRIX, apis: ['getHighEntropyValues'], visitoProduct: 'only when the user agent hides the model, which the phone profile\'s does not', edits: HE_EDITS },
  {
    name: 'WebGL getParameter throws',
    origin: 'added',
    apis: ['getParameter'],
    visitoProduct: 'not read',
    edits: [
      ['window.WebGLRenderingContext ? WebGLRenderingContext.prototype : {}', 'getParameter', 'method throws'],
      ['window.WebGL2RenderingContext ? WebGL2RenderingContext.prototype : {}', 'getParameter', 'method throws'],
    ],
  },
  { name: 'speechSynthesis.getVoices throws', origin: 'added', apis: ['getVoices'], visitoProduct: 'not read', edits: [['window.SpeechSynthesis ? SpeechSynthesis.prototype : {}', 'getVoices', 'method throws']] },
  {
    // element offsets and canvas text metrics, two ways a page measures text
    name: 'offsetWidth, offsetHeight and measureText throw',
    origin: 'added',
    apis: ['offsetWidth', 'offsetHeight', 'measureText'],
    visitoProduct: 'not read',
    edits: [
      ['HTMLElement.prototype', 'offsetWidth', 'getter throws'],
      ['HTMLElement.prototype', 'offsetHeight', 'getter throws'],
      ['window.CanvasRenderingContext2D ? CanvasRenderingContext2D.prototype : {}', 'measureText', 'method throws'],
    ],
  },
  // the text measurement of the VisitoJS product build (src/probes.ts textSize, part of id): computed style and the box of a text run
  { name: 'getBoundingClientRect throws', origin: MATRIX, apis: ['getBoundingClientRect'], visitoProduct: 'reads', edits: [['Element.prototype', 'getBoundingClientRect', 'method throws']] },
  { name: 'getComputedStyle throws', origin: MATRIX, apis: ['getComputedStyle'], visitoProduct: 'reads', edits: [['window', 'getComputedStyle', 'method throws']] },
  { name: 'window.sessionStorage throws', origin: MATRIX, apis: ['sessionStorage'], visitoProduct: 'only when localStorage is unavailable', edits: [['window', 'sessionStorage', 'getter throws']] },
  // with the user agent Chrome on Android sends when it hides the model, the one case where VisitoJS asks for client hints
  { name: 'none (baseline), reduced user agent', origin: 'baseline', profile: 'reduced', apis: [], edits: [] },
  { name: HE + ', reduced user agent', origin: MATRIX, profile: 'reduced', apis: ['getHighEntropyValues'], visitoProduct: 'reads', edits: HE_EDITS },
]

/** The init script that installs a fault's edits before the page's first script, each counting the calls that reach it. */
export function faultScript(edits) {
  const apply = edits
    .map(([target, prop, kind]) => {
      if (!(kind in KINDS)) throw new Error(`unknown kind of fault edit "${kind}"`)
      const descriptor = KINDS[kind].replace(/HIT/g, `hit(${JSON.stringify(prop)})`)
      return `try { Object.defineProperty(${target}, ${JSON.stringify(prop)}, { configurable: true, ${descriptor} }) } catch (e) { window.__faultErrors = (window.__faultErrors || []).concat(String(e)) }`
    })
    .join('\n')
  return `(function () {
if (!window.__faultHits) window.__faultHits = {}
function hit(name) {
  var into = window.__faultHits
  try { if (window.top && window.top !== window && window.top.__faultHits) into = window.top.__faultHits } catch (e) {}
  into[name] = (into[name] || 0) + 1
}
${apply}
})()`
}
