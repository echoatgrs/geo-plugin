/**
 * Local data maintenance: retention, batched cleanup and export of the data the plugins store
 * (crawler hits, AI referrals, cache notices).
 *
 * Deleting is off by default. Nothing is removed unless `retention.allowDelete` is true, and even then a cleanup
 * runs only on an explicit confirm (or `autoCleanup`). Back up the database first: deleted rows can't be restored
 * by the plugin. Stats over a window that reaches before the last cleanup say that their history is incomplete.
 */

export type Dataset = 'hits' | 'referrals' | 'invalidations'
export const DATASETS: readonly Dataset[] = ['hits', 'referrals', 'invalidations']

export interface RetentionOptions {
  /** Days to keep crawler hits. Unset: keep forever. */
  hitsDays?: number
  /** Days to keep AI referral visits. Unset: keep forever. */
  referralsDays?: number
  /** Days to keep cache notice records. Unset: keep forever. */
  invalidationsDays?: number
  /** Allow deleting at all (dashboard cleanup and `autoCleanup`). Default false: preview only. */
  allowDelete?: boolean
  /** Delete data older than the retention days once a day, in the CMS process. Needs `allowDelete`. Default false. */
  autoCleanup?: boolean
  /** Rows per delete query. Default 500, at most 5000. */
  batchSize?: number
}

export function validateRetention(options: RetentionOptions | undefined): void {
  if (!options) return
  for (const key of ['hitsDays', 'referralsDays', 'invalidationsDays'] as const) {
    const v = options[key]
    if (v !== undefined && !(Number.isInteger(v) && v >= 1)) throw new TypeError(`[geo] retention.${key} must be a whole number of days (at least 1)`)
  }
  if (options.autoCleanup && !options.allowDelete) throw new TypeError('[geo] retention.autoCleanup needs retention.allowDelete: true')
  const b = options.batchSize
  if (b !== undefined && !(Number.isInteger(b) && b >= 1 && b <= 5000)) throw new TypeError('[geo] retention.batchSize must be 1 to 5000')
}

export function retentionDays(options: RetentionOptions | undefined, dataset: Dataset): number | undefined {
  return options?.[`${dataset}Days` as 'hitsDays']
}

/** The cutoff for a dataset (entries strictly older are removed), or null when it is kept forever. */
export function retentionCutoff(options: RetentionOptions | undefined, dataset: Dataset, now = new Date()): Date | null {
  const days = retentionDays(options, dataset)
  return days ? new Date(now.getTime() - days * 86_400_000) : null
}

/** Parses a cleanup request. A `before` date in the future or in the last 24 hours is refused. */
export function parseCleanupRequest(body: unknown, options: RetentionOptions | undefined, now = new Date()): { dataset: Dataset; before: Date; confirm: boolean } | { error: string } {
  const b = (body ?? {}) as { dataset?: unknown; before?: unknown; confirm?: unknown }
  if (!DATASETS.includes(b.dataset as Dataset)) return { error: `dataset must be one of ${DATASETS.join(', ')}` }
  const dataset = b.dataset as Dataset
  const before = b.before ? new Date(String(b.before)) : retentionCutoff(options, dataset, now)
  if (!before || Number.isNaN(before.getTime())) return { error: 'before is required (no retention days are configured for this dataset)' }
  if (before.getTime() > now.getTime() - 86_400_000) return { error: 'before must be at least one day in the past' }
  return { dataset, before, confirm: b.confirm === true }
}

/** One in-process lock per dataset, so two cleanups never run at once in the same process. */
export class CleanupLock {
  private held = new Set<string>()
  acquire(key: string): boolean {
    if (this.held.has(key)) return false
    this.held.add(key)
    return true
  }
  release(key: string): void {
    this.held.delete(key)
  }
}

/**
 * Deletes in batches until nothing older is left: `deleteBatch(limit)` removes up to `limit` rows older than the
 * cutoff and returns how many it removed. Stops after `maxBatches` (default 10 000) as a safety net.
 */
export async function runBatchedCleanup(deleteBatch: (limit: number) => Promise<number>, options: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const size = Math.min(Math.max(options.batchSize ?? 500, 1), 5000)
  let total = 0
  for (let i = 0; i < (options.maxBatches ?? 10_000); i++) {
    const n = await deleteBatch(size)
    total += n
    if (n < size) break
  }
  return total
}

/** True when a stats window starts before the last cleanup cutoff: older visits were deleted. */
export function historyIncomplete(windowStart: Date, lastCutoff: string | Date | null | undefined): boolean {
  if (!lastCutoff) return false
  const cutoff = new Date(lastCutoff)
  return !Number.isNaN(cutoff.getTime()) && windowStart.getTime() < cutoff.getTime()
}

// ---------- Export ----------

export interface ExportField {
  name: string
  /** Not exported unless asked for: IPs, user agents, referrers, raw event bodies. */
  sensitive?: boolean
}

export const EXPORT_FIELDS: Record<Dataset, ExportField[]> = {
  hits: [
    { name: 'timestamp' }, { name: 'botId' }, { name: 'botName' }, { name: 'platform' }, { name: 'purpose' }, { name: 'verification' },
    { name: 'path' }, { name: 'host' }, { name: 'method' }, { name: 'ip', sensitive: true }, { name: 'userAgent', sensitive: true }, { name: 'referer', sensitive: true },
  ],
  referrals: [{ name: 'timestamp' }, { name: 'source' }, { name: 'platform' }, { name: 'path' }, { name: 'host' }, { name: 'referrerHost' }],
  invalidations: [
    { name: 'createdAt' }, { name: 'eventId' }, { name: 'eventType' }, { name: 'source' }, { name: 'target' }, { name: 'status' },
    { name: 'attempts' }, { name: 'lastError' }, { name: 'lastAttemptAt' }, { name: 'event', sensitive: true },
  ],
}

export interface ExportRequest {
  dataset: Dataset
  format: 'csv' | 'json'
  from?: Date
  to?: Date
  fields: string[]
}

/** Parses `?dataset=hits&format=csv&from=…&to=…&fields=a,b&sensitive=1`. Unknown fields are refused. */
export function parseExportRequest(query: URLSearchParams | Record<string, unknown>): ExportRequest | { error: string } {
  const get = (k: string) => (query instanceof URLSearchParams ? query.get(k) : typeof query[k] === 'string' ? (query[k] as string) : null)
  const dataset = get('dataset') as Dataset
  if (!DATASETS.includes(dataset)) return { error: `dataset must be one of ${DATASETS.join(', ')}` }
  const format = (get('format') ?? 'csv') as 'csv' | 'json'
  if (format !== 'csv' && format !== 'json') return { error: 'format must be csv or json' }
  const date = (k: string) => {
    const v = get(k)
    if (!v) return undefined
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const from = date('from')
  const to = date('to')
  if (from === null || to === null) return { error: 'from / to must be dates' }
  const all = EXPORT_FIELDS[dataset]
  const sensitive = get('sensitive') === '1' || get('sensitive') === 'true'
  const asked = get('fields')?.split(',').map((f) => f.trim()).filter(Boolean)
  if (asked) {
    const unknown = asked.filter((f) => !all.some((a) => a.name === f))
    if (unknown.length) return { error: `unknown fields: ${unknown.join(', ')}` }
    const hidden = asked.filter((f) => all.find((a) => a.name === f)!.sensitive && !sensitive)
    if (hidden.length) return { error: `sensitive fields need sensitive=1: ${hidden.join(', ')}` }
  }
  const fields = asked ?? all.filter((f) => sensitive || !f.sensitive).map((f) => f.name)
  return { dataset, format, from, to, fields }
}

const FORMULA = /^[=+\-@\t\r]/

/**
 * One CSV cell. Values that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab or CR)
 * get a leading `'`, so opening the export in Excel or Sheets never executes anything (CSV injection).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (FORMULA.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n'
}

/**
 * Streams an export page by page: `page(offset, limit)` returns rows in a stable order. CSV starts with a UTF-8
 * BOM and a header; JSON is one array. Memory stays at one page.
 */
export function exportStream(request: ExportRequest, page: (offset: number, limit: number) => Promise<Record<string, unknown>[]>, pageSize = 1000): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let offset = 0
  let started = false
  let done = false
  const pick = (row: Record<string, unknown>) => Object.fromEntries(request.fields.map((f) => [f, row[f] ?? null]))
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return
      try {
        let chunk = ''
        if (!started) {
          started = true
          chunk += request.format === 'csv' ? '\ufeff' + csvRow(request.fields) : '['
        }
        const rows = await page(offset, pageSize)
        rows.forEach((row, i) => {
          if (request.format === 'csv') chunk += csvRow(request.fields.map((f) => row[f]))
          else chunk += (offset + i > 0 ? ',\n' : '\n') + JSON.stringify(pick(row))
        })
        offset += rows.length
        if (rows.length < pageSize) {
          done = true
          if (request.format === 'json') chunk += offset ? '\n]\n' : ']\n'
        }
        controller.enqueue(enc.encode(chunk))
        if (done) controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

export function exportFileName(request: ExportRequest, now = new Date()): string {
  return `geo-${request.dataset}-${now.toISOString().slice(0, 10)}.${request.format}`
}

/** A job record: what ran, by whom, with what result. Kept so the dashboard shows cleanups and exports. */
export interface MaintenanceJob {
  kind: 'cleanup' | 'export'
  dataset: Dataset
  status: 'running' | 'succeeded' | 'failed'
  before?: string | null
  deleted?: number | null
  startedBy?: string | null
  startedAt: string
  finishedAt?: string | null
  error?: string | null
}
