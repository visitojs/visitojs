import { open } from './api.js'
import { inMemory } from './private.js'
import { hints, textSize } from './probes.js'

const api = open({ textSize: textSize, hints: hints, privateWindow: inMemory })

/** The reading as it stands now (the stored id from script start, the ids once the page has parsed), or null. Never throws. */
export const getSync = api.getSync

/** Calls back once, never before returning, with the finished reading or null. Never throws. */
export const get = api.get
