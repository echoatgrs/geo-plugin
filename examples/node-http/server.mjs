// Headless GEO on a plain Node HTTP server. Run: CMS_URL=http://localhost:1337 GEO_SECRET=… node server.mjs
// Works with Strapi (CMS API at /api/geo/…) and Payload (same paths under its API route).
import { createServer } from 'node:http'
import { fetchJsonLd, geoFetchHandler, jsonLdScriptTag, revalidationHandler } from '@garus-ltd/geo-next'

const CMS = (process.env.CMS_URL ?? 'http://localhost:1337').replace(/\/+$/, '')
const PORT = Number(process.env.PORT ?? 3000)
const ORIGIN = process.env.SITE_URL ?? `http://localhost:${PORT}`

const geo = geoFetchHandler({
  endpoint: `${CMS}/api/geo/ingest`,
  secret: process.env.GEO_SECRET,
  // AI referral visits: only with the site's consent check (here: an analytics cookie).
  referrals: process.env.GEO_REFERRALS === '1' ? { endpoint: `${CMS}/api/geo/referrals`, consent: (req) => req.headers.get('cookie')?.includes('analytics=yes') ?? false } : undefined,
  llms: { source: `${CMS}/api/geo/llms.txt`, segments: `${CMS}/api/geo/llms` },
  markdown: { source: `${CMS}/api/geo/markdown` },
})

// Signed cache notices from the CMS (`invalidation.targets` → `${SITE_URL}/api/geo-revalidate`).
const pageCache = new Map()
const revalidate = process.env.GEO_REVALIDATE_SECRET
  ? revalidationHandler({
      secret: process.env.GEO_REVALIDATE_SECRET,
      onEvent(event) {
        for (const path of event.paths) pageCache.delete(path)
        console.log(`[geo] ${event.type} ${event.source}: dropped ${event.paths.join(', ')}`)
      },
    })
  : null

/** Node request → Fetch API Request. */
function toRequest(req) {
  const url = new URL(req.url ?? '/', ORIGIN)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  // Behind a proxy, keep X-Forwarded-For from it; locally, report the socket address.
  if (!headers.has('x-forwarded-for') && req.socket.remoteAddress) headers.set('x-forwarded-for', req.socket.remoteAddress)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url, { method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined })
}

/** Fetch API Response → Node response. */
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function page(path) {
  if (pageCache.has(path)) return pageCache.get(path)
  // JSON-LD from the CMS; null when the page is not a published, public entry.
  const jsonLd = await fetchJsonLd({ source: `${CMS}/api/geo/jsonld`, path }).catch(() => null)
  if (!jsonLd && path !== '/') return null
  const main = jsonLd?.['@graph']?.find?.((n) => n.headline || n.name)
  const title = main?.headline ?? main?.name ?? 'Example site'
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>${jsonLd ? jsonLdScriptTag(jsonLd) : ''}</head>
<body><h1>${escape(title)}</h1><p>Rendered by the plain Node example for <code>${escape(path)}</code>.</p></body></html>`
  pageCache.set(path, html)
  return html
}

createServer(async (req, res) => {
  try {
    const request = toRequest(req)
    const path = new URL(request.url).pathname
    if (path === '/api/geo-revalidate') return send(res, revalidate ? await revalidate(request) : new Response('not configured', { status: 404 }))
    const handled = await geo(request)
    if (handled) return send(res, handled)
    const html = await page(path)
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html ?? 'Not found')
  } catch (error) {
    console.error(error)
    res.writeHead(500).end('Internal error')
  }
}).listen(PORT, () => console.log(`Node GEO example on ${ORIGIN} (CMS ${CMS})`))
