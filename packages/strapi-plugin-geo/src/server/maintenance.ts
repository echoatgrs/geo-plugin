import { Readable } from 'node:stream'
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
import type { KoaContextLike, StrapiLike } from './types'

export const JOB_UID = 'plugin::geo.job'
const STALE_MS = 3600_000

export interface DataContext {
  retention?: RetentionOptions
  /** Content type UID and time attribute of each dataset that is enabled. */
  datasets: Partial<Record<Dataset, { uid: string; time: string }>>
}

interface Query {
  findMany(params: Record<string, unknown>): Promise<Record<string, any>[]>
  findOne(params: Record<string, unknown>): Promise<Record<string, any> | null>
  count(params?: Record<string, unknown>): Promise<number>
  create(params: { data: Record<string, unknown> }): Promise<Record<string, any>>
  update(params: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
  deleteMany(params: { where: Record<string, unknown> }): Promise<{ count: number }>
}

// The Query Engine: these are the plugin's own tables (no draft & publish), and bulk deletes need it.
const q = (strapi: StrapiLike, uid: string) => (strapi.db as unknown as { query(uid: string): Query }).query(uid)
const lock = new CleanupLock()
const NO_STORE = 'private, no-store'

function who(ctx: KoaContextLike | null): string {
  const u = (ctx?.state as { user?: { email?: string; id?: unknown } } | undefined)?.user
  return u ? (u.email ?? `user ${String(u.id)}`) : 'auto cleanup'
}

async function lastCleanup(strapi: StrapiLike, dataset: Dataset): Promise<string | null> {
  const [row] = await q(strapi, JOB_UID).findMany({ where: { kind: 'cleanup', dataset, status: 'succeeded' }, orderBy: { before: 'desc' }, limit: 1 })
  return row?.before ? new Date(row.before).toISOString() : null
}

export async function hitsHistoryIncomplete(strapi: StrapiLike, windowStart: Date) {
  try {
    const before = await lastCleanup(strapi, 'hits')
    return { historyIncomplete: historyIncomplete(windowStart, before), deletedBefore: before }
  } catch {
    return { historyIncomplete: false, deletedBefore: null }
  }
}

const older = (ds: { time: string }, before: Date) => ({ [ds.time]: { $lt: before.toISOString() } })

export async function runCleanup(strapi: StrapiLike, ctx: DataContext, dataset: Dataset, before: Date, koa: KoaContextLike | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const ds = ctx.datasets[dataset]
  if (!ds) return { status: 404, body: { error: `${dataset} is not enabled` } }
  if (!ctx.retention?.allowDelete) return { status: 403, body: { error: 'Deleting is off. Set `retention.allowDelete: true` (after a backup) to allow it.' } }
  if (!lock.acquire(dataset)) return { status: 409, body: { error: 'A cleanup of this dataset is already running.' } }
  let jobId: number | undefined
  try {
    const running = await q(strapi, JOB_UID).count({ where: { kind: 'cleanup', dataset, status: 'running', startedAt: { $gt: new Date(Date.now() - STALE_MS).toISOString() } } })
    if (running) return { status: 409, body: { error: 'A cleanup of this dataset is already running.' } }
    const job = await q(strapi, JOB_UID).create({ data: { kind: 'cleanup', dataset, status: 'running', before: before.toISOString(), startedBy: who(koa), startedAt: new Date().toISOString() } })
    jobId = job.id
    const deleted = await runBatchedCleanup(
      async (limit) => {
        const rows = await q(strapi, ds.uid).findMany({ where: older(ds, before), orderBy: { [ds.time]: 'asc' }, limit, select: ['id'] })
        if (!rows.length) return 0
        await q(strapi, ds.uid).deleteMany({ where: { id: { $in: rows.map((r) => r.id) } } })
        return rows.length
      },
      { batchSize: ctx.retention.batchSize },
    )
    await q(strapi, JOB_UID).update({ where: { id: jobId }, data: { status: 'succeeded', deleted, finishedAt: new Date().toISOString() } })
    return { status: 200, body: { dataset, before: before.toISOString(), deleted, jobId } }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 500)
    if (jobId !== undefined) await q(strapi, JOB_UID).update({ where: { id: jobId }, data: { status: 'failed', error: message, finishedAt: new Date().toISOString() } }).catch(() => {})
    return { status: 500, body: { error: message, jobId } }
  } finally {
    lock.release(dataset)
  }
}

export function startAutoCleanup(strapi: StrapiLike, ctx: DataContext, intervalMs = 86_400_000): (() => void) | null {
  if (!ctx.retention?.autoCleanup || !ctx.retention.allowDelete) return null
  const run = async () => {
    for (const dataset of DATASETS) {
      const cutoff = retentionCutoff(ctx.retention, dataset)
      if (!cutoff || !ctx.datasets[dataset]) continue
      const r = await runCleanup(strapi, ctx, dataset, cutoff, null)
      if (r.status !== 200 && r.status !== 409) strapi.log.warn(`[geo] auto cleanup of ${dataset} failed: ${r.body.error}`)
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

export function dataControllers(strapi: StrapiLike, context: () => DataContext) {
  const json = (ctx: KoaContextLike, status: number, body: unknown) => {
    ctx.set?.('Cache-Control', NO_STORE)
    ctx.status = status
    ctx.body = body
  }
  return {
    async report(ctx: KoaContextLike) {
      const c = context()
      const datasets = []
      for (const dataset of DATASETS) {
        const ds = c.datasets[dataset]
        if (!ds) continue
        const cutoff = retentionCutoff(c.retention, dataset)
        const [total, first, olderCount, last] = await Promise.all([
          q(strapi, ds.uid).count(),
          q(strapi, ds.uid).findMany({ orderBy: { [ds.time]: 'asc' }, limit: 1, select: [ds.time] }),
          cutoff ? q(strapi, ds.uid).count({ where: older(ds, cutoff) }) : Promise.resolve(null),
          lastCleanup(strapi, dataset),
        ])
        datasets.push({ dataset, total, oldest: first[0]?.[ds.time] ?? null, retentionDays: c.retention?.[`${dataset}Days` as 'hitsDays'] ?? null, cutoff: cutoff?.toISOString() ?? null, olderThanCutoff: olderCount, deletedBefore: last })
      }
      const jobs = await q(strapi, JOB_UID).findMany({ orderBy: { startedAt: 'desc' }, limit: 20 })
      json(ctx, 200, { allowDelete: !!c.retention?.allowDelete, autoCleanup: !!c.retention?.autoCleanup, datasets, jobs })
    },
    async cleanup(ctx: KoaContextLike) {
      const c = context()
      const parsed = parseCleanupRequest(ctx.request.body, c.retention)
      if ('error' in parsed) return json(ctx, 400, { error: parsed.error })
      const ds = c.datasets[parsed.dataset]
      if (!ds) return json(ctx, 404, { error: `${parsed.dataset} is not enabled` })
      if (!parsed.confirm) {
        const count = await q(strapi, ds.uid).count({ where: older(ds, parsed.before) })
        return json(ctx, 200, { preview: true, dataset: parsed.dataset, before: parsed.before.toISOString(), count, allowDelete: !!c.retention?.allowDelete })
      }
      const r = await runCleanup(strapi, c, parsed.dataset, parsed.before, ctx)
      json(ctx, r.status, r.body)
    },
    async export(ctx: KoaContextLike) {
      const c = context()
      const parsed = parseExportRequest((ctx.query ?? {}) as Record<string, unknown>)
      if ('error' in parsed) return json(ctx, 400, { error: parsed.error })
      const ds = c.datasets[parsed.dataset]
      if (!ds) return json(ctx, 404, { error: `${parsed.dataset} is not enabled` })
      const where: Record<string, unknown> = {}
      const range: Record<string, string> = {}
      if (parsed.from) range.$gte = parsed.from.toISOString()
      if (parsed.to) range.$lt = parsed.to.toISOString()
      if (Object.keys(range).length) where[ds.time] = range
      await q(strapi, JOB_UID)
        .create({ data: { kind: 'export', dataset: parsed.dataset, status: 'succeeded', startedBy: who(ctx), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } })
        .catch(() => {})
      const stream = exportStream(parsed, (offset, limit) => q(strapi, ds.uid).findMany({ where, orderBy: [{ [ds.time]: 'asc' }, { id: 'asc' }], offset, limit }), 1000)
      ctx.set?.('Cache-Control', NO_STORE)
      ctx.set?.('Content-Type', parsed.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      ctx.set?.('Content-Disposition', `attachment; filename="${exportFileName(parsed)}"`)
      ctx.set?.('X-Content-Type-Options', 'nosniff')
      ctx.status = 200
      ctx.body = Readable.fromWeb(stream as never)
    },
  }
}
