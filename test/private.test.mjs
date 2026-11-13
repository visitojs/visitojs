import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inMemory } from '../build/esm/private.js'

const ENV = (engine) => ({ engine, android: false, safari17: false, firefox143: false, brave: false })
const settle = () => new Promise((resolve) => setImmediate(resolve))

// A DOMException-like rejection value. Its message is a getter that records any read, to prove the check never looks at it.
function failure(name, message = 'any text, in any language') {
  const seen = { message: 0 }
  const error = { name }
  Object.defineProperty(error, 'message', { get: () => { seen.message++; return message } })
  return { error, seen }
}

// A window with a file system that behaves as `outcome` says, and timers driven by the test.
// An insecure page has no storage manager at all, as measured in Chromium 153, Firefox 155 and WebKit 26.6 (docs/DECISIONS.md).
function browser(outcome, { secure = true, local = { length: 0 }, storage } = {}) {
  const calls = { getDirectory: 0, persist: 0, setItem: 0, clearTimeout: 0 }
  const timers = []
  const w = {
    isSecureContext: secure,
    localStorage: local,
    setTimeout: (fn, ms) => timers.push({ fn, ms, live: true }),
    clearTimeout: (id) => { calls.clearTimeout++; if (timers[id - 1]) timers[id - 1].live = false },
    navigator: {
      storage: storage !== undefined ? storage : !secure ? undefined : {
        getDirectory() {
          calls.getDirectory++
          return outcome()
        },
        persist() { calls.persist++ },
      },
    },
  }
  if (local && typeof local === 'object') local.setItem = () => { calls.setItem++ }
  return {
    w, calls, timers,
    fire: () => timers.forEach((t) => { if (t.live) { t.live = false; t.fn() } }),
  }
}

// Runs the check and collects every call to done, after the browser's promise had its turn.
async function run(b, engine, ms) {
  const answers = []
  inMemory(b.w, ENV(engine), (values) => answers.push(values), ms)
  await settle()
  return answers
}

const resolves = () => Promise.resolve({ kind: 'directory' })
const rejects = (name) => () => Promise.reject(failure(name).error)
const never = () => new Promise(() => {})

test('inMemory: Blink and unknown engines cannot be told, and the file system is never asked', async () => {
  for (const engine of ['blink', 'other']) {
    const b = browser(resolves)
    assert.deepEqual(await run(b, engine), [{ 'x.private': '!na' }])
    assert.equal(b.calls.getDirectory, 0)
  }
})

test('inMemory: no storage manager, no getDirectory, or an insecure page is "!na"', async () => {
  for (const engine of ['webkit', 'gecko']) {
    assert.deepEqual(await run(browser(resolves, { storage: null }), engine), [{ 'x.private': '!na' }])
    assert.deepEqual(await run(browser(resolves, { storage: {} }), engine), [{ 'x.private': '!na' }])
    assert.deepEqual(await run(browser(resolves, { storage: { getDirectory: 'not a function' } }), engine), [{ 'x.private': '!na' }])
    const insecure = browser(resolves, { secure: false })
    assert.deepEqual(await run(insecure, engine), [{ 'x.private': '!na' }])
    assert.equal(insecure.calls.getDirectory, 0)
  }
})

test('inMemory: a storage manager whose getter throws is "!err", and nothing escapes', async () => {
  for (const engine of ['webkit', 'gecko']) {
    const b = browser(resolves)
    Object.defineProperty(b.w.navigator, 'storage', { get: () => { throw new Error('getter') } })
    assert.deepEqual(await run(b, engine), [{ 'x.private': '!err' }])
  }
  const noNavigator = browser(resolves)
  delete noNavigator.w.navigator
  assert.deepEqual(await run(noNavigator, 'webkit'), [{ 'x.private': '!err' }])
})

test('inMemory: WebKit keeps storage when the file system opens and keeps none when it is refused as UnknownError', async () => {
  assert.deepEqual(await run(browser(resolves), 'webkit'), [{ 'x.private': false }])
  assert.deepEqual(await run(browser(rejects('UnknownError')), 'webkit'), [{ 'x.private': true }])
})

test('inMemory: in WebKit any other refusal (blocked storage, Gecko\'s name, a full disk) cannot be told', async () => {
  for (const name of ['TypeError', 'SecurityError', 'QuotaExceededError', 'NotAllowedError']) {
    assert.deepEqual(await run(browser(rejects(name)), 'webkit'), [{ 'x.private': '!na' }], name)
  }
})

test('inMemory: Gecko refusing the file system as SecurityError while localStorage is readable is an in-memory session', async () => {
  assert.deepEqual(await run(browser(rejects('SecurityError')), 'gecko'), [{ 'x.private': true }])
})

test('inMemory: in Gecko a file system that opens says nothing, because private windows are getting one', async () => {
  assert.deepEqual(await run(browser(resolves), 'gecko'), [{ 'x.private': '!na' }])
})

test('inMemory: in Gecko blocked storage refuses the same way, so a throwing or missing localStorage is "!na" and the file system is not asked', async () => {
  const throwing = browser(rejects('SecurityError'))
  Object.defineProperty(throwing.w, 'localStorage', { get: () => { throw new Error('SecurityError') } })
  assert.deepEqual(await run(throwing, 'gecko'), [{ 'x.private': '!na' }])
  assert.equal(throwing.calls.getDirectory, 0)
  const missing = browser(rejects('SecurityError'), { local: null })
  assert.deepEqual(await run(missing, 'gecko'), [{ 'x.private': '!na' }])
  assert.equal(missing.calls.getDirectory, 0)
})

test('inMemory: in WebKit too, a throwing or missing localStorage is "!na" and the file system is not asked', async () => {
  const throwing = browser(rejects('UnknownError'))
  Object.defineProperty(throwing.w, 'localStorage', { get: () => { throw new Error('SecurityError') } })
  assert.deepEqual(await run(throwing, 'webkit'), [{ 'x.private': '!na' }])
  assert.equal(throwing.calls.getDirectory, 0)
  const missing = browser(rejects('UnknownError'), { local: null })
  assert.deepEqual(await run(missing, 'webkit'), [{ 'x.private': '!na' }])
  assert.equal(missing.calls.getDirectory, 0)
})

test('inMemory: in an engine that cannot be told nothing on the window is read at all', async () => {
  for (const engine of ['blink', 'other']) {
    const reads = []
    const w = new Proxy({}, { get: (_target, key) => { reads.push(key); throw new Error('read') } })
    const answers = []
    inMemory(w, ENV(engine), (values) => answers.push(values))
    await settle()
    assert.deepEqual(answers, [{ 'x.private': '!na' }])
    assert.deepEqual(reads, [], engine)
  }
})

test('inMemory: in Gecko any other refusal, WebKit\'s name included, cannot be told', async () => {
  for (const name of ['UnknownError', 'TypeError', 'QuotaExceededError']) {
    assert.deepEqual(await run(browser(rejects(name)), 'gecko'), [{ 'x.private': '!na' }], name)
  }
})

test('inMemory: only the error name decides: two messages with one name give one answer, and the message is never read', async () => {
  for (const [engine, name] of [['webkit', 'UnknownError'], ['gecko', 'SecurityError'], ['webkit', 'TypeError']]) {
    const one = failure(name, 'first invented message')
    const two = failure(name, 'a second, different message')
    const a = await run(browser(() => Promise.reject(one.error)), engine)
    const b = await run(browser(() => Promise.reject(two.error)), engine)
    assert.deepEqual(a, b)
    assert.equal(one.seen.message + two.seen.message, 0)
  }
})

test('inMemory: a promise that never settles times out after the limit, 1,000 ms by default', async () => {
  const b = browser(never)
  const answers = await run(b, 'webkit')
  assert.deepEqual(answers, [])
  assert.equal(b.timers.length, 1)
  assert.equal(b.timers[0].ms, 1000)
  b.fire()
  assert.deepEqual(answers, [{ 'x.private': '!to' }])

  const short = browser(never)
  await run(short, 'gecko', 50)
  assert.equal(short.timers[0].ms, 50)
})

test('inMemory: a late answer after the timeout is ignored, and the timer left behind by an early answer cannot answer again', async () => {
  let late
  const b = browser(() => new Promise((_resolve, reject) => { late = reject }))
  const answers = await run(b, 'webkit')
  b.fire()
  late(failure('UnknownError').error)
  await settle()
  assert.deepEqual(answers, [{ 'x.private': '!to' }])

  const quick = browser(resolves)
  const first = await run(quick, 'webkit')
  // the timer is left to fire into nothing, so a page that broke clearTimeout cannot matter
  assert.equal(quick.calls.clearTimeout, 0, 'clearTimeout is never called')
  quick.fire()
  assert.deepEqual(first, [{ 'x.private': false }], 'a stray timer cannot answer twice')
})

test('inMemory: a throwing getDirectory, a value that is not a promise, or a rejection whose name cannot be read is "!err"', async () => {
  const unreadable = {}
  Object.defineProperty(unreadable, 'name', { get: () => { throw new Error('name') } })
  const cases = [
    () => { throw new Error('sync') },
    () => undefined,
    () => 42,
    () => ({ then: 'not a function' }),
    () => Promise.reject(unreadable),
    () => Promise.reject(null),
    () => Promise.reject(undefined),
  ]
  for (const engine of ['webkit', 'gecko']) {
    for (let i = 0; i < cases.length; i++) {
      const b = browser(cases[i])
      const answers = await run(b, engine)
      assert.deepEqual(answers, [{ 'x.private': '!err' }], `${engine} case ${i}`)
      b.fire()
      assert.deepEqual(answers, [{ 'x.private': '!err' }], `${engine} case ${i}: the timer left behind cannot answer again`)
    }
  }
})

test('inMemory: without a timer on the window it still answers once and never throws', async () => {
  const b = browser(rejects('UnknownError'))
  b.w.setTimeout = undefined
  const answers = await run(b, 'webkit')
  assert.equal(answers.length, 1)
  assert.equal(typeof answers[0]['x.private'] === 'boolean' || answers[0]['x.private'].charAt(0) === '!', true)
})

// Collects unhandled rejections while `body` runs, so a test can prove none came from the check.
async function rejectionsDuring(body) {
  const seen = []
  const listen = (reason) => seen.push(String(reason))
  process.on('unhandledRejection', listen)
  try {
    await body()
    // unhandled rejections are reported after the microtask queue drains
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', listen)
  }
  return seen
}

test('inMemory: a page that breaks clearTimeout or setTimeout after the script started still gets one answer, and nothing surfaces as an unhandled rejection', async () => {
  const broken = () => { throw new Error('page broke the timer') }
  const cases = [
    ['webkit', resolves, 'clearTimeout', false],
    ['webkit', rejects('UnknownError'), 'clearTimeout', true],
    ['gecko', rejects('SecurityError'), 'clearTimeout', true],
    ['gecko', resolves, 'clearTimeout', '!na'],
    ['webkit', rejects('UnknownError'), 'setTimeout', '!err'],
    ['gecko', rejects('SecurityError'), 'setTimeout', '!err'],
  ]
  for (const [engine, outcome, timer, expected] of cases) {
    const b = browser(outcome)
    b.w[timer] = broken
    let answers
    const rejections = await rejectionsDuring(async () => { answers = await run(b, engine) })
    assert.deepEqual(answers, [{ 'x.private': expected }], `${engine}, ${timer} broken`)
    assert.deepEqual(rejections, [], `${engine}, ${timer} broken`)
  }
})

test('inMemory: a callback that throws on the browser\'s answer does not surface as an unhandled rejection', async () => {
  for (const [engine, outcome] of [['webkit', resolves], ['webkit', rejects('UnknownError')], ['gecko', rejects('SecurityError')]]) {
    const b = browser(outcome)
    let calls = 0
    const rejections = await rejectionsDuring(async () => {
      inMemory(b.w, ENV(engine), () => { calls++; throw new Error('the caller broke') })
      await settle()
    })
    assert.equal(calls, 1, engine)
    assert.deepEqual(rejections, [], engine)
  }
})

test('inMemory: a page that breaks string and array built-ins while the answer is pending still gets the answer, and nothing is rejected', async () => {
  const broken = [[String.prototype, 'indexOf'], [String.prototype, 'charAt'], [Array.prototype, 'join']]
  for (const [engine, outcome, expected] of [['webkit', rejects('UnknownError'), true], ['webkit', resolves, false], ['gecko', rejects('SecurityError'), true]]) {
    const b = browser(outcome)
    const answers = []
    const rejections = await rejectionsDuring(async () => {
      const saved = broken.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name))
      inMemory(b.w, ENV(engine), (values) => { answers[answers.length] = values })
      broken.forEach(([target, name]) => Object.defineProperty(target, name, { configurable: true, writable: true, value: () => { throw new Error('fault') } }))
      try {
        await settle()
      } finally {
        broken.forEach(([target, name], i) => Object.defineProperty(target, name, saved[i]))
      }
    })
    assert.deepEqual(answers, [{ 'x.private': expected }], engine)
    assert.deepEqual(rejections, [], engine)
  }
})

test('inMemory: the directory handle is never touched, nothing is written and no permission is asked', async () => {
  const handle = new Proxy({}, { get: () => { throw new Error('the handle was touched') } })
  const b = browser(() => ({ then: (ok) => ok(handle) }))
  assert.deepEqual(await run(b, 'webkit'), [{ 'x.private': false }])
  for (const engine of ['webkit', 'gecko']) {
    const each = browser(rejects('SecurityError'))
    await run(each, engine)
    assert.equal(each.calls.persist, 0)
    assert.equal(each.calls.setItem, 0)
    assert.equal(each.calls.getDirectory, 1)
  }
})

test('inMemory: done is called exactly once in every case, and the check never throws', async () => {
  const outcomes = [resolves, rejects('UnknownError'), rejects('SecurityError'), rejects('TypeError'), never, () => { throw new Error('x') }, () => null]
  for (const engine of ['webkit', 'gecko', 'blink', 'other']) {
    for (const outcome of outcomes) {
      const b = browser(outcome)
      let count = 0
      assert.doesNotThrow(() => inMemory(b.w, ENV(engine), () => count++))
      await settle()
      b.fire()
      await settle()
      assert.equal(count, 1)
    }
  }
})
