// The lab build: the product build plus the candidate reads no id uses, read fresh on every page view. For test pages, not for shops.
import { open } from './api.js'
import { labStage } from './labstage.js'
import { inMemory } from './private.js'
import { hints, intl, textSize } from './probes.js'
import { audio, canvasSteps, math } from './render.js'

// the lab build also records which check fired and the alternative values, so readings can settle the open questions;
// the canvas read runs as steps, so no single task holds the page for the whole read
const api = open(
  { textSize: textSize, hints: hints, privateWindow: inMemory },
  labStage({
    intl: intl,
    math: math,
    canvasSteps: function (w) {
      return canvasSteps(w, true)
    },
    audio: function (w, done) {
      audio(w, done, undefined, true)
    },
  }),
)

export const getSync = api.getSync
export const get = api.get
