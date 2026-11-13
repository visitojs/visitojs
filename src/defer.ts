// The deferred build: the product build, started by the page. Loading it reads nothing and stores nothing.
import { deferred } from './api.js'
import { inMemory } from './private.js'
import { hints, textSize } from './probes.js'

export type { StartOptions } from './api.js'

const api = deferred({ textSize: textSize, hints: hints, privateWindow: inMemory })

/** Starts the session once: the stored id now, the ids once the page has parsed. `{ store: false }` reads and writes no cookie and no storage. Later calls are ignored, whatever their options. Never throws. */
export const start = api.start

/** null until start(); then the reading as it stands now, or null. Never throws. */
export const getSync = api.getSync

/** Calls back once, never before returning, with the finished reading or null; before start() it waits for start(). Never throws. */
export const get = api.get
