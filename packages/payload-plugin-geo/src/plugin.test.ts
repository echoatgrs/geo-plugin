import { describe, expect, it, vi } from 'vitest'
import type { Config } from 'payload'
import { CRAWLER_HITS_SLUG, geoPlugin } from './index.js'

const posts = [
  { title: 'Hello', slug: 'hello', excerpt: 'First', content: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Body' }] }] } } },
  { title: 'Draftless', slug: 'two' },
]

function fakeRequest({ body, secret, user, url = 'http://cms.test/api/geo/stats?days=7' }: { body?: unknown; secret?: string; user?: object; url?: string }) {
  const create = vi.fn(async () => ({}))
  const find = vi.fn(async ({ collection }: { collection: string }) => ({
    docs:
      collection === 'posts'
        ? posts
        : [{ botId: 'claudebot', platform: 'Anthropic', purpose: 'training', verification: 'unverifiable', path: '/blog/hello', timestamp: new Date().toISOString() }],
  }))
  const req = {
    url,
    user,
    headers: new Headers(secret ? { 'x-geo-secret': secret } : {}),
    json: async () => body,
    payload: { create, find, logger: { warn: vi.fn() } },
  }
  return { req, create, find }
}

describe('geoPlugin', () => {
  const base = { collections: [{ slug: 'posts', fields: [], versions: { drafts: true } }], endpoints: [] } as unknown as Config
  const config = geoPlugin({
    secret: 'abc',
    verifyIPs: false,
    llms: { siteURL: 'https://site.test', name: 'Acme', collections: { posts: { section: 'Blog', url: (d) => `/blog/${d.slug}` } } },
  })(base)
  const endpoint = (path: string) => config.endpoints!.find((e) => e.path === path)!

  it('adds the collection, endpoints and admin dashboard components', () => {
    expect(config.collections?.map((c) => c.slug)).toEqual(['posts', CRAWLER_HITS_SLUG])
    expect(config.endpoints?.map((e) => `${e.method} ${e.path}`)).toEqual([
      'post /geo/ingest',
      'get /geo/stats',
      'get /geo/llms.txt',
      'get /geo/llms-full.txt',
      'get /geo/markdown',
      'get /geo/jsonld',
    ])
    expect(config.admin?.components?.beforeDashboard?.[0]).toMatchObject({
      path: 'payload-plugin-geo/client#GeoDashboardClient',
      clientProps: { statsURL: '/api/geo/stats', compact: true },
    })
    const hits = config.collections!.find((c) => c.slug === CRAWLER_HITS_SLUG)!
    expect(hits.admin?.components?.beforeList?.[0]).toMatchObject({ clientProps: { compact: false } })
  })

  it('stores hits sent by the frontend proxy', async () => {
    const { req, create } = fakeRequest({ body: { path: '/pricing', userAgent: 'PerplexityBot/1.0' }, secret: 'abc' })
    const res = await endpoint('/geo/ingest').handler(req as never)
    expect(res.status).toBe(200)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ collection: CRAWLER_HITS_SLUG, overrideAccess: true, data: expect.objectContaining({ botId: 'perplexitybot' }) }),
    )
  })

  it('rejects ingest with the wrong secret', async () => {
    const { req, create } = fakeRequest({ body: { path: '/', userAgent: 'GPTBot' }, secret: 'wrong' })
    expect((await endpoint('/geo/ingest').handler(req as never)).status).toBe(401)
    expect(create).not.toHaveBeenCalled()
  })

  it('serves llms.txt from published, publicly readable documents', async () => {
    const { req, find } = fakeRequest({})
    const res = await endpoint('/geo/llms.txt').handler(req as never)
    expect(await res.text()).toBe('# Acme\n\n## Blog\n\n- [Hello](https://site.test/blog/hello): First\n- [Draftless](https://site.test/blog/two)\n')
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'posts', overrideAccess: false, where: { and: [{ _status: { equals: 'published' } }] } }),
    )
    const full = await endpoint('/geo/llms-full.txt').handler(req as never)
    expect(await full.text()).toContain('Body')
  })

  it('returns stats only to logged-in users', async () => {
    expect((await endpoint('/geo/stats').handler(fakeRequest({}).req as never)).status).toBe(401)
    const res = await endpoint('/geo/stats').handler(fakeRequest({ user: { id: 1 } }).req as never)
    expect(await res.json()).toMatchObject({ total: 1, coverage: 0.5, neverCrawled: ['/blog/two'] })
  })

  it('serves the Markdown version of a published page by path', async () => {
    const { req } = fakeRequest({ url: 'http://cms.test/api/geo/markdown?path=/blog/hello' })
    const res = await endpoint('/geo/markdown').handler(req as never)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(await res.text()).toBe('# Hello\n\nURL: https://site.test/blog/hello\n\n> First\n\nBody\n')

    const missing = await endpoint('/geo/markdown').handler(fakeRequest({ url: 'http://cms.test/api/geo/markdown?path=/nope' }).req as never)
    expect(missing.status).toBe(404)
    const bad = await endpoint('/geo/markdown').handler(fakeRequest({ url: 'http://cms.test/api/geo/markdown' }).req as never)
    expect(bad.status).toBe(400)
  })

  it('serves JSON-LD for a page', async () => {
    const res = await endpoint('/geo/jsonld').handler(fakeRequest({ url: 'http://cms.test/api/geo/jsonld?path=/blog/two' }).req as never)
    expect(res.headers.get('content-type')).toContain('application/ld+json')
    expect(await res.json()).toMatchObject({ '@graph': [{ '@type': 'Article', headline: 'Draftless', url: 'https://site.test/blog/two' }] })
  })

  it('queries by slug when the collection has a slug field, and keeps the published filter', async () => {
    const withSlug = geoPlugin({
      verifyIPs: false,
      llms: { siteURL: 'https://site.test', collections: { posts: { url: (d) => `/blog/${d.slug}` } } },
    })({
      collections: [{ slug: 'posts', fields: [{ type: 'row', fields: [{ name: 'slug', type: 'text' }] }], versions: { drafts: true } }],
    } as unknown as Config)
    const { req, find } = fakeRequest({ url: 'http://cms.test/api/geo/markdown?path=/blog/hello' })
    const res = await withSlug.endpoints!.find((e) => e.path === '/geo/markdown')!.handler(req as never)
    expect(res.status).toBe(200)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideAccess: false,
        where: { and: [{ _status: { equals: 'published' } }, { slug: { equals: 'hello' } }] },
      }),
    )
  })

  it('skips collections the public cannot read instead of failing', async () => {
    const withPrivate = geoPlugin({
      verifyIPs: false,
      llms: { siteURL: 'https://site.test', collections: { secrets: {}, posts: { url: (d) => `/blog/${d.slug}` } } },
    })({ collections: [{ slug: 'secrets', fields: [] }, { slug: 'posts', fields: [] }] } as unknown as Config)
    const { req, find } = fakeRequest({})
    find.mockImplementationOnce(async () => {
      throw Object.assign(new Error('You are not allowed to perform this action.'), { status: 403 })
    })
    const res = await withPrivate.endpoints!.find((e) => e.path === '/geo/llms.txt')!.handler(req as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('[Hello](https://site.test/blog/hello)')
  })
})
