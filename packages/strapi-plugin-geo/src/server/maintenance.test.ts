import { describe, expect, it, vi } from 'vitest'
import { CRAWLER_HIT_UID, controllers, routes } from './index'
import { JOB_UID } from './maintenance'
import type { KoaContextLike, StrapiLike } from './types'

type Row = Record<string, any>

/** Query Engine with `$lt` / `$gt` / `$gte` / `$in` / equality, orderBy, offset / limit, count, deleteMany. */
function fakeStrapi(config: Record<string, unknown>, tables: Record<string, Row[]>) {
  let nextId = 1000
  const ok = (r: Row, w: any): boolean =>
    !w ||
    Object.entries(w).every(([k, c]: [string, any]) =>
      c && typeof c === 'object' && !Array.isArray(c)
        ? Object.entries(c).every(([op, v]: [string, any]) => (op === '$lt' ? r[k] < v : op === '$gt' ? r[k] > v : op === '$gte' ? r[k] >= v : op === '$in' ? v.includes(r[k]) : true))
        : r[k] === c,
    )
  const table = (uid: string) => (tables[uid] ??= [])
  const order = (rows: Row[], orderBy: any) => {
    const keys: [string, string][] = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: Row) => Object.entries(o))
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const d = dir === 'desc' ? -1 : 1
        if (a[k] < b[k]) return -d
        if (a[k] > b[k]) return d
      }
      return 0
    })
  }
  const deleteMany = vi.fn(async (uid: string, { where }: any) => {
    const before = table(uid).length
    tables[uid] = table(uid).filter((r) => !ok(r, where))
    return { count: before - tables[uid]!.length }
  })
  const strapi = {
    plugin: () => ({ config: <T,>(key: string, fallback?: T) => (key in config ? config[key] : fallback) as T }),
    documents: () => ({ create: async () => ({}), findMany: async () => [] }),
    log: { warn: vi.fn(), info: vi.fn() },
    db: {
      query: (uid: string) => ({
        findMany: async ({ where, orderBy, offset = 0, limit = 100 }: any = {}) => order(table(uid).filter((r) => ok(r, where)), orderBy).slice(offset, offset + limit),
        findOne: async ({ where }: any) => table(uid).find((r) => ok(r, where)) ?? null,
        count: async ({ where }: any = {}) => table(uid).filter((r) => ok(r, where)).length,
        create: async ({ data }: any) => {
          const row = { id: nextId++, ...data }
          table(uid).push(row)
          return row
        },
        update: async ({ where, data }: any) => Object.assign(table(uid).find((r) => ok(r, where))!, data),
        deleteMany: (p: any) => deleteMany(uid, p),
      }),
    },
  } as unknown as StrapiLike
  return { strapi, tables, deleteMany }
}

const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), path: i === 0 ? '@SUM(A1)' : `/p${i}`, ip: '203.0.113.9' }))
function ctx(body?: unknown, query: Record<string, unknown> = {}): KoaContextLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return { request: { body, get: () => '' }, query, state: { user: { email: 'admin@site.test' } } as never, status: 404, body: undefined, headers, set: (k, v) => void (headers[k] = v) }
}

describe('data maintenance (Strapi)', () => {
  it('admin-only routes', () => {
    const data = routes.admin.routes.filter((r) => r.path.startsWith('/data'))
    expect(data.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /data', 'POST /data/cleanup', 'GET /data/export'])
    expect(data.every((r) => r.config.policies.includes('admin::isAuthenticatedAdmin'))).toBe(true)
  })

  it('previews, refuses without allowDelete, deletes in batches with a job record', async () => {
    const before = '2026-01-21T00:00:00.000Z'
    const { strapi, tables, deleteMany } = fakeStrapi({}, { [CRAWLER_HIT_UID]: hits(1200) })
    const c = ctx({ dataset: 'hits', before })
    await controllers.data({ strapi }).cleanup(c)
    expect(c.body).toMatchObject({ preview: true, count: 480, allowDelete: false })
    const refused = ctx({ dataset: 'hits', before, confirm: true })
    await controllers.data({ strapi }).cleanup(refused)
    expect(refused.status).toBe(403)
    const allowed = fakeStrapi({ retention: { allowDelete: true, batchSize: 200 } }, { [CRAWLER_HIT_UID]: hits(1200) })
    const run = ctx({ dataset: 'hits', before, confirm: true })
    await controllers.data({ strapi: allowed.strapi }).cleanup(run)
    expect(run.body).toMatchObject({ deleted: 480 })
    expect(allowed.tables[CRAWLER_HIT_UID]).toHaveLength(720)
    expect(allowed.deleteMany).toHaveBeenCalledTimes(3)
    expect(allowed.tables[JOB_UID]!.at(-1)).toMatchObject({ kind: 'cleanup', status: 'succeeded', deleted: 480, startedBy: 'admin@site.test' })
    expect(tables[CRAWLER_HIT_UID]).toHaveLength(1200)
    expect(deleteMany).not.toHaveBeenCalled()

    const stats = ctx(undefined, { days: '365' })
    await controllers.stats({ strapi: allowed.strapi }).stats(stats)
    expect(stats.body).toMatchObject({ historyIncomplete: true, deletedBefore: before })
  })

  it('exports a CSV stream without sensitive fields, formulas escaped', async () => {
    const { strapi } = fakeStrapi({}, { [CRAWLER_HIT_UID]: hits(1500) })
    const c = ctx(undefined, { dataset: 'hits', format: 'csv' })
    await controllers.data({ strapi }).export(c)
    expect(c.headers['Content-Disposition']).toMatch(/geo-hits-.*\.csv/)
    const chunks: Buffer[] = []
    for await (const chunk of c.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    expect(text.trim().split('\r\n')).toHaveLength(1501)
    expect(text).not.toContain('203.0.113.9')
    expect(text).toContain("'@SUM(A1)")
    const bad = ctx(undefined, { dataset: 'hits', fields: 'ip' })
    await controllers.data({ strapi }).export(bad)
    expect(bad.status).toBe(400)
  })

  it('reports datasets and validates retention config', async () => {
    const { strapi } = fakeStrapi({ retention: { hitsDays: 30 } }, { [CRAWLER_HIT_UID]: hits(3) })
    const c = ctx()
    await controllers.data({ strapi }).report(c)
    expect(c.body).toMatchObject({ allowDelete: false, datasets: [{ dataset: 'hits', total: 3, retentionDays: 30, olderThanCutoff: 3 }] })
    const { default: plugin } = await import('./index')
    expect(() => plugin.config.validator({ retention: { autoCleanup: true } })).toThrow(/allowDelete/)
  })
})
