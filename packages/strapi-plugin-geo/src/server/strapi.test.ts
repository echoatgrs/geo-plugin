import { describe, expect, it, vi } from 'vitest'
import { resetWarnings } from './access'
import plugin, { CRAWLER_HIT_UID, controllers } from './index'
import type { KoaContextLike, StrapiLike } from './types'

const ARTICLE = 'api::article.article'

function fakeStrapi(
  config: Record<string, unknown>,
  data: Record<string, Record<string, any>[]> = {},
  publicActions: string[] | null = [`${ARTICLE}.find`, `${ARTICLE}.findOne`],
) {
  const create = vi.fn(async () => ({}))
  const findMany = vi.fn(async (uid: string, params: Record<string, any>) =>
    (data[uid] ?? []).slice(params.start ?? 0, (params.start ?? 0) + (params.limit ?? 100)),
  )
  const strapi: StrapiLike = {
    plugin: () => ({ config: <T,>(key: string, fallback?: T) => (key in config ? config[key] : fallback) as T }),
    documents: (uid) => ({ create, findMany: (params = {}) => findMany(uid, params) }),
    contentType: (uid) =>
      uid === ARTICLE ? { info: { pluralName: 'articles' } } : uid === 'plugin::users-permissions.role' && publicActions ? {} : undefined,
    log: { warn: vi.fn(), info: vi.fn() },
    db: {
      query: () => ({
        findOne: async () => (publicActions ? { type: 'public', permissions: publicActions.map((action) => ({ action })) } : null),
      }),
    },
  }
  return { strapi, create, findMany }
}

function ctx(body: unknown, secret = '', query: Record<string, unknown> = {}): KoaContextLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return {
    request: { body, get: (f) => (f === 'x-geo-secret' ? secret : '') },
    query,
    status: 404,
    body: undefined,
    headers,
    set: (k, v) => void (headers[k] = v),
  }
}

describe('strapi-plugin-geo', () => {
  it('stores hits through the Document Service', async () => {
    const { strapi, create } = fakeStrapi({ secret: 'abc', verifyIPs: false })
    const c = ctx({ path: '/docs', userAgent: 'Claude-User/1.0' }, 'abc')
    await controllers.ingest({ strapi }).ingest(c)
    expect(c.status).toBe(200)
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ botId: 'claude-user', purpose: 'user', path: '/docs' }) })
  })

  it('rejects requests without the secret', async () => {
    const { strapi, create } = fakeStrapi({ secret: 'abc' })
    const c = ctx({ path: '/', userAgent: 'GPTBot' })
    await controllers.ingest({ strapi }).ingest(c)
    expect(c.status).toBe(401)
    expect(create).not.toHaveBeenCalled()
  })

  const llms = {
    siteURL: 'https://site.test',
    name: 'Acme',
    contentTypes: { [ARTICLE]: { section: 'Blog' } },
  }
  const articles = [
    { title: 'Hello', slug: 'hello', description: 'First post', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hi there' }] }] },
    { title: 'Second', slug: 'second' },
  ]

  it('serves llms.txt and llms-full.txt from published entries', async () => {
    const { strapi, findMany } = fakeStrapi({ llms }, { [ARTICLE]: articles })
    const c = ctx(undefined)
    await controllers.llms({ strapi }).llmsTxt(c)
    expect(c.headers['Content-Type']).toContain('text/plain')
    expect(c.body).toBe(
      '# Acme\n\n## Blog\n\n- [Hello](https://site.test/articles/hello): First post\n- [Second](https://site.test/articles/second)\n',
    )
    expect(findMany).toHaveBeenCalledWith(ARTICLE, expect.objectContaining({ status: 'published' }))

    const full = ctx(undefined)
    await controllers.llms({ strapi }).llmsFullTxt(full)
    expect(full.body).toContain('Hi there')
  })

  it('leaves out content types the Public role cannot read', async () => {
    const { strapi, findMany } = fakeStrapi({ llms }, { [ARTICLE]: articles }, [])
    const c = ctx(undefined)
    await controllers.llms({ strapi }).llmsTxt(c)
    expect(c.body).toBe('# Acme\n')
    expect(findMany).not.toHaveBeenCalled()
    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining(`${ARTICLE} is skipped`))

    const md = ctx(undefined, '', { path: '/articles/hello' })
    await controllers.page({ strapi }).markdown(md)
    expect(md.status).toBe(404)
  })

  it('lists nothing without Users & Permissions unless publicOnly is false', async () => {
    const closed = fakeStrapi({ llms }, { [ARTICLE]: articles }, null)
    const c = ctx(undefined)
    await controllers.llms({ strapi: closed.strapi }).llmsTxt(c)
    expect(c.body).toBe('# Acme\n')

    const open = fakeStrapi({ llms: { ...llms, publicOnly: false } }, { [ARTICLE]: articles }, null)
    const o = ctx(undefined)
    await controllers.llms({ strapi: open.strapi }).llmsTxt(o)
    expect(o.body).toContain('[Hello]')
  })

  it('returns 404 for llms.txt when not configured', async () => {
    const { strapi } = fakeStrapi({})
    const c = ctx(undefined)
    await controllers.llms({ strapi }).llmsTxt(c)
    expect(c.status).toBe(404)
  })

  it('computes dashboard stats with coverage', async () => {
    const now = new Date().toISOString()
    const { strapi } = fakeStrapi(
      { llms },
      {
        [ARTICLE]: articles,
        [CRAWLER_HIT_UID]: [
          { botId: 'chatgpt-user', platform: 'OpenAI', purpose: 'user', verification: 'verified', path: '/articles/hello', timestamp: now },
        ],
      },
    )
    const c = ctx(undefined, '', { days: '7' })
    await controllers.stats({ strapi }).stats(c)
    expect(c.body).toMatchObject({ total: 1, userFetches: 1, coverage: 0.5, neverCrawled: ['/articles/second'] })
  })

  it('exposes public content-api routes and an admin-only stats route', () => {
    expect(plugin.routes['content-api'].routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /ingest',
      'GET /llms.txt',
      'GET /llms-full.txt',
      'GET /markdown',
      'GET /jsonld',
    ])
    expect(plugin.routes.admin.routes[0]).toMatchObject({ path: '/stats', config: { policies: ['admin::isAuthenticatedAdmin'] } })
  })

  it('serves per-page Markdown and JSON-LD for published entries, queried by slug', async () => {
    const { strapi, findMany } = fakeStrapi({ llms: { ...llms, contentTypes: { [ARTICLE]: { url: (d: any) => `/blog/${d.slug}`, jsonLd: { type: 'BlogPosting' } } } } }, { [ARTICLE]: articles })
    strapi.contentType = () => ({ info: { pluralName: 'articles' }, attributes: { slug: { type: 'uid' } } })
    const md = ctx(undefined, '', { path: '/blog/hello' })
    await controllers.page({ strapi }).markdown(md)
    expect(md.status).toBe(200)
    expect(md.headers['Content-Type']).toContain('text/markdown')
    expect(md.body).toBe('# Hello\n\nURL: https://site.test/blog/hello\n\n> First post\n\nHi there\n')
    expect(findMany).toHaveBeenCalledWith(ARTICLE, expect.objectContaining({ status: 'published', filters: { slug: { $eq: 'hello' } } }))

    const ld = ctx(undefined, '', { path: '/blog/hello' })
    await controllers.page({ strapi }).jsonLd(ld)
    expect(ld.headers['Content-Type']).toContain('application/ld+json')
    expect(JSON.parse(ld.body as string)).toMatchObject({ '@graph': [{ '@type': 'BlogPosting', headline: 'Hello' }] })
  })

  it('returns 404 for unknown pages and 400 without a path', async () => {
    const { strapi } = fakeStrapi({ llms }, { [ARTICLE]: articles })
    const missing = ctx(undefined, '', { path: '/articles/nope' })
    await controllers.page({ strapi }).markdown(missing)
    expect(missing.status).toBe(404)
    const bad = ctx(undefined, '', {})
    await controllers.page({ strapi }).jsonLd(bad)
    expect(bad.status).toBe(400)
  })

  describe('public access', () => {
    const PAGE = 'api::page.page'
    const twoTypes = {
      siteURL: 'https://site.test',
      name: 'Acme',
      contentTypes: {
        [ARTICLE]: { section: 'Blog', url: (d: any) => `/blog/${d.slug}` },
        [PAGE]: { section: 'Pages', url: (d: any) => `/${d.slug}` },
      },
    }
    const route = (uid: string, action: string, config: Record<string, unknown> = {}) => ({
      method: 'GET',
      path: `/${action}`,
      handler: `${uid}.${action}`,
      config,
    })

    function setup(options: {
      llms?: Record<string, any>
      actions?: string[]
      routes?: Record<string, unknown>[]
      data?: Record<string, Record<string, any>[]>
    } = {}) {
      resetWarnings()
      const f = fakeStrapi({ llms: options.llms ?? twoTypes }, options.data ?? {
        [ARTICLE]: [{ title: 'Article Hello', slug: 'hello', secretNote: 'internal' }],
        [PAGE]: [{ title: 'Page Hello', slug: 'hello' }],
      }, options.actions ?? [`${ARTICLE}.find`, `${PAGE}.find`])
      const base = f.strapi.contentType!
      f.strapi.contentType = (uid) =>
        uid === PAGE ? { info: { pluralName: 'pages' }, attributes: { slug: {} } } : uid === ARTICLE ? { info: { pluralName: 'articles' }, attributes: { slug: {} } } : base(uid)
      f.strapi.apis = {
        article: { routes: { article: { type: 'content-api', routes: options.routes ?? [route(ARTICLE, 'find'), route(ARTICLE, 'findOne')] } } },
        page: { routes: { page: { type: 'content-api', routes: [route(PAGE, 'find'), route(PAGE, 'findOne')] } } },
      }
      const output = vi.fn(async (entry: Record<string, any>, _schema: unknown, opts: { auth?: any }) => {
        // Like Strapi: private fields are dropped, and the auth strategy decides relations.
        const { secretNote, ...rest } = entry
        expect(opts.auth?.credentials).toBeNull()
        return rest
      })
      f.strapi.contentAPI = { sanitize: { output } }
      return { ...f, output }
    }

    async function outputs(strapi: StrapiLike, path: string) {
      const llmsTxt = ctx(undefined)
      await controllers.llms({ strapi }).llmsTxt(llmsTxt)
      const full = ctx(undefined)
      await controllers.llms({ strapi }).llmsFullTxt(full)
      const md = ctx(undefined, '', { path })
      await controllers.page({ strapi }).markdown(md)
      const ld = ctx(undefined, '', { path })
      await controllers.page({ strapi }).jsonLd(ld)
      return { llmsTxt: String(llmsTxt.body), full: String(full.body), md, ld }
    }

    it('needs `find` for the Public role: findOne alone is not enough to list or look up by slug', async () => {
      const { strapi } = setup({ actions: [`${ARTICLE}.findOne`, `${PAGE}.find`] })
      const out = await outputs(strapi, '/blog/hello')
      expect(out.llmsTxt).not.toContain('Article Hello')
      expect(out.llmsTxt).not.toContain('## Blog')
      expect(out.llmsTxt).toContain('[Page Hello](https://site.test/hello)')
      expect(out.full).not.toContain('Article Hello')
      expect(out.md.status).toBe(404)
      expect(out.ld.status).toBe(404)
      expect(out.md.body).toBe('Not found\n')
    })

    it('keeps the same slug in two content types apart', async () => {
      const { strapi } = setup({ actions: [`${PAGE}.find`] })
      const blog = await outputs(strapi, '/blog/hello')
      expect(blog.md.status).toBe(404)
      const page = await outputs(strapi, '/hello')
      expect(page.md.status).toBe(200)
      expect(page.md.body).toContain('# Page Hello')
    })

    it('runs entries through the content API sanitizer with the Public ability', async () => {
      const { strapi, output } = setup()
      const out = await outputs(strapi, '/blog/hello')
      expect(output).toHaveBeenCalled()
      expect(out.md.status).toBe(200)
      expect(out.full).not.toContain('internal')
    })

    it('skips a content type whose find route has a custom policy unless isPublic decides', async () => {
      const routes = [route(ARTICLE, 'find', { policies: ['api::article.members-only'] })]
      const data = { [ARTICLE]: [{ title: 'Free', slug: 'free', members: false }, { title: 'Paid', slug: 'paid', members: true }], [PAGE]: [] }
      const skipped = setup({ routes, data })
      const out = await outputs(skipped.strapi, '/blog/free')
      expect(out.llmsTxt).not.toContain('Free')
      expect(out.md.status).toBe(404)
      expect(skipped.strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('custom policies'))

      const llms = { ...twoTypes, contentTypes: { ...twoTypes.contentTypes, [ARTICLE]: { ...twoTypes.contentTypes[ARTICLE], isPublic: (e: any) => e.members === false } } }
      const decided = setup({ routes, data, llms })
      const free = await outputs(decided.strapi, '/blog/free')
      expect(free.llmsTxt).toContain('[Free]')
      expect(free.llmsTxt).not.toContain('Paid')
      expect(free.md.status).toBe(200)
      const paid = await outputs(decided.strapi, '/blog/paid')
      expect(paid.md.status).toBe(404)
      expect(paid.ld.status).toBe(404)
    })

    it('hides an entry when isPublic throws', async () => {
      const llms = { ...twoTypes, contentTypes: { [ARTICLE]: { url: (d: any) => `/blog/${d.slug}`, isPublic: () => { throw new Error('boom') } } } }
      const { strapi } = setup({ llms })
      const out = await outputs(strapi, '/blog/hello')
      expect(out.llmsTxt).toBe('# Acme\n')
      expect(out.md.status).toBe(404)
      expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('isPublic'))
    })

    it('skips a content type without a REST find route', async () => {
      const { strapi } = setup({ routes: [route(ARTICLE, 'findOne')] })
      const out = await outputs(strapi, '/blog/hello')
      expect(out.llmsTxt).not.toContain('Article Hello')
      expect(out.md.status).toBe(404)
    })

    it('serves a type whose find route is open (`auth: false`) without a Public permission', async () => {
      const { strapi } = setup({ actions: [], routes: [route(ARTICLE, 'find', { auth: false })] })
      const out = await outputs(strapi, '/blog/hello')
      expect(out.llmsTxt).toContain('Article Hello')
      expect(out.md.status).toBe(200)
    })

    it('uses the same visibility for the coverage denominator', async () => {
      const { strapi } = setup({ actions: [`${PAGE}.find`] })
      const c = ctx(undefined, '', { days: '7' })
      await controllers.stats({ strapi }).stats(c)
      expect(c.body).toMatchObject({ coverage: 0, neverCrawled: ['/hello'] })
    })

    it('honours cacheMaxAge, with no-store for 0', async () => {
      const { strapi } = setup({ llms: { ...twoTypes, cacheMaxAge: 0 } })
      const md = ctx(undefined, '', { path: '/blog/hello' })
      await controllers.page({ strapi }).markdown(md)
      expect(md.headers['Cache-Control']).toBe('no-store')
      const other = setup({ llms: { ...twoTypes, cacheMaxAge: 30 } })
      const missing = ctx(undefined, '', { path: '/blog/nope' })
      await controllers.page({ strapi: other.strapi }).markdown(missing)
      expect(missing.headers['Cache-Control']).toBe('public, max-age=30')
      const t = ctx(undefined)
      await controllers.llms({ strapi: other.strapi }).llmsTxt(t)
      expect(t.headers['Cache-Control']).toBe('public, max-age=30')
    })

    it('rejects a non-function isPublic and a bad cacheMaxAge in the config', () => {
      expect(() => plugin.config.validator({ llms: { siteURL: 'x', contentTypes: { a: { isPublic: true as any } } } })).toThrow(/isPublic/)
      expect(() => plugin.config.validator({ llms: { siteURL: 'x', contentTypes: {}, cacheMaxAge: -1 } })).toThrow(/cacheMaxAge/)
    })
  })
})
