import {
  CleanupLock,
  DATASETS,
  exportFileName,
  exportStream,
  historyIncomplete,
  parseCleanupRequest,
  parseExportRequest,
  retentionCutoff,
  runBatchedCleanup,
  type Dataset,
  type RetentionOptions,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Endpoint, Payload, PayloadRequest, Where } from 'payload'

export const JOBS_SLUG = 'geo-jobs'
const noStore = { 'cache-control': 'private, no-store' }
/** A job still "running" after this long is treated as abandoned (the process stopped mid-way). */
const STALE_MS = 3600_000

/** Records of cleanups and exports, shown in the dashboard's Data tab. Written by the plugin only. */
export function jobsCollection(): CollectionConfig {
  return {
    slug: JOBS_SLUG,
    labels: { singular: 'GEO Data Job', plural: 'GEO Data Jobs' },
    admin: {
      group: 'GEO',
      useAsTitle: 'kind',
      defaultColumns: ['startedAt', 'kind', 'dataset', 'status', 'deleted', 'before', 'startedBy'],
      description: 'Cleanups and exports of GEO data. Deleting is off unless `retention.allowDelete` is set.',
    },
    access: { read: ({ req }) => Boolean(req.user), create: () => false, update: () => false, delete: () => false },
    fields: [
      { name: 'kind', type: 'select', required: true, options: ['cleanup', 'export'] },
      { name: 'dataset', type: 'select', required: true, index: true, options: [...DATASETS] },
      { name: 'status', type: 'select', required: true, index: true, options: ['running', 'succeeded', 'failed'] },
      { name: 'before', type: 'date' },
      { name: 'deleted', type: 'number' },
      { name: 'startedBy', type: 'text' },
      { name: 'startedAt', type: 'date', required: true, index: true },
      { name: 'finishedAt', type: 'date' },
      { name: 'error', type: 'text' },
    ],
  }
}

export interface DataContext {
  retention?: RetentionOptions
  /** Collection slug and time field of each dataset that exists in this config. */
  datasets: Partial<Record<Dataset, { slug: string; time: string }>>
}

const lock = new CleanupLock()

function who(req: PayloadRequest | null): string {
  const u = req?.user as { email?: string; id?: unknown } | null | undefined
  return u ? (u.email ?? `user ${String(u.id)}`) : 'auto cleanup'
}

async function lastCleanup(payload: Payload, dataset: Dataset): Promise<string | null> {
  const r = await payload.find({
    collection: JOBS_SLUG as never,
    where: { and: [{ kind: { equals: 'cleanup' } }, { dataset: { equals: dataset } }, { status: { equals: 'succeeded' } }] },
    sort: '-before',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return ((r.docs[0] as { before?: string } | undefined)?.before as string | undefined) ?? null
}

/** For the stats endpoint: whether the window reaches before the last hits cleanup. */
export async function hitsHistoryIncomplete(payload: Payload, windowStart: Date): Promise<{ historyIncomplete: boolean; deletedBefore: string | null }> {
  try {
    const before = await lastCleanup(payload, 'hits')
    return { historyIncomplete: historyIncomplete(windowStart, before), deletedBefore: before }
  } catch {
    return { historyIncomplete: false, deletedBefore: null }
  }
}

async function countOlder(payload: Payload, ds: { slug: string; time: string }, before: Date): Promise<number> {
  return (await payload.count({ collection: ds.slug as never, where: { [ds.time]: { less_than: before.toISOString() } }, overrideAccess: true })).totalDocs
}

/**
 * Deletes rows older than `before`, in batches, with a job record. One cleanup per dataset at a time: an
 * in-process lock, plus a check for a running job record from another process.
 */
export async function runCleanup(payload: Payload, ctx: DataContext, dataset: Dataset, before: Date, req: PayloadRequest | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const ds = ctx.datasets[dataset]
  if (!ds) return { status: 404, body: { error: `${dataset} is not enabled` } }
  if (!ctx.retention?.allowDelete) return { status: 403, body: { error: 'Deleting is off. Set `retention.allowDelete: true` (after a backup) to allow it.' } }
  if (!lock.acquire(dataset)) return { status: 409, body: { error: 'A cleanup of this dataset is already running.' } }
  let jobId: string | number | undefined
  try {
    const running = await payload.find({
      collection: JOBS_SLUG as never,
      where: { and: [{ dataset: { equals: dataset } }, { status: { equals: 'running' } }, { kind: { equals: 'cleanup' } }, { startedAt: { greater_than: new Date(Date.now() - STALE_MS).toISOString() } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (running.docs.length) return { status: 409, body: { error: 'A cleanup of this dataset is already running.' } }
    const job = (await payload.create({
      collection: JOBS_SLUG as never,
      overrideAccess: true,
      data: { kind: 'cleanup', dataset, status: 'running', before: before.toISOString(), startedBy: who(req), startedAt: new Date().toISOString() } as never,
    })) as { id: string | number }
    jobId = job.id
    const where: Where = { [ds.time]: { less_than: before.toISOString() } }
    const deleted = await runBatchedCleanup(
      async (limit) => {
        const batch = await payload.find({ collection: ds.slug as never, where, limit, depth: 0, sort: ds.time, select: { id: true } as never, overrideAccess: true })
        if (!batch.docs.length) return 0
        const ids = (batch.docs as { id: string | number }[]).map((d) => d.id)
        await payload.delete({ collection: ds.slug as never, where: { id: { in: ids } }, overrideAccess: true })
        return ids.length
      },
      { batchSize: ctx.retention.batchSize },
    )
    await payload.update({ collection: JOBS_SLUG as never, id: jobId as never, overrideAccess: true, data: { status: 'succeeded', deleted, finishedAt: new Date().toISOString() } as never })
    return { status: 200, body: { dataset, before: before.toISOString(), deleted, jobId } }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 500)
    if (jobId !== undefined) {
      await payload
        .update({ collection: JOBS_SLUG as never, id: jobId as never, overrideAccess: true, data: { status: 'failed', error: message, finishedAt: new Date().toISOString() } as never })
        .catch(() => {})
    }
    return { status: 500, body: { error: message, jobId } }
  } finally {
    lock.release(dataset)
  }
}

/** Daily cleanup by the retention days, when `retention.autoCleanup` (and `allowDelete`) is set. */
export function startAutoCleanup(payload: Payload, ctx: DataContext, intervalMs = 86_400_000): (() => void) | null {
  if (!ctx.retention?.autoCleanup || !ctx.retention.allowDelete) return null
  const run = async () => {
    for (const dataset of DATASETS) {
      const cutoff = retentionCutoff(ctx.retention, dataset)
      if (!cutoff || !ctx.datasets[dataset]) continue
      const result = await runCleanup(payload, ctx, dataset, cutoff, null)
      if (result.status !== 200 && result.status !== 409) payload.logger.warn(`[geo] auto cleanup of ${dataset} failed: ${result.body.error}`)
    }
  }
  const first = setTimeout(() => void run(), 60_000)
  const timer = setInterval(() => void run(), intervalMs)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

export function dataEndpoints(ctx: DataContext): Endpoint[] {
  const needUser = (req: PayloadRequest) => (req.user ? null : Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore }))
  return [
    {
      path: '/geo/data',
      method: 'get',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const datasets = []
        for (const dataset of DATASETS) {
          const ds = ctx.datasets[dataset]
          if (!ds) continue
          const cutoff = retentionCutoff(ctx.retention, dataset)
          const [total, oldest, older, last] = await Promise.all([
            req.payload.count({ collection: ds.slug as never, overrideAccess: true }).then((r) => r.totalDocs),
            req.payload.find({ collection: ds.slug as never, sort: ds.time, limit: 1, depth: 0, overrideAccess: true }).then((r) => (r.docs[0] as Record<string, any> | undefined)?.[ds.time] ?? null),
            cutoff ? countOlder(req.payload, ds, cutoff) : Promise.resolve(null),
            lastCleanup(req.payload, dataset),
          ])
          datasets.push({ dataset, total, oldest, retentionDays: ctx.retention?.[`${dataset}Days` as 'hitsDays'] ?? null, cutoff: cutoff?.toISOString() ?? null, olderThanCutoff: older, deletedBefore: last })
        }
        const jobs = await req.payload.find({ collection: JOBS_SLUG as never, sort: '-startedAt', limit: 20, depth: 0, overrideAccess: true })
        return Response.json(
          { allowDelete: !!ctx.retention?.allowDelete, autoCleanup: !!ctx.retention?.autoCleanup, datasets, jobs: jobs.docs },
          { headers: noStore },
        )
      },
    },
    {
      path: '/geo/data/cleanup',
      method: 'post',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const parsed = parseCleanupRequest(await req.json?.().catch(() => null), ctx.retention)
        if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400, headers: noStore })
        const ds = ctx.datasets[parsed.dataset]
        if (!ds) return Response.json({ error: `${parsed.dataset} is not enabled` }, { status: 404, headers: noStore })
        if (!parsed.confirm) {
          // Preview: what a confirmed cleanup would delete. Nothing is changed.
          const count = await countOlder(req.payload, ds, parsed.before)
          return Response.json({ preview: true, dataset: parsed.dataset, before: parsed.before.toISOString(), count, allowDelete: !!ctx.retention?.allowDelete }, { headers: noStore })
        }
        const result = await runCleanup(req.payload, ctx, parsed.dataset, parsed.before, req)
        return Response.json(result.body, { status: result.status, headers: noStore })
      },
    },
    {
      path: '/geo/data/export',
      method: 'get',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const parsed = parseExportRequest(new URL(req.url ?? '', 'http://x').searchParams)
        if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400, headers: noStore })
        const ds = ctx.datasets[parsed.dataset]
        if (!ds) return Response.json({ error: `${parsed.dataset} is not enabled` }, { status: 404, headers: noStore })
        const range: Where[] = []
        if (parsed.from) range.push({ [ds.time]: { greater_than_equal: parsed.from.toISOString() } })
        if (parsed.to) range.push({ [ds.time]: { less_than: parsed.to.toISOString() } })
        const payload = req.payload
        await payload
          .create({ collection: JOBS_SLUG as never, overrideAccess: true, data: { kind: 'export', dataset: parsed.dataset, status: 'succeeded', startedBy: who(req), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } as never })
          .catch(() => {})
        const pageSize = 1000
        const stream = exportStream(
          parsed,
          async (offset, limit) =>
            (await payload.find({ collection: ds.slug as never, where: range.length ? { and: range } : undefined, sort: [ds.time, 'id'] as never, limit, page: Math.floor(offset / limit) + 1, depth: 0, overrideAccess: true })).docs as Record<string, unknown>[],
          pageSize,
        )
        return new Response(stream, {
          headers: {
            ...noStore,
            'content-type': parsed.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${exportFileName(parsed)}"`,
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
  ]
}
