import { GeoDashboard, type CrawlerStats } from '@headless-geo/dashboard'
import { useFetchClient } from '@strapi/strapi/admin'
import { useCallback } from 'react'

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
        hitsHref="/admin/content-manager/collection-types/plugin::geo.crawler-hit"
      />
    </main>
  )
}
