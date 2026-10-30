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
})
