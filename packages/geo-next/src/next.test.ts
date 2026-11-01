import { describe, expect, it, vi } from 'vitest'
import { fetchJsonLd, getClientIP, jsonLdScriptProps, markdownResponse, prefersMarkdown, withGeo } from './index.js'

const GPTBOT = 'Mozilla/5.0; compatible; GPTBot/1.2; +https://openai.com/gptbot'

function setup() {
  const pending: Promise<unknown>[] = []
  const event = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response('{}', { status: 200 }))
  return { pending, event, fetch }
}

describe('withGeo', () => {
  it('reports AI crawler page views to the ingest endpoint in the background', async () => {
    const { pending, event, fetch } = setup()
    const proxy = withGeo({ endpoint: '/api/geo/ingest', secret: 'abc', fetch: fetch as never })
    const req = new Request('https://site.test/blog/hello?x=1', {
      headers: { 'user-agent': GPTBOT, 'x-forwarded-for': '20.171.206.15, 10.0.0.1' },
    })
    proxy(req, event)
    await Promise.all(pending)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://site.test/api/geo/ingest')
    expect((init.headers as Record<string, string>)['x-geo-secret']).toBe('abc')
    expect(JSON.parse(init.body as string)).toMatchObject({ path: '/blog/hello?x=1', ip: '20.171.206.15', host: 'site.test' })
  })

  it('ignores humans, static assets and the ingest endpoint itself', () => {
    const { pending, event, fetch } = setup()
    const proxy = withGeo({ endpoint: 'https://site.test/api/geo/ingest', fetch: fetch as never })
    proxy(new Request('https://site.test/', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/130' } }), event)
    proxy(new Request('https://site.test/_next/static/a.js', { headers: { 'user-agent': GPTBOT } }), event)
    proxy(new Request('https://site.test/logo.png', { headers: { 'user-agent': GPTBOT } }), event)
    proxy(new Request('https://site.test/api/geo/ingest', { method: 'POST', headers: { 'user-agent': GPTBOT } }), event)
    expect(pending).toHaveLength(0)
  })

  it('never throws when reporting fails and still runs the wrapped handler', async () => {
    const { pending, event } = setup()
    const onError = vi.fn()
    const proxy = withGeo(
      { endpoint: '/api/geo/ingest', onError, fetch: (async () => { throw new Error('down') }) as never },
      () => 'next-response',
    )
    expect(proxy(new Request('https://site.test/', { headers: { 'user-agent': GPTBOT } }), event)).toBe('next-response')
    await Promise.all(pending)
    expect(onError).toHaveBeenCalledOnce()
  })
})

it('getClientIP falls back through common headers', () => {
  expect(getClientIP(new Headers({ 'x-real-ip': '1.1.1.1' }))).toBe('1.1.1.1')
  expect(getClientIP(new Headers())).toBeNull()
})

describe('llmsRoute', () => {
  it('serves the CMS file from the frontend domain', async () => {
    const fetch = vi.fn(async (url: URL) => new Response(`# Acme from ${url.host}\n`))
    const { llmsRoute } = await import('./index.js')
    const res = await llmsRoute({ source: 'https://cms.test/api/geo/llms.txt', fetch: fetch as never })(
      new Request('https://site.test/llms.txt'),
    )
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('# Acme from cms.test\n')
  })

  it('returns 502 when the CMS is down', async () => {
    const { llmsRoute } = await import('./index.js')
    const res = await llmsRoute({ source: '/api/geo/llms.txt', fetch: (async () => { throw new Error('x') }) as never })(
      new Request('https://site.test/llms.txt'),
    )
    expect(res.status).toBe(502)
  })
})

describe('markdown', () => {
  const cms = vi.fn(async (url: URL) =>
    url.searchParams.get('path') === '/blog/hello' ? new Response('# Hello\n') : new Response('Not found', { status: 404 }),
  )
  const options = { source: 'https://cms.test/api/geo/markdown', fetch: cms as never }

  it('serves /path.md from the CMS', async () => {
    const res = (await markdownResponse(new Request('https://site.test/blog/hello.md'), options))!
    expect(await res.text()).toBe('# Hello\n')
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('link')).toBe('<https://site.test/blog/hello>; rel="canonical"')
  })

  it('negotiates Accept: text/markdown on the normal URL', async () => {
    const res = (await markdownResponse(new Request('https://site.test/blog/hello', { headers: { accept: 'text/markdown, text/html;q=0.5' } }), options))!
    expect(res.headers.get('vary')).toBe('Accept')
    expect(await markdownResponse(new Request('https://site.test/blog/hello', { headers: { accept: 'text/html,*/*' } }), options)).toBeNull()
    expect(prefersMarkdown('text/html, text/markdown;q=0.9')).toBe(false)
    expect(prefersMarkdown('text/markdown')).toBe(true)
  })

  it('falls through to the app when the CMS has no such page', async () => {
    const { event } = setup()
    const handler = vi.fn(() => 'next')
    const proxy = withGeo({ endpoint: '/api/geo/ingest', markdown: options }, handler)
    expect(await proxy(new Request('https://site.test/docs/readme.md'), event)).toBe('next')
    const res = await proxy(new Request('https://site.test/blog/hello.md'), event)
    expect(res).toBeInstanceOf(Response)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('fetches JSON-LD and builds safe script props', async () => {
    const fetch = vi.fn(async (url: URL) => Response.json({ path: url.searchParams.get('path') }))
    expect(await fetchJsonLd({ source: 'https://cms.test/api/geo/jsonld', path: '/blog/hello', fetch: fetch as never })).toEqual({ path: '/blog/hello' })
    expect(jsonLdScriptProps({ a: '</script>' }).dangerouslySetInnerHTML.__html).toBe('{"a":"\\u003c/script>"}')
  })
})
