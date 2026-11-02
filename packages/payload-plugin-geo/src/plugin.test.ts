import { describe, expect, it, vi } from 'vitest'
import type { Config } from 'payload'
import { AI_REFERRALS_SLUG, CITATIONS_SLUG, CRAWLER_HITS_SLUG, geoPlugin } from './index.js'

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
      'get /geo/setup',
      'post /geo/setup/test',
      'get /geo/document-stats',
      'post /geo/referrals',
      'get /geo/evidence',
      'get /geo/llms.txt',
      'get /geo/llms-full.txt',
      'post /geo/inspect',
      'get /geo/markdown',
      'get /geo/jsonld',
    ])
    expect(config.admin?.components?.beforeDashboard?.[0]).toMatchObject({
      path: 'payload-plugin-geo/client#GeoDashboardClient',
      clientProps: { statsURL: '/api/geo/stats', compact: true },
    })
    const hits = config.collections!.find((c) => c.slug === CRAWLER_HITS_SLUG)!
    expect(hits.admin?.components?.beforeList?.[0]).toMatchObject({ clientProps: { compact: false } })
    const posts = config.collections!.find((c) => c.slug === 'posts')!
    expect(posts.fields.at(-1)).toMatchObject({
      name: 'geoPanel',
      type: 'ui',
      admin: { position: 'sidebar', components: { Field: { path: 'payload-plugin-geo/client#GeoEditPanel', clientProps: { inspectURL: '/api/geo/inspect', collection: 'posts' } } } },
    })
    expect(hits.fields.some((f: any) => f.name === 'geoPanel')).toBe(false)
    const off = geoPlugin({ editorPanel: false, llms: { siteURL: 'https://s', collections: { posts: {} } } })(base)
    expect(off.collections!.find((c) => c.slug === 'posts')!.fields).toEqual([])
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

  it('honours llms.cacheMaxAge on public output', async () => {
    const make = (cacheMaxAge: number) =>
      geoPlugin({ verifyIPs: false, llms: { siteURL: 'https://site.test', cacheMaxAge, collections: { posts: { url: (d) => `/blog/${d.slug}` } } } })(base)
    const noStore = make(0)
    const md = await noStore.endpoints!.find((e) => e.path === '/geo/markdown')!.handler(fakeRequest({ url: 'http://cms.test/api/geo/markdown?path=/blog/hello' }).req as never)
    expect(md.headers.get('cache-control')).toBe('no-store')
    const short = make(30)
    const missing = await short.endpoints!.find((e) => e.path === '/geo/jsonld')!.handler(fakeRequest({ url: 'http://cms.test/api/geo/jsonld?path=/nope' }).req as never)
    expect(missing.headers.get('cache-control')).toBe('public, max-age=30')
    const txt = await short.endpoints!.find((e) => e.path === '/geo/llms.txt')!.handler(fakeRequest({}).req as never)
    expect(txt.headers.get('cache-control')).toBe('public, max-age=30')
    const dflt = await endpoint('/geo/markdown').handler(fakeRequest({ url: 'http://cms.test/api/geo/markdown?path=/nope' }).req as never)
    expect(dflt.headers.get('cache-control')).toBe('public, max-age=60')
  })

  describe('inspect endpoint', () => {
    const inspectReq = (body: unknown, user?: object, overrides: Record<string, any> = {}) => {
      const stored = { id: 7, title: 'Stored', slug: 'hello', excerpt: 'Stored excerpt', _status: 'published', updatedAt: '2026-10-02T00:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z' }
      const find = vi.fn(async (args: any) => {
        if (args.overrideAccess === true) return { docs: overrides.published === false ? [] : [stored] }
        if (args.user) return { docs: [stored] }
        // Anonymous query from the public rules.
        return { docs: overrides.publicDocs ?? [stored] }
      })
      const findByID = vi.fn(async (args: any) => {
        if (overrides.forbidden) throw Object.assign(new Error('Forbidden'), { status: 403 })
        return args.collection === 'users' ? { id: 3, name: 'Ada' } : stored
      })
      return {
        req: { url: 'http://cms.test/api/geo/inspect', user, headers: new Headers(), json: async () => body, payload: { find, findByID, logger: { warn: vi.fn() } } },
        find,
        findByID,
      }
    }
    const withAuthor = geoPlugin({
      verifyIPs: false,
      llms: { siteURL: 'https://site.test', name: 'Acme', collections: { posts: { url: (d) => `/blog/${d.slug}` } } },
    })({
      serverURL: 'https://cms.test',
      collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'author', type: 'relationship', relationTo: 'users' }], versions: { drafts: true } }],
    } as unknown as Config)
    const handler = withAuthor.endpoints!.find((e) => e.path === '/geo/inspect')!.handler

    it('refuses anonymous callers and unconfigured collections, and is never cached', async () => {
      const anon = await handler(inspectReq({ collection: 'posts' }).req as never)
      expect(anon.status).toBe(401)
      expect(anon.headers.get('cache-control')).toBe('private, no-store')
      const other = await handler(inspectReq({ collection: 'users' }, { id: 1 }).req as never)
      expect(other.status).toBe(404)
      const proto = await handler(inspectReq({ collection: '__proto__' }, { id: 1 }).req as never)
      expect(proto.status).toBe(404)
      const forbidden = await handler(inspectReq({ collection: 'posts', id: 7 }, { id: 1 }, { forbidden: true }).req as never)
      expect(forbidden.status).toBe(403)
    })

    it('checks the current unsaved edits over the stored document, resolving the author relation', async () => {
      const { req, findByID } = inspectReq({ collection: 'posts', id: 7, data: { title: 'Edited title', author: 3 } }, { id: 1 })
      const res = await handler(req as never)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.document.title).toBe('Edited title')
      expect(body.document.authors).toEqual(['Ada'])
      expect(findByID).toHaveBeenCalledWith(expect.objectContaining({ collection: 'users', id: 3, overrideAccess: false }))
      expect(body.markdown).toContain('# Edited title')
      expect(body.checks.find((c: any) => c.ruleId === 'GEO-PUBLIC').status).toBe('pass')
      expect(body.publicLinks).toEqual({
        page: 'https://site.test/blog/hello',
        markdown: 'https://cms.test/api/geo/markdown?path=%2Fblog%2Fhello',
        jsonLd: 'https://cms.test/api/geo/jsonld?path=%2Fblog%2Fhello',
      })
      expect(body.validators[0].url).toContain('validator.schema.org')
    })

    it('reports a draft that anonymous visitors cannot see, without public links', async () => {
      const { req } = inspectReq({ collection: 'posts', id: 7, data: {} }, { id: 1 }, { published: false, publicDocs: [] })
      const body = await (await handler(req as never)).json()
      expect(body.checks.find((c: any) => c.ruleId === 'GEO-STATUS').status).toBe('warning')
      expect(body.checks.find((c: any) => c.ruleId === 'GEO-PUBLIC')).toMatchObject({ status: 'warning', message: expect.stringContaining('not published') })
      expect(body.publicLinks).toBeUndefined()
      expect(body.validators).toBeUndefined()
    })

    it('works for a new document that was never saved', async () => {
      const { req } = inspectReq({ collection: 'posts', data: { title: 'New' } }, { id: 1 })
      const body = await (await handler(req as never)).json()
      expect(body.checks.find((c: any) => c.ruleId === 'GEO-STATUS').status).toBe('notApplicable')
      expect(body.checks.find((c: any) => c.ruleId === 'GEO-URL').status).toBe('warning')
      expect(body.document.url).toBe('https://site.test/blog/undefined')
    })
  })

  describe('setup status and document visits', () => {
    const setupConfig = geoPlugin({
      secret: 'abc',
      verifyIPs: false,
      llms: { siteURL: 'https://site.test', collections: { posts: { url: (d) => `/blog/${d.slug}` } } },
    })({ collections: [{ slug: 'posts', fields: [{ name: 'slug', type: 'text' }] }] } as unknown as Config)
    const ep = (path: string) => setupConfig.endpoints!.find((e) => e.path === path)!.handler

    it('is admin only and never shows the secret', async () => {
      expect((await ep('/geo/setup')(fakeRequest({}).req as never)).status).toBe(401)
      expect((await ep('/geo/setup/test')(fakeRequest({}).req as never)).status).toBe(401)
      expect((await ep('/geo/document-stats')(fakeRequest({}).req as never)).status).toBe(401)
      const res = await ep('/geo/setup')(fakeRequest({ user: { id: 1 } }).req as never)
      const text = await res.text()
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(text).not.toContain('abc')
      const body = JSON.parse(text)
      expect(body.config.find((i: any) => i.id === 'CFG-SECRET').status).toBe('pass')
      expect(body.evidence.find((i: any) => i.id === 'EV-LATEST').status).toBe('pass')
      expect(body.manual[0]).toContain('https://site.test/blog/hello')
    })

    it('blocks the connectivity test against a private address by default', async () => {
      const local = geoPlugin({ verifyIPs: false, llms: { siteURL: 'http://127.0.0.1:3999', collections: { posts: { url: (d) => `/blog/${d.slug}` } } } })(
        { collections: [{ slug: 'posts', fields: [] }] } as unknown as Config,
      )
      const res = await local.endpoints!.find((e) => e.path === '/geo/setup/test')!.handler(fakeRequest({ user: { id: 1 } }).req as never)
      const body = await res.json()
      expect(body.active.find((i: any) => i.id === 'ACT-HTML')).toMatchObject({ status: 'error', detail: expect.stringContaining('private') })
    })

    it('computes visits for the document path, with the hits query narrowed and capped', async () => {
      const { req, find } = fakeRequest({ user: { id: 1 }, url: 'http://cms.test/api/geo/document-stats?collection=posts&id=7&days=7' })
      ;(req.payload as any).findByID = vi.fn(async () => ({ id: 7, slug: 'hello' }))
      const res = await ep('/geo/document-stats')(req as never)
      const body = await res.json()
      expect(body).toMatchObject({ path: '/blog/hello', days: 7, total: 1, timeZone: 'UTC' })
      const call = find.mock.calls.find((c: any) => c[0].collection === CRAWLER_HITS_SLUG)![0] as any
      expect(call.limit).toBe(20000)
      expect(JSON.stringify(call.where)).toContain('/blog/hello.md')
      const other = await ep('/geo/document-stats')(fakeRequest({ user: { id: 1 }, url: 'http://cms.test/api/geo/document-stats?collection=users&id=1' }).req as never)
      expect(other.status).toBe(404)
    })
  })

  describe('AI referrals and citation evidence', () => {
    const plain = { collections: [{ slug: 'posts', fields: [] }] } as unknown as Config
    const handler = (cfg: Config, path: string) => cfg.endpoints!.find((e) => e.path === path)!.handler
    const visit = { url: '/blog/hello', referrer: 'https://chatgpt.com', host: 'site.test', ip: '1.1.1.1', userAgent: 'Mozilla/5.0' }

    it('adds no collections and accepts nothing unless enabled', async () => {
      const cfg = geoPlugin({ secret: 'abc', verifyIPs: false })(plain)
      expect(cfg.collections!.map((c) => c.slug)).toEqual(['posts', CRAWLER_HITS_SLUG])
      const { req, create } = fakeRequest({ body: visit, secret: 'abc' })
      expect((await handler(cfg, '/geo/referrals')(req as never)).status).toBe(503)
      expect(create).not.toHaveBeenCalled()
      const res = await handler(cfg, '/geo/evidence')(fakeRequest({ user: { id: 1 } }).req as never)
      expect(await res.json()).toMatchObject({ referrals: null, citations: null })
    })

    it('stores an AI referral with host and path only, and requires the secret', async () => {
      const cfg = geoPlugin({ secret: 'abc', verifyIPs: false, referrals: { enabled: true } })(plain)
      expect(cfg.collections!.map((c) => c.slug)).toContain(AI_REFERRALS_SLUG)
      const bad = fakeRequest({ body: visit, secret: 'nope' })
      expect((await handler(cfg, '/geo/referrals')(bad.req as never)).status).toBe(401)
      const ok = fakeRequest({ body: visit, secret: 'abc' })
      const res = await handler(cfg, '/geo/referrals')(ok.req as never)
      expect(await res.json()).toMatchObject({ stored: 1 })
      const saved = (ok.create.mock.calls[0] as any)[0]
      expect(saved.collection).toBe(AI_REFERRALS_SLUG)
      expect(Object.keys(saved.data).sort()).toEqual(['host', 'path', 'platform', 'referrerHost', 'source', 'timestamp'])
      // The same visit again within 30 minutes is a duplicate.
      const again = fakeRequest({ body: visit, secret: 'abc' })
      expect(await (await handler(cfg, '/geo/referrals')(again.req as never)).json()).toMatchObject({ stored: 0, duplicates: 1 })
    })

    it('refuses referral reports when no secret is configured', async () => {
      const cfg = geoPlugin({ verifyIPs: false, referrals: { enabled: true } })(plain)
      expect((await handler(cfg, '/geo/referrals')(fakeRequest({ body: visit }).req as never)).status).toBe(503)
    })

    it('adds a private, versioned citation evidence collection with duplicate protection', async () => {
      const cfg = geoPlugin({ verifyIPs: false, citations: { enabled: true } })(plain)
      const citations = cfg.collections!.find((c) => c.slug === CITATIONS_SLUG)!
      expect(citations.versions).toBeTruthy()
      const shots = cfg.collections!.find((c) => c.slug === 'geo-citation-screenshots')!
      expect(await (shots.access!.read as any)({ req: {} })).toBe(false)
      expect(await (citations.access!.read as any)({ req: {} })).toBe(false)
      const hook = citations.hooks!.beforeChange![0]!
      const req = { user: { id: 9 }, payload: { find: vi.fn(async () => ({ docs: [] })) } }
      const data: any = { platform: 'ChatGPT', answerId: 'share-1', citedURL: 'https://site.test/blog/hello/' }
      await (hook as any)({ data, req, operation: 'create' })
      expect(data).toMatchObject({ recordedBy: 9, dedupeKey: 'chatgpt|share-1|site.test/blog/hello' })
      req.payload.find = vi.fn(async () => ({ docs: [{ id: 1 }] }))
      await expect((hook as any)({ data: { ...data }, req, operation: 'create' })).rejects.toThrow()
      // Without an answer id there is no key: duplicates are left to the reviewer.
      const loose: any = { platform: 'ChatGPT', citedURL: 'https://site.test/a' }
      await (hook as any)({ data: loose, req, operation: 'create' })
      expect(loose.dedupeKey).toBeNull()
    })

    it('reports the three signals separately, admin only', async () => {
      const cfg = geoPlugin({ secret: 'abc', verifyIPs: false, referrals: { enabled: true }, citations: { enabled: true } })(plain)
      expect((await handler(cfg, '/geo/evidence')(fakeRequest({}).req as never)).status).toBe(401)
      const { req } = fakeRequest({ user: { id: 1 }, url: 'http://cms.test/api/geo/evidence?days=7' })
      ;(req.payload as any).find = vi.fn(async ({ collection }: { collection: string }) => ({
        docs:
          collection === AI_REFERRALS_SLUG
            ? [{ timestamp: new Date().toISOString(), platform: 'OpenAI', source: 'referrer', path: '/blog/hello' }]
            : [{ platform: 'ChatGPT', status: 'verified' }, { platform: 'ChatGPT', status: 'pending' }],
      }))
      const body = await (await handler(cfg, '/geo/evidence')(req as never)).json()
      expect(body.referrals).toMatchObject({ total: 1, byPlatform: [{ platform: 'OpenAI', total: 1 }] })
      expect(body.citations).toMatchObject({ total: 2, byStatus: { verified: 1, pending: 1, invalid: 0 }, providers: [] })
      expect(body.newCitationHref).toBe('/admin/collections/geo-citations/create')
    })
  })
})
