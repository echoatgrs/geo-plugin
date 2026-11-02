import { GeoDashboard, type CrawlerStats } from '@garus-ltd/geo-dashboard'
import { useFetchClient } from '@strapi/strapi/admin'
import { useCallback } from 'react'

const HITS_PATH = '/content-manager/collection-types/plugin::geo.crawler-hit'

/** The admin's base path (`/admin` unless `admin.url` is changed), taken from this page's own URL. */
function adminBase(): string {
  const path = typeof window === 'undefined' ? '' : window.location.pathname
  const i = path.indexOf('/plugins/geo')
  return i >= 0 ? path.slice(0, i) : '/admin'
}

export default function GeoPage() {
  const { get } = useFetchClient()
  const fetchStats = useCallback(
    async (days: number) => (await get<CrawlerStats>(`/geo/stats?days=${days}`)).data,
    [get],
  )
  return (
    <main style={{ padding: '40px 56px' }}>
      <GeoDashboard
        fetchStats={fetchStats}
        hitsHref={`${adminBase()}${HITS_PATH}`}
      />
    </main>
  )
}
