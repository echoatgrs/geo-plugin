import { GeoDashboard, GeoPanel, type CrawlerStats, type PanelInspection, type PreviewVersion } from '@garus-ltd/geo-dashboard'
import { useAllFormFields, useDocumentInfo } from '@payloadcms/ui'
import { reduceFieldsToValues } from 'payload/shared'
import { useCallback, useMemo } from 'react'

export interface GeoDashboardClientProps {
  statsURL: string
  compact?: boolean
  moreHref?: string
  hitsHref?: string
}

/** Rendered on the admin home (compact) and above the AI Crawler Hits list (full). */
export function GeoDashboardClient({ statsURL, compact, moreHref, hitsHref }: GeoDashboardClientProps) {
  const fetchStats = useCallback(
    async (days: number): Promise<CrawlerStats> => {
      const res = await fetch(`${statsURL}?days=${days}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    [statsURL],
  )
  const dashboard = <GeoDashboard fetchStats={fetchStats} compact={compact} moreHref={moreHref} hitsHref={hitsHref} />
  // `beforeList` renders outside the list view's gutter, so add Payload's own gutter around the full dashboard.
  if (compact) return dashboard
  return <div style={{ padding: '0 var(--gutter-h, 60px)', marginBottom: 40 }}>{dashboard}</div>
}

export interface GeoEditPanelProps {
  inspectURL: string
  collection: string
}

/** Sidebar panel on the edit view of collections listed in `llms.collections`. Read-only. */
export function GeoEditPanel({ inspectURL, collection }: GeoEditPanelProps) {
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
  return (
    <div style={{ marginBottom: 'var(--base, 20px)' }}>
      <GeoPanel documentKey={`${collection}:${id ?? 'new'}`} values={values} inspect={inspect} />
    </div>
  )
}
