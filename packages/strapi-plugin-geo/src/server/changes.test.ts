import { describe, expect, it, vi } from 'vitest'
import { resetWarnings } from './access'
import plugin, { INVALIDATION_UID, controllers, routes } from './index'
import { changeMiddleware, subscribePermissionChanges, type ChangeDeps } from './changes'
import type { KoaContextLike, StrapiLike } from './types'

const ARTICLE = 'api::article.article'
type Entry = Record<string, any>

const matches = (e: Entry, f: any): boolean => {
  if (!f) return true
  if (f.$and) return f.$and.every((x: any) => matches(e, x))
  return Object.entries(f).every(([k, v]: [string, any]) => (v && typeof v === 'object' && '$eq' in v ? e[k] === v.$eq : true))
}

/** Document Service with published filter, `$eq` filters, sort, start / limit and count. */
function fakeStrapi(config: Record<string, unknown>, entries: Entry[], publicActions: string[] = [`${ARTICLE}.find`, `${ARTICLE}.findOne`]) {
  const created: Entry[] = []
  const subscribers: Record<string, any>[] = []
  const list = (params: Entry) => {
    const sort: string[] = Array.isArray(params.sort) ? params.sort : [params.sort ?? 'id:asc']
    return entries
      .filter((e) => (params.status === 'published' ? e.publishedAt : true) && matches(e, params.filters))
      .sort((a, b) => {
        for (const s of sort) {
          const [k, dir] = s.split(':') as [string, string]
          const d = dir === 'desc' ? -1 : 1
          if (a[k] < b[k]) return -d
          if (a[k] > b[k]) return d
        }
        return 0
      })
  }
  const findMany = vi.fn(async (uid: string, params: Entry = {}) => {
    if (uid === INVALIDATION_UID) return created.filter((r) => matches(r, params.filters))
    return list(params).slice(params.start ?? 0, (params.start ?? 0) + (params.limit ?? 100)).map((e) => ({ ...e }))
  })
  const strapi: StrapiLike & { db: any } = {
    plugin: () => ({ config: <T,>(key: string, fallback?: T) => (key in config ? config[key] : fallback) as T }),
    documents: (uid) => ({
      create: async ({ data }) => {
        const row = { documentId: `inv${created.length + 1}`, createdAt: new Date().toISOString(), ...data }
        created.push(row)
        return row
      },
      findMany: (params) => findMany(uid, params),
      count: async (params = {}) => list(params).length,
    }),
    contentType: (uid) => (uid === ARTICLE ? { info: { pluralName: 'articles' }, attributes: { slug: {} } } : uid === 'plugin::users-permissions.role' ? {} : undefined),
    log: { warn: vi.fn(), info: vi.fn() },
    db: {
      query: () => ({ findOne: async () => ({ type: 'public', permissions: publicActions.map((action) => ({ action })) }) }),
      lifecycles: { subscribe: (s: Entry) => subscribers.push(s) },
    },
  }
  return { strapi, created, findMany, subscribers }
}

const article = (i: number): Entry => ({
  id: i,
  documentId: `d${i}`,
  title: `Post ${i}`,
  slug: `p${i}`,
  createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 4) * 86400_000).toISOString(),
  updatedAt: '2026-11-01T00:00:00.000Z',
  publishedAt: i % 10 === 0 ? null : '2026-11-01T00:00:00.000Z',
  featured: i === 7,
})
const many = (n: number) => Array.from({ length: n }, (_, i) => article(i + 1))
const llms = { siteURL: 'https://site.test', name: 'Acme', contentTypes: { [ARTICLE]: { section: 'Blog', featured: 'featured' } } }

function ctx(query: Record<string, unknown> = {}, body?: unknown): KoaContextLike & { headers: Record<string, string>; params?: Record<string, string> } {
  const headers: Record<string, string> = {}
  return { request: { body, get: () => '' }, query, status: 404, body: undefined, headers, set: (k, v) => void (headers[k] = v) }
}
const links = (text: string) => [...text.matchAll(/\/articles\/(p\d+)\)/g)].map((m) => m[1]!)

describe('listing and segments', () => {
  it('reads past 100 entries per query, in pages, without duplicates', async () => {
    resetWarnings()
    const { strapi, findMany } = fakeStrapi({ llms }, many(250))
    const c = ctx()
    await controllers.llms({ strapi }).llmsTxt(c)
    const found = links(String(c.body))
    expect(found).toHaveLength(225)
    expect(new Set(found).size).toBe(225)
    const pages = findMany.mock.calls.filter(([uid]) => uid === ARTICLE).map(([, p]) => [p.start, p.limit])
    expect(pages).toEqual([[0, 100], [100, 100], [200, 100]])
  })

  it('notes a limit that cuts the list and applies include to lists only', async () => {
    const cfg = { ...llms, contentTypes: { [ARTICLE]: { section: 'Blog', limit: 30, include: (e: Entry) => e.slug !== 'p2' } } }
    const { strapi } = fakeStrapi({ llms: cfg }, many(250))
    const c = ctx()
    await controllers.llms({ strapi }).llmsTxt(c)
    expect(String(c.body)).toContain('Lists 30 of 225 entries')
    expect(links(String(c.body))).not.toContain('p2')
    const md = ctx({ path: '/articles/p2' })
    await controllers.page({ strapi }).markdown(md)
    expect(md.status).toBe(200)
  })

  it('serves a segment index and parts that cover every public entry once', async () => {
    const { strapi } = fakeStrapi({ llms: { ...llms, segments: { enabled: true, size: 100 } } }, many(250))
    const index = ctx()
    await controllers.llms({ strapi }).llmsTxt(index)
    expect(String(index.body)).toContain('https://site.test/llms/articles-3.txt')
    expect(String(index.body)).not.toContain('articles-4.txt')
    expect(String(index.body)).toContain('## Featured')
    const seen: string[] = []
    for (const n of [1, 2, 3]) {
      const c = ctx()
      c.params = { file: `articles-${n}.txt` }
      await controllers.llms({ strapi }).llmsPart(c)
      expect(c.status).toBe(200)
      seen.push(...links(String(c.body)))
    }
    expect(seen).toHaveLength(225)
    expect(new Set(seen).size).toBe(225)
    for (const file of ['articles-4.txt', '../x-1.txt', 'other-1.txt']) {
      const c = ctx()
      c.params = { file }
      await controllers.llms({ strapi }).llmsPart(c)
      expect(c.status).toBe(404)
    }
  })

  it('serves no parts when the Public role loses find, and short-caches 404s', async () => {
    const { strapi } = fakeStrapi({ llms: { ...llms, cacheMaxAge: 600, notFoundMaxAge: 15, segments: { enabled: true } } }, many(20), [])
    const c = ctx()
    c.params = { file: 'articles-1.txt' }
    await controllers.llms({ strapi }).llmsPart(c)
    expect(c.status).toBe(404)
    expect(c.headers['Cache-Control']).toBe('public, max-age=15')
  })
})

describe('invalidation', () => {
  const secret = 'y'.repeat(32)
  const invalidation = { targets: [{ name: 'frontend', url: 'http://127.0.0.1:3000/api/revalidate', secret }], allowPrivateNetwork: true }

  it('registers admin routes, the content type, and validates targets', () => {
    expect(routes.admin.routes.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /invalidations', 'POST /invalidations/retry', 'POST /invalidations/flush']))
    expect(routes.admin.routes.filter((r) => r.path.startsWith('/invalidations')).every((r) => r.config.policies.includes('admin::isAuthenticatedAdmin'))).toBe(true)
    expect(plugin.contentTypes.invalidation.schema.collectionName).toBe('geo_invalidations')
    expect(() => plugin.config.validator({ invalidation: { targets: [{ name: 'a', url: 'https://x.test', secret: 'short' }] } })).toThrow(/16 characters/)
  })

  it('sends publish, update (URL change), unpublish and delete; nothing for draft-only edits', async () => {
    const entries = many(3)
    entries[0]!.publishedAt = null
    const { strapi, created } = fakeStrapi({ llms, invalidation }, entries)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const deps: ChangeDeps = {
      llms: () => llms,
      invalidation: () => invalidation,
      publicEntry: (uid, id) => import('./index').then((m) => m.publicEntry(strapi, llms, uid, id)),
    }
    const mw = changeMiddleware(strapi, deps)
    const settle = async (n: number) => {
      await new Promise((r) => setTimeout(r, 20))
      await vi.waitFor(() => expect(created).toHaveLength(n))
    }
    const write = (action: string, documentId: string, change: () => void) => mw({ uid: ARTICLE, action, params: { documentId } }, async () => (change(), { documentId }))
    await write('update', 'd1', () => (entries[0]!.title = 'draft edit'))
    await settle(0)
    await write('publish', 'd1', () => (entries[0]!.publishedAt = '2026-11-03T00:00:00.000Z'))
    await settle(1)
    await write('publish', 'd1', () => (entries[0]!.slug = 'renamed'))
    await settle(2)
    await write('unpublish', 'd1', () => (entries[0]!.publishedAt = null))
    await settle(3)
    await write('delete', 'd2', () => entries.splice(1, 1))
    await settle(4)
    // Reads and other content types pass straight through.
    const next = vi.fn(async () => [])
    await mw({ uid: ARTICLE, action: 'findMany', params: {} }, next)
    await mw({ uid: 'api::other.other', action: 'update', params: { documentId: 'x' } }, next)
    expect(next).toHaveBeenCalledTimes(2)
    expect(created.map((r) => r.eventType)).toEqual(['publish', 'update', 'unpublish', 'delete'])
    expect(created[1]!.event).toMatchObject({ previousPath: '/articles/p1', path: '/articles/renamed' })
    expect(created.every((r) => r.status === 'succeeded')).toBe(true)
    const [, init] = fetch.mock.calls[0]! as [URL, RequestInit]
    expect(new Headers(init.headers).get('x-geo-signature')).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    fetch.mockRestore()
  })

  it('a failing write still fails, a failing notice never does', async () => {
    const { strapi, created } = fakeStrapi({ llms, invalidation }, many(2))
    const deps: ChangeDeps = { llms: () => llms, invalidation: () => invalidation, publicEntry: async () => { throw new Error('db down') } }
    const mw = changeMiddleware(strapi, deps)
    await expect(mw({ uid: ARTICLE, action: 'update', params: { documentId: 'd1' } }, async () => { throw new Error('validation') })).rejects.toThrow('validation')
    await expect(mw({ uid: ARTICLE, action: 'update', params: { documentId: 'd1' } }, async () => ({ documentId: 'd1' }))).resolves.toEqual({ documentId: 'd1' })
    expect(created).toHaveLength(0)
    expect(strapi.log.warn).toHaveBeenCalledWith(expect.stringContaining('db down'))
  })

  it('sends one access notice per burst of permission changes', async () => {
    vi.useFakeTimers()
    const { strapi, subscribers } = fakeStrapi({ llms, invalidation }, [])
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    subscribePermissionChanges(strapi, { llms: () => llms, invalidation: () => invalidation, publicEntry: async () => null }, 100)
    expect(subscribers[0]!.models).toEqual(['plugin::users-permissions.permission'])
    for (let i = 0; i < 5; i++) subscribers[0]!.afterCreate()
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ type: 'access', source: '*' })
    fetch.mockRestore()
  })

  it('admin list hides secrets; retry and flush report results', async () => {
    const { strapi, created } = fakeStrapi({ llms, invalidation }, [])
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))
    const c = controllers.invalidations({ strapi })
    const f = ctx()
    await c.flush(f)
    expect(f.body).toMatchObject({ results: [{ target: 'frontend', status: 'failed', lastError: 'HTTP 503' }] })
    fetch.mockImplementation(async () => new Response('ok'))
    const r = ctx({}, { id: created[0]!.documentId })
    await c.retry(r)
    expect(r.body).toMatchObject({ status: 'succeeded', attempts: 4 })
    expect(created[1]!.eventId).toBe(created[0]!.eventId)
    const l = ctx()
    await c.list(l)
    expect(l.headers['Cache-Control']).toBe('private, no-store')
    expect(JSON.stringify(l.body)).not.toContain(secret)
    fetch.mockRestore()
  })
})
