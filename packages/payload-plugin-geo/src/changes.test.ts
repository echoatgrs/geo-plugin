import { describe, expect, it, vi } from 'vitest'
import type { Config } from 'payload'
import { geoPlugin } from './index.js'
import { INVALIDATIONS_SLUG } from './changes.js'

type Doc = Record<string, any>

/** In-memory Payload: published filter, `id equals`, featured filter, sort by createdAt then id, pages. */
function fakePayload(docs: Doc[]) {
  const created: Doc[] = []
  const matches = (d: Doc, where: any): boolean => {
    if (!where) return true
    if (where.and) return where.and.every((w: any) => matches(d, w))
    return Object.entries(where).every(([k, v]: [string, any]) => d[k] === v.equals)
  }
  const sorted = (list: Doc[], sort: string[]) =>
    [...list].sort((a, b) => {
      for (const s of sort) {
        const k = s.replace(/^-/, '')
        const dir = s.startsWith('-') ? -1 : 1
        if (a[k] < b[k]) return -dir
        if (a[k] > b[k]) return dir
      }
      return 0
    })
  const payload = {
    logger: { warn: vi.fn() },
    find: vi.fn(async ({ collection, where, limit = 10, page = 1, sort = ['id'] }: any) => {
      if (collection === INVALIDATIONS_SLUG) return { docs: created }
      const list = sorted(docs.filter((d) => matches(d, where)), Array.isArray(sort) ? sort : [sort])
      return { docs: list.slice((page - 1) * limit, page * limit) }
    }),
    count: vi.fn(async ({ where }: any) => ({ totalDocs: docs.filter((d) => matches(d, where)).length })),
    create: vi.fn(async ({ data }: any) => {
      created.push(data)
      return data
    }),
  }
  return { payload, created }
}

const posts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Post ${i + 1}`,
    slug: `p${i + 1}`,
    _status: i % 10 === 9 ? 'draft' : 'published',
    createdAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 3) * 86400_000).toISOString(),
    updatedAt: '2026-11-01T00:00:00.000Z',
    featured: i === 4,
  }))

const base = { collections: [{ slug: 'posts', fields: [{ name: 'slug', type: 'text' }], versions: { drafts: true } }], endpoints: [] } as unknown as Config
const llms = { siteURL: 'https://site.test', name: 'Acme', collections: { posts: { section: 'Blog', url: (d: Doc) => `/blog/${d.slug}`, featured: 'featured' } } }
const endpoint = (config: Config, path: string) => config.endpoints!.find((e) => e.path === path)!
const call = (config: Config, path: string, payload: unknown, extra: Doc = {}) =>
  endpoint(config, path).handler({ url: `http://cms.test/api${path}`, headers: new Headers(), payload, ...extra } as never)

describe('llms listing and segments', () => {
  it('reads past the first page of 100 without duplicates', async () => {
    const config = geoPlugin({ verifyIPs: false, llms })(base)
    const { payload } = fakePayload(posts(250))
    const text = await (await call(config, '/geo/llms.txt', payload)).text()
    const urls = [...text.matchAll(/\/blog\/(p\d+)\)/g)].map((m) => m[1])
    expect(urls).toHaveLength(225)
    expect(new Set(urls).size).toBe(225)
    expect(text).not.toContain('/blog/p10)')
  })

  it('notes a limit that cuts the list', async () => {
    const config = geoPlugin({ verifyIPs: false, llms: { ...llms, collections: { posts: { ...llms.collections.posts, limit: 50 } } } })(base)
    const { payload } = fakePayload(posts(250))
    expect(await (await call(config, '/geo/llms.txt', payload)).text()).toContain('Lists 50 of 225 entries')
  })

  it('serves a segment index and parts that cover every public entry once', async () => {
    const config = geoPlugin({ verifyIPs: false, llms: { ...llms, segments: { enabled: true, size: 100 } } })(base)
    const { payload } = fakePayload(posts(250))
    const index = await (await call(config, '/geo/llms.txt', payload)).text()
    expect(index).toContain('https://site.test/llms/posts-3.txt')
    expect(index).not.toContain('posts-4.txt')
    expect(index).toContain('## Featured')
    const seen: string[] = []
    for (const n of [1, 2, 3]) {
      const res = await call(config, '/geo/llms/:file', payload, { routeParams: { file: `posts-${n}.txt` } })
      expect(res.status).toBe(200)
      seen.push(...[...(await res.text()).matchAll(/\/blog\/(p\d+)\)/g)].map((m) => m[1]!))
    }
    expect(seen).toHaveLength(225)
    expect(new Set(seen).size).toBe(225)
    const missing = await call(config, '/geo/llms/:file', payload, { routeParams: { file: 'posts-4.txt' } })
    expect(missing.status).toBe(404)
    expect((await call(config, '/geo/llms/:file', payload, { routeParams: { file: '../etc-1.txt' } })).status).toBe(404)
  })

  it('uses notFoundMaxAge for 404s', async () => {
    const config = geoPlugin({ verifyIPs: false, llms: { ...llms, cacheMaxAge: 600, notFoundMaxAge: 30, segments: { enabled: true } } })(base)
    const { payload } = fakePayload(posts(5))
    const res = await call(config, '/geo/llms/:file', payload, { routeParams: { file: 'posts-9.txt' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toContain('max-age=30')
  })
})

describe('invalidation hooks', () => {
  const secret = 'x'.repeat(32)
  const invalidation = { targets: [{ name: 'frontend', url: 'https://site.test/api/revalidate', secret }] }

  it('adds hooks, the delivery collection and admin routes only when targets are set', () => {
    const off = geoPlugin({ verifyIPs: false, llms })(base)
    expect(off.collections!.map((c) => c.slug)).not.toContain(INVALIDATIONS_SLUG)
    expect(off.collections![0]!.hooks?.afterChange).toBeUndefined()
    const on = geoPlugin({ verifyIPs: false, llms, invalidation })(base)
    expect(on.collections!.map((c) => c.slug)).toContain(INVALIDATIONS_SLUG)
    expect(on.collections![0]!.hooks?.afterChange).toHaveLength(1)
    expect(on.endpoints!.map((e) => e.path)).toEqual(expect.arrayContaining(['/geo/invalidations', '/geo/invalidations/retry', '/geo/invalidations/flush']))
    expect(() => geoPlugin({ llms, invalidation: { targets: [{ name: 'a', url: 'https://x.test', secret: 'short' }] } })(base)).toThrow(/16 characters/)
  })

  it('reads the public state before and after and sends publish / update / unpublish / delete', async () => {
    const config = geoPlugin({ verifyIPs: false, llms, invalidation: { ...invalidation, allowPrivateNetwork: true } })(base)
    const hooks = config.collections![0]!.hooks!
    const docs = posts(3)
    const { payload, created } = fakePayload(docs)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    // Deliveries run in the background (and sign with WebCrypto): wait for each one before the next change.
    const settle = async (expected: number) => {
      await new Promise((r) => setTimeout(r, 20))
      await vi.waitFor(() => expect(created).toHaveLength(expected))
    }
    const update = async (id: number, change: (d: Doc) => void, expected: number) => {
      const context: Doc = {}
      const req = { payload, context }
      const doc = docs.find((d) => d.id === id)!
      await hooks.beforeChange![0]!({ data: {}, originalDoc: { ...doc }, operation: 'update', req, context } as never)
      change(doc)
      await hooks.afterChange![0]!({ doc, req, context, operation: 'update' } as never)
      await settle(expected)
    }
    // A draft saved over a draft: nothing public changed.
    docs[2]!._status = 'draft'
    await update(3, (d) => (d.title = 'still draft'), 0)
    expect(fetch).not.toHaveBeenCalled()
    await update(3, (d) => (d._status = 'published'), 1)
    await update(3, (d) => (d.slug = 'renamed'), 2)
    await update(3, (d) => (d._status = 'draft'), 3)
    const context: Doc = {}
    await hooks.beforeDelete![0]!({ id: 1, req: { payload, context }, context } as never)
    docs.splice(0, 1)
    await hooks.afterDelete![0]!({ id: 1, doc: {}, req: { payload, context }, context } as never)
    await settle(4)
    expect(created.map((r) => r.eventType)).toEqual(['publish', 'update', 'unpublish', 'delete'])
    expect(created[1]!.event).toMatchObject({ previousPath: '/blog/p3', path: '/blog/renamed' })
    expect(created[3]!.event.paths).toContain('/blog/p1.md')
    expect(created.every((r) => r.status === 'succeeded')).toBe(true)
    fetch.mockRestore()
  })

  it('a failed notice is recorded and never fails the save', async () => {
    const config = geoPlugin({ verifyIPs: false, llms, invalidation: { ...invalidation, retries: 0, allowPrivateNetwork: true } })(base)
    const hooks = config.collections![0]!.hooks!
    const docs = posts(1)
    const { payload, created } = fakePayload(docs)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const context: Doc = {}
    const out = await hooks.afterChange![0]!({ doc: docs[0], req: { payload, context }, context, operation: 'create' } as never)
    expect(out).toBe(docs[0])
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ status: 'failed', eventType: 'publish', lastError: 'ECONNREFUSED' })
    fetch.mockRestore()
  })

  it('admin routes need a user', async () => {
    const config = geoPlugin({ verifyIPs: false, llms, invalidation })(base)
    const { payload } = fakePayload([])
    expect((await call(config, '/geo/invalidations', payload)).status).toBe(401)
    expect((await call(config, '/geo/invalidations/flush', payload)).status).toBe(401)
    const list = await call(config, '/geo/invalidations', payload, { user: { id: 1 } })
    expect(await list.json()).toMatchObject({ targets: [{ name: 'frontend', events: 'all' }], deliveries: [] })
    expect(JSON.stringify(await (await call(config, '/geo/invalidations', payload, { user: { id: 1 } })).json())).not.toContain(secret)
  })
})
