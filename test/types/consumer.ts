// Compiled, never run: proves that the published types resolve through package.json "exports" and say what the README says.
import { get, getSync } from 'visitojs'
import { match, type Match, type Seen } from 'visitojs/match'
import { start, get as getLater, getSync as getLaterSync, type StartOptions } from 'visitojs/defer'
import { get as getDeep, DEEP_VERSION, type DeepReading } from 'visitojs/deep'

const now = getSync()
const did: string | null = now ? now.did : null
const strict: string | null = now ? now.idStrict : null
const weak: boolean = now ? now.flags.weak : false

get(function (reading) {
  // `v` is optional: readings stored before it was kept still type-check
  const earlier: Seen[] = [
    { did: null, os: 'android', osVer: '17', app: 'chrome', appVer: null, c: { 'hw.mem': '8' } },
    { v: 3, did: 'd', os: 'ios', osVer: null, app: 'safari', appVer: '27.2', c: { 'hw.mem': '!na' } },
  ]
  const result: Match = reading ? match(reading, earlier) : { result: 'unknown', rule: 'no reading', index: -1 }
  void [did, strict, weak, result]
})

// The reading's shape that 1.x keeps (docs/API.md, "What 1.x keeps"). Each field's type must stay exactly this: a type that
// narrows or widens fails here. A field added in a minor release goes into the table in docs/API.md and into READING_KEYS below.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Reading = NonNullable<ReturnType<typeof getSync>>
type Value = string | number | boolean
const READING_KEYS: Equal<keyof Reading, 'v' | 'did' | 'didNew' | 'didSrc' | 'id' | 'idStrict' | 'model' | 'os' | 'osVer' | 'app' | 'appVer' | 'engineVer' | 'flags' | 'c' | 'ms' | 't'> = true
const FLAG_KEYS: Equal<keyof Reading['flags'], 'partial' | 'auto' | 'private' | 'weak'> = true
const SHAPE: [
  Equal<Reading['v'], number>,
  Equal<Reading['did'], string | null>,
  Equal<Reading['didNew'], boolean>,
  Equal<Reading['didSrc'], string>,
  Equal<Reading['id'], string | null>,
  Equal<Reading['idStrict'], string | null>,
  Equal<Reading['model'], string | null>,
  Equal<Reading['os'], string>,
  Equal<Reading['osVer'], string | null>,
  Equal<Reading['app'], string>,
  Equal<Reading['appVer'], string | null>,
  Equal<Reading['engineVer'], number | null>,
  Equal<Reading['flags']['partial'], string[]>,
  Equal<Reading['flags']['auto'], string[]>,
  Equal<Reading['flags']['private'], boolean | null>,
  Equal<Reading['flags']['weak'], boolean>,
  Equal<Reading['c'], { [key: string]: Value }>,
  Equal<Reading['ms'], number>,
  Equal<Reading['t'], { [step: string]: number }>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]
// the same reading reaches get()'s callback, in the core and the deferred entry
get(function (reading) {
  const same: Equal<typeof reading, Reading | null> = true
  void same
})
getLater(function (reading) {
  const same: Equal<typeof reading, Reading | null> = true
  void same
})
void [READING_KEYS, FLAG_KEYS, SHAPE]

// the deferred entry: one more call, whose one option is a boolean
const options: StartOptions = { store: false }
start()
start(options)
start({ store: true })
// @ts-expect-error a string is not a boolean
start({ store: 'no' })
getLater(function (reading) {
  const later: string | null = reading ? reading.id : null
  const before: string | null = getLaterSync() ? null : 'not started'
  void [later, before]
})

// the deep entry: its own id and version; a null reading or a null id are both possible
getDeep(function (deep: DeepReading | null) {
  const version: number = deep ? deep.v : DEEP_VERSION
  const deepId: string | null = deep ? deep.id : null
  const noise: string[] = deep ? deep.flags.noise : []
  const check = deep ? deep.c['r.cchk'] : '!na'
  void [version, deepId, noise, check]
})
