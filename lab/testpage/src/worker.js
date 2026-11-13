// The phone test page's backend: serves the page behind a link token, stores what each visit reports, exports it to the owner.
const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' }
const MAX_BODY = 65536
// 400 days, the longest a browser keeps a cookie; no Domain attribute, so it stays on this one hostname
const SERVER_COOKIE = (value) => `_dzt_srv=${value}; Path=/; Max-Age=34560000; Secure; SameSite=Lax`
const TEST_COOKIES = ['_dzt', '_dzt_srv', '_dzt_js']

const notFound = () => new Response('Not found', { status: 404, headers: HEADERS })

function cookies(request) {
  const out = {}
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const at = part.indexOf('=')
    const name = part.slice(0, at).trim()
    if (at > 0 && TEST_COOKIES.includes(name)) out[name] = part.slice(at + 1).trim()
  }
  return out
}

async function asset(env, request, path, extra = {}) {
  const found = await env.ASSETS.fetch(new Request(new URL(path, request.url)))
  const headers = new Headers(found.headers)
  for (const [name, value] of Object.entries({ ...HEADERS, ...extra })) headers.set(name, value)
  return new Response(found.body, { status: found.status, headers })
}

async function store(env, request) {
  const text = await request.text()
  if (text.length > MAX_BODY) return new Response('Too large', { status: 413, headers: HEADERS })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return new Response('Bad request', { status: 400, headers: HEADERS })
  }
  if (!body || typeof body.rid !== 'string' || !/^[A-Za-z0-9]{12}$/.test(body.rid)) return new Response('Bad request', { status: 400, headers: HEADERS })
  // no address is kept: the reading, the cookies this test set, and the user agent are all the analysis needs
  const record = { at: new Date().toISOString(), ua: request.headers.get('user-agent') || '', cookies: cookies(request), body }
  await env.RESULTS.put(`r:${body.rid}`, JSON.stringify(record))
  return new Response(null, { status: 204, headers: HEADERS })
}

async function exportAll(env) {
  const records = []
  let cursor
  do {
    const page = await env.RESULTS.list({ prefix: 'r:', cursor })
    for (const { name } of page.keys) {
      const value = await env.RESULTS.get(name)
      if (value) records.push(JSON.parse(value))
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return new Response(JSON.stringify(records), { headers: { ...HEADERS, 'content-type': 'application/json' } })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const key = url.searchParams.get('k')
    if (request.method === 'GET' && url.pathname === '/visito.js') return asset(env, request, '/visito.js')
    if (request.method === 'GET' && url.pathname === '/' && key === env.LINK_TOKEN) {
      const returning = '_dzt_srv' in cookies(request)
      return asset(env, request, '/page.html', returning ? {} : { 'set-cookie': SERVER_COOKIE(`${crypto.randomUUID()}.${Date.now()}`) })
    }
    if (request.method === 'POST' && url.pathname === '/r' && key === env.LINK_TOKEN) return store(env, request)
    if (request.method === 'GET' && url.pathname === '/export' && key === env.ADMIN_TOKEN) return exportAll(env)
    return notFound()
  },
}
