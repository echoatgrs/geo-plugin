import { GeoDashboard, type CrawlerStats } from '@headless-geo/dashboard'
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
  return <GeoDashboard fetchStats={fetchStats} compact={compact} moreHref={moreHref} hitsHref={hitsHref} />
}
