import { useCallback, useEffect, useState, type CSSProperties } from 'react'

export type DataSet = 'hits' | 'referrals' | 'invalidations'

export interface DataReport {
  allowDelete: boolean
  autoCleanup: boolean
  datasets: {
    dataset: DataSet
    total: number
    oldest: string | null
    retentionDays: number | null
    cutoff: string | null
    olderThanCutoff: number | null
    deletedBefore: string | null
  }[]
  jobs: { id: string | number; kind: string; dataset: string; status: string; before?: string | null; deleted?: number | null; startedBy?: string | null; startedAt: string; error?: string | null }[]
}

export interface InvalidationReport {
  targets: { name: string; events: string[] | 'all' }[]
  deliveries: { id: string | number; createdAt: string; eventId: string; eventType: string; source: string; target: string; status: string; attempts: number; lastError: string | null }[]
}

export interface GeoDataProps {
  load: () => Promise<DataReport>
  /** Preview (confirm false) or run (confirm true) a cleanup of rows older than `before`. */
  cleanup: (body: { dataset: DataSet; before: string; confirm: boolean }) => Promise<{ count?: number; deleted?: number; error?: string }>
  /** Downloads an export with the admin's authentication (see `saveDownload`). */
  download: (dataset: DataSet, format: 'csv' | 'json', sensitive: boolean) => Promise<void>
  /** Cache notices, when invalidation targets are configured. */
  invalidations?: {
    load: () => Promise<InvalidationReport>
    retry: (id: string | number) => Promise<{ status?: string; lastError?: string | null; error?: string }>
    flush: () => Promise<unknown>
  }
}

const card: CSSProperties = { border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: 8, padding: 16, minWidth: 0 }
const muted: CSSProperties = { opacity: 0.7 }
const btn: CSSProperties = { font: 'inherit', fontSize: 13, padding: '4px 10px', borderRadius: 4, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }
const cell: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)', textAlign: 'left', verticalAlign: 'top' }
const LABEL: Record<DataSet, string> = { hits: 'AI crawler hits', referrals: 'AI referral visits', invalidations: 'Cache notices' }
const date = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '–')
const STATUS_COLOR: Record<string, string> = { succeeded: '#2f855a', failed: '#d93f3f', running: '#b7791f', pending: '#b7791f' }

function Cleanup({ row, allowDelete, cleanup, done }: { row: DataReport['datasets'][number]; allowDelete: boolean; cleanup: GeoDataProps['cleanup']; done: () => void }) {
  const [before, setBefore] = useState(row.cutoff ? row.cutoff.slice(0, 10) : '')
  const [preview, setPreview] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ask = async (confirm: boolean) => {
    if (!before) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await cleanup({ dataset: row.dataset, before: new Date(`${before}T00:00:00Z`).toISOString(), confirm })
      if (r.error) setMessage(r.error)
      else if (confirm) {
        setMessage(`Deleted ${r.deleted ?? 0} rows.`)
        setPreview(null)
        done()
      } else setPreview(r.count ?? 0)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label style={{ fontSize: 13 }}>
        Older than <input type="date" value={before} onChange={(e) => (setBefore(e.target.value), setPreview(null))} aria-label={`Cleanup cutoff for ${LABEL[row.dataset]}`} />
      </label>
      <button type="button" style={btn} disabled={busy || !before} onClick={() => ask(false)}>Preview</button>
      {preview !== null && (
        <>
          <span style={{ fontSize: 13 }}>{preview} rows would be deleted.</span>
          {allowDelete && preview > 0 && (
            <button type="button" style={{ ...btn, color: '#d93f3f' }} disabled={busy} onClick={() => ask(true)}>
              Delete {preview} rows
            </button>
          )}
        </>
      )}
      {message && <span style={{ fontSize: 13 }}>{message}</span>}
    </div>
  )
}

/** "Data": what is stored, retention, preview-first cleanup, exports, and cache notice deliveries. */
/** Saves a fetched export as a file in the browser. */
export function saveDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** File name from a Content-Disposition header, or a fallback. */
export function downloadName(header: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(header ?? '')?.[1] ?? fallback
}

export function GeoData({ load, cleanup, download, invalidations }: GeoDataProps) {
  const [report, setReport] = useState<DataReport | null>(null)
  const [notices, setNotices] = useState<InvalidationReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sensitive, setSensitive] = useState(false)
  const [retrying, setRetrying] = useState<string | number | null>(null)
  const refresh = useCallback(() => {
    setError(null)
    load().then(setReport, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    invalidations?.load().then(setNotices, () => setNotices(null))
  }, [load, invalidations])
  useEffect(refresh, [refresh])

  return (
    <section style={{ display: 'grid', gap: 16, fontSize: 14 }}>
      {error && <div style={{ ...card, color: '#d93f3f' }}>Could not load data status: {error}</div>}
      {report && (
        <div style={card}>
          <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Stored data</h3>
          <p style={{ ...muted, margin: '0 0 12px', fontSize: 12 }}>
            {report.allowDelete
              ? `Deleting is allowed${report.autoCleanup ? ', and data past its retention is deleted daily' : ''}. Back up the database before deleting: the plugin can't restore rows.`
              : 'Deleting is off (preview only). Set retention.allowDelete: true in the plugin config, after a backup, to allow it.'}
          </p>
          <div style={{ display: 'grid', gap: 16 }}>
            {report.datasets.map((row) => (
              <div key={row.dataset} style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <strong>{LABEL[row.dataset]}</strong>
                  <span>{row.total} rows, oldest {date(row.oldest)}</span>
                  <span style={muted}>
                    {row.retentionDays ? `Keep ${row.retentionDays} days (${row.olderThanCutoff ?? 0} older)` : 'Kept forever'}
                    {row.deletedBefore ? ` · deleted before ${date(row.deletedBefore)}` : ''}
                  </span>
                  <span style={{ display: 'inline-flex', gap: 8 }}>
                    {(['csv', 'json'] as const).map((format) => (
                      <button key={format} type="button" style={btn} onClick={() => download(row.dataset, format, sensitive).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
                        Export {format.toUpperCase()}
                      </button>
                    ))}
                  </span>
                </div>
                <Cleanup row={row} allowDelete={report.allowDelete} cleanup={cleanup} done={refresh} />
              </div>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 12 }}>
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
            Include IPs, user agents, referrers and event bodies in exports
          </label>
        </div>
      )}
      {invalidations && notices && notices.targets.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Cache notices</h3>
            <button type="button" style={btn} onClick={() => invalidations.flush().then(refresh, refresh)}>Notify all targets now</button>
          </div>
          <p style={{ ...muted, margin: '4px 0 12px', fontSize: 12 }}>
            Targets: {notices.targets.map((t) => t.name).join(', ') || 'none'}. A failed notice never undoes the save; caches expire on their own after cacheMaxAge.
          </p>
          {notices.deliveries.length === 0 ? (
            <div style={muted}>No notices sent yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr><th style={cell}>When</th><th style={cell}>Event</th><th style={cell}>Target</th><th style={cell}>Status</th><th style={cell} /></tr>
              </thead>
              <tbody>
                {notices.deliveries.map((d) => {
                  // A retry is a new delivery of the same event: once one succeeded, the failed row needs nothing.
                  const resolved = d.status === 'failed' && notices.deliveries.some((o) => o.eventId === d.eventId && o.target === d.target && o.status === 'succeeded')
                  return (
                  <tr key={d.id}>
                    <td style={cell}>{new Date(d.createdAt).toLocaleString()}</td>
                    <td style={cell}>{d.eventType} <span style={muted}>{d.source}</span></td>
                    <td style={cell}>{d.target}</td>
                    <td style={{ ...cell, color: STATUS_COLOR[d.status] }}>
                      {d.status} ({d.attempts}){d.lastError && <div style={{ ...muted, color: 'inherit', fontSize: 12 }}>{d.lastError}</div>}
                    </td>
                    <td style={cell}>
                      {resolved && <span style={muted}>Retried, delivered</span>}
                      {d.status === 'failed' && !resolved && (
                        <button type="button" style={btn} disabled={retrying === d.id} onClick={() => (setRetrying(d.id), invalidations.retry(d.id).finally(() => (setRetrying(null), refresh())))}>
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {report && report.jobs.length > 0 && (
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Recent jobs</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr><th style={cell}>Started</th><th style={cell}>Job</th><th style={cell}>Status</th><th style={cell}>By</th></tr>
            </thead>
            <tbody>
              {report.jobs.map((j) => (
                <tr key={j.id}>
                  <td style={cell}>{new Date(j.startedAt).toLocaleString()}</td>
                  <td style={cell}>{j.kind} {LABEL[j.dataset as DataSet] ?? j.dataset}{j.kind === 'cleanup' && ` before ${date(j.before)}: ${j.deleted ?? 0} deleted`}</td>
                  <td style={{ ...cell, color: STATUS_COLOR[j.status] }}>{j.status}{j.error && <div style={{ fontSize: 12 }}>{j.error}</div>}</td>
                  <td style={cell}>{j.startedBy ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
