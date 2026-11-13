import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../lab/testpage/src/worker.js'

function env() {
  const store = new Map()
  return {
    store,
    LINK_TOKEN: 'link-token',
    ADMIN_TOKEN: 'admin-token',
    ASSETS: { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' } }) },
    RESULTS: {
      put: async (key, value) => void store.set(key, value),
      get: async (key) => store.get(key) ?? null,
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    },
  }
}
const call = (e, path, init) => worker.fetch(new Request(`https://check.example${path}`, init), e)
const post = (e, body, headers = {}) => call(e, '/r?k=link-token', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

test('the page needs the link token; everything is uncacheable and unindexed', async () => {
  const e = env()
  assert.equal((await call(e, '/')).status, 404)
  assert.equal((await call(e, '/?k=wrong')).status, 404)
  assert.equal((await call(e, '/page.html')).status, 404, 'the page file is not reachable around the token')
  const ok = await call(e, '/?k=link-token')
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'asset /page.html')
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.match(ok.headers.get('x-robots-tag'), /noindex/)
})

test('the first visit gets a server-set, host-only cookie; a returning visit keeps the one it has', async () => {
  const e = env()
  const first = await call(e, '/?k=link-token')
  const cookie = first.headers.get('set-cookie')
  assert.match(cookie, /^_dzt_srv=[0-9a-f-]{36}\.\d+; Path=\/; Max-Age=34560000; Secure; SameSite=Lax$/)
  assert.doesNotMatch(cookie, /Domain=/i)
  const again = await call(e, '/?k=link-token', { headers: { cookie: `theme=dark; ${cookie.split(';')[0]}` } })
  assert.equal(again.headers.get('set-cookie'), null)
})

test('the library file is served without a token and without caching', async () => {
  const response = await call(env(), '/visito.js')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('a result is stored under its visit id with the cookies and user agent the server saw, and no address', async () => {
  const e = env()
  const response = await post(e, { rid: 'abc123DEF456', phone: null, reading: { id: 'x' } }, { cookie: '_dzt_srv=s.1; _dzt_js=j.2; other=1', 'user-agent': 'TestUA/1', 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(response.status, 204)
  const [[key, value]] = [...e.store]
  assert.match(key, /^r:abc123DEF456$/)
  const record = JSON.parse(value)
  assert.deepEqual(record.cookies, { _dzt_srv: 's.1', _dzt_js: 'j.2' })
  assert.equal(record.ua, 'TestUA/1')
  assert.deepEqual(record.body.reading, { id: 'x' })
  assert.match(record.at, /^\d{4}-\d\d-\d\dT/)
  assert.doesNotMatch(value, /203\.0\.113\.9/)
})

test('a second post for the same visit replaces the first (the phone number arrives later)', async () => {
  const e = env()
  await post(e, { rid: 'abc123DEF456', phone: null })
  await post(e, { rid: 'abc123DEF456', phone: 3 })
  assert.equal(e.store.size, 1)
  assert.equal(JSON.parse([...e.store.values()][0]).body.phone, 3)
})

test('bad posts are refused: wrong token, no visit id, not JSON, too large', async () => {
  const e = env()
  assert.equal((await call(e, '/r?k=nope', { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await post(e, { phone: 1 })).status, 400)
  assert.equal((await post(e, { rid: '../../etc' })).status, 400)
  assert.equal((await call(e, '/r?k=link-token', { method: 'POST', body: '{not json' })).status, 400)
  assert.equal((await post(e, { rid: 'abc123DEF456', pad: 'x'.repeat(70000) })).status, 413)
  assert.equal(e.store.size, 0)
})

test('the export needs the admin token and returns every stored result', async () => {
  const e = env()
  await post(e, { rid: 'aaaaaaaaaaaa', phone: 1 })
  await post(e, { rid: 'bbbbbbbbbbbb', phone: 2 })
  assert.equal((await call(e, '/export?k=link-token')).status, 404)
  const response = await call(e, '/export?k=admin-token')
  assert.equal(response.status, 200)
  const records = await response.json()
  assert.deepEqual(records.map((r) => r.body.phone).sort(), [1, 2])
})

test('anything else is a plain 404', async () => {
  assert.equal((await call(env(), '/wp-login.php')).status, 404)
  assert.equal((await call(env(), '/r?k=link-token')).status, 404)
})
