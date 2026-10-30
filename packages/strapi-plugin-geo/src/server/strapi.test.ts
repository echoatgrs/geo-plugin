import { describe, expect, it, vi } from 'vitest'
import plugin, { CRAWLER_HIT_UID, controllers } from './index'
import type { KoaContextLike, StrapiLike } from './types'

const ARTICLE = 'api::article.article'

function fakeStrapi(config: Record<string, unknown>, data: Record<string, Record<string, any>[]> = {}) {
  const create = vi.fn(async () => ({}))
  const findMany = vi.fn(async (uid: string, params: Record<string, any>) =>
    (data[uid] ?? []).slice(params.start ?? 0, (params.start ?? 0) + (params.limit ?? 100)),
  )
  const strapi: StrapiLike = {
    plugin: () => ({ config: <T,>(key: string, fallback?: T) => (key in config ? config[key] : fallback) as T }),
    documents: (uid) => ({ create, findMany: (params = {}) => findMany(uid, params) }),
    contentType: (uid) => (uid === ARTICLE ? { info: { pluralName: 'articles' } } : undefined),
    log: { warn: vi.fn(), info: vi.fn() },
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
    ])
    expect(plugin.routes.admin.routes[0]).toMatchObject({ path: '/stats', config: { policies: ['admin::isAuthenticatedAdmin'] } })
  })
})
