import { GeoDashboard, type CrawlerStats, type SetupReport } from '@garus-ltd/geo-dashboard'
import type { DiagnosticItem } from '@garus-ltd/geo-core'
import { useFetchClient } from '@strapi/strapi/admin'
import { useCallback, useMemo } from 'react'

const HITS_PATH = '/content-manager/collection-types/plugin::geo.crawler-hit'

/** The admin's base path (`/admin` unless `admin.url` is changed), taken from this page's own URL. */
function adminBase(): string {
  const path = typeof window === 'undefined' ? '' : window.location.pathname
  const i = path.indexOf('/plugins/geo')
  return i >= 0 ? path.slice(0, i) : '/admin'
}

export default function GeoPage() {
  const { get, post } = useFetchClient()
  const setup = useMemo(
    () => ({
      load: async () => (await get<SetupReport>('/geo/setup')).data,
      run: async (signal: AbortSignal) => (await post<{ active: DiagnosticItem[] }>('/geo/setup/test', {}, { signal })).data,
    }),
    [get, post],
  )
  const fetchStats = useCallback(
    async (days: number) => (await get<CrawlerStats>(`/geo/stats?days=${days}`)).data,
    [get],
  )
  return (
    <main style={{ padding: '40px 56px' }}>
      <GeoDashboard
        fetchStats={fetchStats}
        hitsHref={`${adminBase()}${HITS_PATH}`}
        setup={setup}
      />
    </main>
  )
}
