import { describe, expect, it, vi } from 'vitest'
import { CRAWLER_HITS_SLUG } from './collection.js'
import { JOBS_SLUG, dataEndpoints, runCleanup, type DataContext } from './maintenance.js'

type Row = Record<string, any>

/** Payload with `less_than` / `greater_than*` / `equals` / `in` filters, sort, pages, count, delete. */
function fakePayload(tables: Record<string, Row[]>) {
  let nextId = 1000
  const ok = (r: Row, w: any): boolean => {
    if (!w) return true
    if (w.and) return w.and.every((x: any) => ok(r, x))
    return Object.entries(w).every(([k, c]: [string, any]) =>
      Object.entries(c).every(([op, v]: [string, any]) =>
        op === 'equals' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'less_than' ? r[k] < v : op === 'greater_than' ? r[k] > v : op === 'greater_than_equal' ? r[k] >= v : true,
      ),
    )
  }
  const table = (c: string) => (tables[c] ??= [])
  const sortBy = (rows: Row[], sort: any) => {
    const keys: string[] = sort ? (Array.isArray(sort) ? sort : [sort]) : []
    return [...rows].sort((a, b) => {
      for (const s of keys) {
        const k = s.replace(/^-/, '')
        const d = s.startsWith('-') ? -1 : 1
        if (a[k] < b[k]) return -d
        if (a[k] > b[k]) return d
      }
      return 0
    })
  }
  const payload = {
    logger: { warn: vi.fn() },
    find: vi.fn(async ({ collection, where, sort, limit = 10, page = 1 }: any) => ({ docs: sortBy(table(collection).filter((r) => ok(r, where)), sort).slice((page - 1) * limit, page * limit) })),
    count: vi.fn(async ({ collection, where }: any) => ({ totalDocs: table(collection).filter((r) => ok(r, where)).length })),
    create: vi.fn(async ({ collection, data }: any) => {
      const row = { id: nextId++, ...data }
      table(collection).push(row)
      return row
    }),
    update: vi.fn(async ({ collection, id, data }: any) => Object.assign(table(collection).find((r) => r.id === id)!, data)),
    delete: vi.fn(async ({ collection, where }: any) => {
      const keep = table(collection).filter((r) => !ok(r, where))
      tables[collection] = keep
      return { docs: [] }
    }),
  }
  return { payload, tables }
}

const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), path: i === 0 ? '=1+1' : `/p${i}`, ip: '203.0.113.9', botId: 'gptbot' }))
const ctx = (retention?: DataContext['retention']): DataContext => ({ retention, datasets: { hits: { slug: CRAWLER_HITS_SLUG, time: 'timestamp' } } })
const call = (endpoints: ReturnType<typeof dataEndpoints>, path: string, payload: unknown, init: { body?: unknown; query?: string; user?: unknown } = { user: { id: 1, email: 'a@b.c' } }) =>
  endpoints.find((e) => e.path === path)!.handler({ url: `http://cms.test/api${path}${init.query ?? ''}`, user: init.user, payload, json: async () => init.body } as never)
const admin = { id: 1, email: 'a@b.c' }

describe('data maintenance (Payload)', () => {
  it('previews by default, refuses to delete unless allowDelete, then deletes in batches with a job record', async () => {
    const { payload, tables } = fakePayload({ [CRAWLER_HITS_SLUG]: hits(1200) })
    const before = '2026-01-21T00:00:00.000Z' // the first 480 hits
    let res = await call(dataEndpoints(ctx()), '/geo/data/cleanup', payload, { user: admin, body: { dataset: 'hits', before } })
    expect(await res.json()).toMatchObject({ preview: true, count: 480, allowDelete: false })
    res = await call(dataEndpoints(ctx()), '/geo/data/cleanup', payload, { user: admin, body: { dataset: 'hits', before, confirm: true } })
    expect(res.status).toBe(403)
    expect(tables[CRAWLER_HITS_SLUG]).toHaveLength(1200)
    res = await call(dataEndpoints(ctx({ allowDelete: true, batchSize: 100 })), '/geo/data/cleanup', payload, { user: admin, body: { dataset: 'hits', before, confirm: true } })
    expect(await res.json()).toMatchObject({ deleted: 480 })
    expect(tables[CRAWLER_HITS_SLUG]).toHaveLength(720)
    expect(payload.delete).toHaveBeenCalledTimes(5)
    expect(tables[JOBS_SLUG]!.at(-1)).toMatchObject({ kind: 'cleanup', status: 'succeeded', deleted: 480, startedBy: 'a@b.c', before })
    expect((await call(dataEndpoints(ctx()), '/geo/data/cleanup', payload, { body: { dataset: 'hits', before } })).status).toBe(401)
  })

  it('refuses a second cleanup while one is running, and records failures', async () => {
    const { payload, tables } = fakePayload({ [CRAWLER_HITS_SLUG]: hits(10), [JOBS_SLUG]: [{ id: 1, kind: 'cleanup', dataset: 'hits', status: 'running', startedAt: new Date().toISOString() }] })
    const r = await runCleanup(payload as never, ctx({ allowDelete: true }), 'hits', new Date('2026-01-01T05:00:00Z'), null)
    expect(r.status).toBe(409)
    tables[JOBS_SLUG] = []
    payload.delete.mockRejectedValueOnce(new Error('disk full'))
    const failed = await runCleanup(payload as never, ctx({ allowDelete: true }), 'hits', new Date('2026-01-01T05:00:00Z'), null)
    expect(failed.status).toBe(500)
    expect(tables[JOBS_SLUG]!.at(-1)).toMatchObject({ status: 'failed', error: 'disk full', startedBy: 'auto cleanup' })
  })

  it('exports CSV without sensitive fields and with formulas escaped, page by page', async () => {
    const { payload } = fakePayload({ [CRAWLER_HITS_SLUG]: hits(2500) })
    const res = await call(dataEndpoints(ctx()), '/geo/data/export', payload, { user: admin, query: '?dataset=hits&format=csv' })
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="geo-hits-\d{4}-\d{2}-\d{2}\.csv"/)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    const lines = text.trim().split('\r\n')
    expect(lines).toHaveLength(2501)
    expect(lines[0]).not.toContain('ip')
    expect(text).not.toContain('203.0.113.9')
    expect(lines[1]).toContain("'=1+1")
    const json = await (await call(dataEndpoints(ctx()), '/geo/data/export', payload, { user: admin, query: '?dataset=hits&format=json&sensitive=1&from=2026-01-02T00:00:00Z&to=2026-01-03T00:00:00Z' })).json()
    expect(json).toHaveLength(24)
    expect(json[0].ip).toBe('203.0.113.9')
    expect((await call(dataEndpoints(ctx()), '/geo/data/export', payload, { query: '?dataset=hits' })).status).toBe(401)
    expect((await call(dataEndpoints(ctx()), '/geo/data/export', payload, { user: admin, query: '?dataset=referrals' })).status).toBe(404)
  })

  it('reports counts, retention and recent jobs', async () => {
    const { payload } = fakePayload({ [CRAWLER_HITS_SLUG]: hits(5) })
    const body = await (await call(dataEndpoints(ctx({ hitsDays: 30 })), '/geo/data', payload)).json()
    expect(body).toMatchObject({ allowDelete: false, datasets: [{ dataset: 'hits', total: 5, retentionDays: 30, olderThanCutoff: 5 }] })
  })
})
