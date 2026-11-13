import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, NAVIGATION_MS, PageLoadError, stopOnPageLoad } from '../lab/launch.mjs'

test('a harness page load waits 90 s, not Playwright\'s default 30 s, and keeps the options it was given', async () => {
  assert.equal(NAVIGATION_MS, 90000)
  const calls = []
  const page = { goto: async (address, options) => calls.push([address, options]) }
  await loadPage(page, 'http://127.0.0.1:1/product', { waitUntil: 'load' })
  await loadPage(page, 'http://127.0.0.1:1/', { waitUntil: 'load', timeout: 5000 })
  assert.deepEqual(calls, [
    ['http://127.0.0.1:1/product', { waitUntil: 'load', timeout: 90000 }],
    ['http://127.0.0.1:1/', { waitUntil: 'load', timeout: 5000 }],
  ])
})

test('a page that does not load becomes a PageLoadError that names the page and the cause', async () => {
  const page = { goto: async () => { throw new Error('page.goto: Timeout 90000ms exceeded.\nCall log: ...') } }
  await assert.rejects(loadPage(page, 'http://127.0.0.1:1/product'), (error) => {
    assert.ok(error instanceof PageLoadError)
    assert.equal(error.message, 'the page http://127.0.0.1:1/product did not load: page.goto: Timeout 90000ms exceeded.')
    return true
  })
})

test('a run stopped by a page that did not load prints one FAIL line naming the page and exits 1; any other error is thrown on', () => {
  const lines = []
  const codes = []
  const out = { log: (line) => lines.push(line), exit: (code) => codes.push(code) }
  stopOnPageLoad(new PageLoadError('http://127.0.0.1:1/product', new Error('Timeout')), out)
  assert.deepEqual(lines, ['FAIL the page http://127.0.0.1:1/product did not load: Timeout'])
  assert.deepEqual(codes, [1])
  const other = new Error('a harness bug')
  assert.throws(() => stopOnPageLoad(other, out), (error) => error === other)
  assert.equal(lines.length, 1)
})
