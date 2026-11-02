import {
  GeoDashboard,
  GeoPanel,
  type CrawlerStats,
  type DocumentStatsResult,
  type EvidenceReport,
  type PanelInspection,
  type PreviewVersion,
  type SetupReport,
} from '@garus-ltd/geo-dashboard'
import type { DiagnosticItem } from '@garus-ltd/geo-core'
import { useAllFormFields, useDocumentInfo } from '@payloadcms/ui'
import { reduceFieldsToValues } from 'payload/shared'
import { useCallback, useMemo } from 'react'

export interface GeoDashboardClientProps {
  statsURL: string
  /** Setup status endpoint; adds the "Setup status" tab. */
  setupURL?: string
  /** AI referrals & citation evidence endpoint; adds that tab. */
  evidenceURL?: string
  compact?: boolean
  moreHref?: string
  hitsHref?: string
}

/** Rendered on the admin home (compact) and above the AI Crawler Hits list (full). */
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export function GeoDashboardClient({ statsURL, setupURL, evidenceURL, compact, moreHref, hitsHref }: GeoDashboardClientProps) {
  const fetchStats = useCallback(
    async (days: number): Promise<CrawlerStats> => {
      const res = await fetch(`${statsURL}?days=${days}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    [statsURL],
  )
  const setup = useMemo(
    () =>
      setupURL
        ? {
            load: () => json<SetupReport>(setupURL),
            run: (signal: AbortSignal) => json<{ active: DiagnosticItem[] }>(`${setupURL}/test`, { method: 'POST', signal }),
          }
        : undefined,
    [setupURL],
  )
  const evidence = useMemo(
    () => (evidenceURL ? { load: (days: number, signal: AbortSignal) => json<EvidenceReport>(`${evidenceURL}?days=${days}`, { signal }) } : undefined),
    [evidenceURL],
  )
  const dashboard = <GeoDashboard fetchStats={fetchStats} compact={compact} moreHref={moreHref} hitsHref={hitsHref} setup={setup} evidence={evidence} />
  // `beforeList` renders outside the list view's gutter, so add Payload's own gutter around the full dashboard.
  if (compact) return dashboard
  return <div style={{ padding: '0 var(--gutter-h, 60px)', marginBottom: 40 }}>{dashboard}</div>
}

export interface GeoEditPanelProps {
  inspectURL: string
  statsURL?: string
  collection: string
}

/** Sidebar panel on the edit view of collections listed in `llms.collections`. Read-only. */
export function GeoEditPanel({ inspectURL, statsURL, collection }: GeoEditPanelProps) {
  const [fields] = useAllFormFields()
  const { id } = useDocumentInfo()
  const values = useMemo(() => reduceFieldsToValues(fields, true), [fields])
  const inspect = useCallback(
    async (data: unknown, signal: AbortSignal, version: PreviewVersion): Promise<PanelInspection> => {
      const res = await fetch(inspectURL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection, id: id ?? undefined, data, version }),
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    [inspectURL, collection, id],
  )
  const fetchDocumentStats = useCallback(
    (days: number, signal: AbortSignal) =>
      json<DocumentStatsResult>(`${statsURL}?collection=${encodeURIComponent(collection)}${id != null ? `&id=${encodeURIComponent(String(id))}` : ''}&days=${days}`, { signal }),
    [statsURL, collection, id],
  )
  return (
    <div style={{ marginBottom: 'var(--base, 20px)' }}>
      <GeoPanel
        documentKey={`${collection}:${id ?? 'new'}`}
        values={values}
        inspect={inspect}
        fetchDocumentStats={statsURL ? fetchDocumentStats : undefined}
      />
    </div>
  )
}
