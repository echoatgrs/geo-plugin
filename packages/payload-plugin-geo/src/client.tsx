import { GeoDashboard, type CrawlerStats } from '@garus-ltd/geo-dashboard'
import { useCallback } from 'react'

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
