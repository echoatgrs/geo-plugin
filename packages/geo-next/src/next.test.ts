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

  it('does not answer its own fetch of a same-app CMS endpoint', async () => {
    const { event } = setup()
    const handler = vi.fn(() => 'next')
    let calls = 0
    // The CMS lives in the same app, so the proxy sees its own Markdown fetch, with Accept: text/markdown.
    const proxy = withGeo(
      {
        endpoint: '/api/geo/ingest',
        markdown: {
          source: '/api/geo/markdown',
          fetch: (async (url: URL, init: RequestInit) => {
            if (++calls > 5) throw new Error('loop')
            const inner = await proxy(new Request(url, { headers: init.headers }), event)
            return inner instanceof Response ? inner : new Response(`# from CMS ${url.searchParams.get('path')}\n`)
          }) as never,
        },
      },
      handler,
    )
    const res = await proxy(new Request('https://site.test/blog/hello.md'), event)
    expect(await (res as Response).text()).toBe('# from CMS /blog/hello\n')
    expect(calls).toBe(1)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('resolves a relative JSON-LD source against base, and never throws without one', async () => {
    const fetch = vi.fn(async (url: URL) => Response.json({ url: String(url) }))
    expect(await fetchJsonLd({ source: '/api/geo/jsonld', base: 'http://localhost:3000', path: '/blog/a', fetch: fetch as never })).toEqual({
      url: 'http://localhost:3000/api/geo/jsonld?path=%2Fblog%2Fa',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await fetchJsonLd({ source: '/api/geo/jsonld', path: '/blog/a', fetch: fetch as never })).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('fetches JSON-LD and builds safe script props', async () => {
    const fetch = vi.fn(async (url: URL) => Response.json({ path: url.searchParams.get('path') }))
    expect(await fetchJsonLd({ source: 'https://cms.test/api/geo/jsonld', path: '/blog/hello', fetch: fetch as never })).toEqual({ path: '/blog/hello' })
    expect(jsonLdScriptProps({ a: '</script>' }).dangerouslySetInnerHTML.__html).toBe('{"a":"\\u003c/script>"}')
  })
})

describe('AI referrals', () => {
  const CHROME = 'Mozilla/5.0 Chrome/130'
  const nav = (url: string, headers: Record<string, string>) =>
    new Request(url, { headers: { 'user-agent': CHROME, 'sec-fetch-dest': 'document', accept: 'text/html', ...headers } })

  it('is off unless configured', async () => {
    const { pending, event, fetch } = setup()
    withGeo({ endpoint: '/api/geo/ingest', fetch: fetch as never })(nav('https://site.test/a', { referer: 'https://chatgpt.com/' }), event)
    await Promise.all(pending)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a page load from an AI assistant with only the referrer origin and landing path', async () => {
    const { pending, event, fetch } = setup()
    const proxy = withGeo({ endpoint: '/api/geo/ingest', secret: 'abc', fetch: fetch as never, referrals: { endpoint: '/api/geo/referrals' } })
    proxy(nav('https://site.test/blog/a?utm_source=chatgpt.com&email=x', { referer: 'https://chatgpt.com/c/secret-conversation?q=1', 'x-forwarded-for': '9.9.9.9' }), event)
    await Promise.all(pending)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://site.test/api/geo/referrals')
    expect((init.headers as Record<string, string>)['x-geo-secret']).toBe('abc')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ url: '/blog/a?utm_source=chatgpt.com', referrer: 'https://chatgpt.com', host: 'site.test', ip: '9.9.9.9' })
    expect(init.body).not.toMatch(/secret-conversation|email/)
  })

  it('ignores unknown referrers, internal links, crawlers, prefetches and non-document requests', async () => {
    const { pending, event, fetch } = setup()
    const proxy = withGeo({ endpoint: '/api/geo/ingest', fetch: fetch as never, referrals: { endpoint: '/api/geo/referrals' } })
    proxy(nav('https://site.test/a', { referer: 'https://www.google.com/' }), event)
    proxy(nav('https://site.test/a', {}), event)
    proxy(nav('https://site.test/a', { referer: 'https://site.test/b' }), event)
    proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com/', 'next-router-prefetch': '1' }), event)
    proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com/', 'sec-fetch-dest': 'image' }), event)
    proxy(nav('https://site.test/a.md', { referer: 'https://chatgpt.com/' }), event)
    proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com.evil.test/' }), event)
    await Promise.all(pending)
    expect(fetch).not.toHaveBeenCalled()
    // A crawler with an AI referer is a crawler hit, not a referral.
    proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com/', 'user-agent': GPTBOT }), event)
    await Promise.all(pending)
    expect(fetch.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(['/api/geo/ingest'])
  })

  it('reports unknown external referrals only when asked', async () => {
    const { pending, event, fetch } = setup()
    const proxy = withGeo({ endpoint: '/api/geo/ingest', fetch: fetch as never, referrals: { endpoint: '/api/geo/referrals', unknown: true } })
    proxy(nav('https://site.test/a', { referer: 'https://www.google.com/search?q=x' }), event)
    proxy(nav('https://site.test/a', {}), event)
    await Promise.all(pending)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).referrer).toBe('https://www.google.com')
  })

  it('respects the consent hook and never delays or breaks the page', async () => {
    const { pending, event, fetch } = setup()
    const consent = vi.fn(async (req: Request) => req.headers.get('cookie') === 'analytics=yes')
    const proxy = withGeo({ endpoint: '/api/geo/ingest', fetch: fetch as never, referrals: { endpoint: '/api/geo/referrals', consent } }, () => 'page')
    expect(proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com/' }), event)).toBe('page')
    await Promise.all(pending)
    expect(fetch).not.toHaveBeenCalled()
    proxy(nav('https://site.test/a', { referer: 'https://chatgpt.com/', cookie: 'analytics=yes' }), event)
    await Promise.all(pending)
    expect(fetch).toHaveBeenCalledOnce()
    const failing = withGeo({ endpoint: '/x', onError: vi.fn(), fetch: fetch as never, referrals: { endpoint: '/r', consent: () => { throw new Error('boom') } } }, () => 'page')
    expect(failing(nav('https://site.test/a', { referer: 'https://chatgpt.com/' }), event)).toBe('page')
    await Promise.all(pending)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
