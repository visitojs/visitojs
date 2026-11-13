// The lab build's extra stage: every candidate read that no id uses. Canvas reached 64 ms on a flagship phone, so shops never run these.
import { BOT_KEYS, botMarks } from './botlab.js'
import { featureMarks } from './env.js'
import { Parts } from './reading.js'
import { syncReads, Win } from './reads.js'
import type { Steps } from './render.js'
import { whenSettled } from './settle.js'
import { Stage, Task } from './stages.js'

const CANVAS_KEYS = ['r.cg', 'r.ct']

export interface LabProbes {
  intl: (w: Win) => Parts
  math: () => Parts
  canvas?: (w: Win) => Parts
  /** The canvas read as steps. When given it replaces `canvas`, and each step is a task of its own, so the page gets a turn between any two. */
  canvasSteps?: (w: Win) => Steps
  audio: (w: Win, done: (values: Parts) => void) => void
}

/** One task per step; the last one answers with the values, and the keys it names are what a cut-off read records as timed out. */
function stepTasks(steps: Steps): Task[] {
  const out: Task[] = []
  const step = function (i: number): Task {
    const last = i === steps.names.length - 1
    return {
      name: 'canvas:' + steps.names[i],
      keys: last ? CANVAS_KEYS : [],
      run: function (answer) {
        steps.next()
        answer(last ? steps.parts() : {})
      },
    }
  }
  for (let i = 0; i < steps.names.length; i++) out.push(step(i))
  return out
}

/** Runs at an idle moment after load, or after 3 seconds without load, and never while the page is hidden. */
export function labStage(p: LabProbes): Stage {
  const sync = function (name: string, keys: string[], read: () => Parts): Task {
    return { name: name, keys: keys, run: function (answer) { answer(read()) } }
  }
  const canvasTasks = function (w: Win): Task[] {
    const single = p.canvas
    if (!p.canvasSteps) return single ? [sync('canvas', CANVAS_KEYS, function () { return single(w) })] : []
    try {
      // making the sequence does no work: the steps run only when the stage does
      return stepTasks(p.canvasSteps(w))
    } catch (e) {
      return [{ name: 'canvas', keys: CANVAS_KEYS, run: function () { throw e } }]
    }
  }
  return {
    tasks: function (w) {
      return [
        sync('sync', [], function () { return syncReads(w) }),
        sync('engine', ['x.ev.blink', 'x.ev.webkit', 'x.ev.gecko', 'x.ev.android', 'x.ev.safari17', 'x.ev.firefox143', 'x.ev.brave'], function () { return featureMarks(w) }),
        sync('intl', ['x.tz', 'x.loc', 'x.cal', 'x.num', 'x.hc'], function () { return p.intl(w) }),
        sync('math', ['r.math'], function () { return p.math() }),
        sync('bot', BOT_KEYS, function () { return botMarks(w) }),
      ].concat(canvasTasks(w), [{ name: 'audio', keys: ['r.audio'], run: function (answer) { p.audio(w, answer) } }])
    },
    wait: whenSettled,
  }
}
