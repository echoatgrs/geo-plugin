import { GeoDashboard, saveDownload, type CrawlerStats, type DataReport, type DataSet, type EvidenceReport, type InvalidationReport, type SetupReport } from '@garus-ltd/geo-dashboard'
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
  const evidence = useMemo(
    () => ({
      load: async (days: number) => {
        const report = (await get<EvidenceReport>(`/geo/evidence?days=${days}`)).data
        // The server sends admin-relative links; prefix the admin's base path.
        const base = adminBase()
        const abs = (href?: string) => (href ? `${base}${href}` : undefined)
        return { ...report, referralsHref: abs(report.referralsHref), citationsHref: abs(report.citationsHref), newCitationHref: abs(report.newCitationHref) }
      },
    }),
    [get],
  )
  const data = useMemo(
    () => ({
      load: async () => (await get<DataReport>('/geo/data')).data,
      cleanup: async (body: { dataset: DataSet; before: string; confirm: boolean }) =>
        (await post<{ count?: number; deleted?: number; error?: string }>('/geo/data/cleanup', body, { validateStatus: () => true } as never)).data,
      async download(dataset: DataSet, format: 'csv' | 'json', sensitive: boolean) {
        // The admin API authenticates with a bearer token, so fetch through the admin client, then save the file.
        const res = await get<unknown>(`/geo/data/export?dataset=${dataset}&format=${format}${sensitive ? '&sensitive=1' : ''}`, { responseType: 'blob' } as never)
        const body = res.data
        const blob = body instanceof Blob ? body : new Blob([typeof body === 'string' ? body : JSON.stringify(body)], { type: format === 'csv' ? 'text/csv' : 'application/json' })
        saveDownload(blob, `geo-${dataset}-${new Date().toISOString().slice(0, 10)}.${format}`)
      },
      invalidations: {
        load: async () => (await get<InvalidationReport>('/geo/invalidations')).data,
        retry: async (id: string | number) => (await post<{ status?: string; lastError?: string | null; error?: string }>('/geo/invalidations/retry', { id }, { validateStatus: () => true } as never)).data,
        flush: async () => (await post('/geo/invalidations/flush', {}, { validateStatus: () => true } as never)).data,
      },
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
        evidence={evidence}
        data={data}
      />
    </main>
  )
}
