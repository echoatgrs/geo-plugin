import type { CrawlerStats } from '@garus-ltd/geo-core'
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { GeoEvidence, type GeoEvidenceProps } from './evidence.js'
import { GeoSetupStatus, type GeoSetupStatusProps } from './setup.js'

export type { CrawlerStats }
export { GeoSetupStatus, type GeoSetupStatusProps, type SetupReport } from './setup.js'
export { GeoEvidence, type EvidenceReport, type GeoEvidenceProps } from './evidence.js'
export { DocumentTraffic, type DocumentStatsResult } from './document-traffic.js'
export { GeoPanel, type GeoPanelProps, type PanelInspection, type PreviewVersion } from './panel.js'

export interface GeoDashboardProps {
  /** Loads stats for the last `days` days. Each CMS passes its own authenticated fetch. */
  fetchStats: (days: number) => Promise<CrawlerStats>
  /** Smaller layout for a dashboard widget: KPIs and chart only. */
  compact?: boolean
  /** Link to the full view, shown in compact mode. */
  moreHref?: string
  /** Link to the raw crawler hit list in the CMS. */
  hitsHref?: string
  title?: string
  /** Adds a "Setup status" tab (full layout only). */
  setup?: GeoSetupStatusProps
  /** Adds an "AI referrals & citations" tab (full layout only). */
  evidence?: Pick<GeoEvidenceProps, 'load'>
}

// Colors work on light and dark admin themes: neutrals derive from the inherited text color.
const ACCENT = '#6d5dfc'
const muted: CSSProperties = { opacity: 0.65 }
const card: CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
  borderRadius: 8,
  padding: 16,
  minWidth: 0,
}
const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const cell: CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
  textAlign: 'left',
}
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

const fmt = new Intl.NumberFormat('en')
const pct = (n: number) => `${Math.round(n * 100)}%`

function Kpi({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: string; accent?: boolean }) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4, color: accent ? ACCENT : undefined }}>{value}</div>
      {hint && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function DailyChart({ daily }: { daily: CrawlerStats['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.total))
  const width = 600
  const height = 120
  const gap = daily.length > 60 ? 1 : 2
  const barW = width / daily.length - gap
  return (
    <div>
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={140} preserveAspectRatio="none" role="img" aria-label="AI crawler visits per day">
      {daily.map((d, i) => {
        const x = i * (barW + gap)
        const h = (d.total / max) * height
        const hu = (d.user / max) * height
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${d.total} visits, ${d.user} live user fetches`}</title>
            {/* Baseline tick so empty days are still visible. */}
            <rect x={x} y={height - 2} width={barW} height={2} fill="currentColor" opacity={0.1} />
            <rect x={x} y={height - h} width={barW} height={h} rx={2} fill="currentColor" opacity={0.18} />
            <rect x={x} y={height - hu} width={barW} height={hu} rx={2} fill={ACCENT} />
          </g>
        )
      })}
    </svg>
    {/* Labels live outside the SVG so they don't scale with the chart width. */}
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, margin: '4px 0 8px', ...muted }}>
      <span>{daily[0]?.date}</span>
      <span>{daily.at(-1)?.date}</span>
    </div>
    </div>
  )
}

function Legend() {
  const dot = (color: string, opacity = 1): CSSProperties => ({
    display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color, opacity, marginRight: 6,
  })
  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 12, ...muted }}>
      <span><span style={dot(ACCENT)} />Live user fetches</span>
      <span><span style={dot('currentColor', 0.18)} />Training and search crawls</span>
    </div>
  )
}

function SetupHint() {
  return (
    <div style={{ ...card, borderStyle: 'dashed' }}>
      <strong>No AI crawler visits recorded yet.</strong>
      <p style={{ ...muted, margin: '8px 0' }}>
        Your CMS can't see requests to your frontend. Add one line to your Next.js <code>proxy.ts</code> (or{' '}
        <code>middleware.ts</code>) to start logging GPTBot, ClaudeBot, ChatGPT-User and others:
      </p>
      <pre style={{ margin: 0, padding: 12, borderRadius: 6, background: 'color-mix(in srgb, currentColor 8%, transparent)', overflowX: 'auto', fontSize: 12 }}>
{`import { withGeo } from '@garus-ltd/geo-next'

export const proxy = withGeo({
  endpoint: process.env.GEO_INGEST_URL, // https://<cms>/api/geo/ingest
  secret: process.env.GEO_SECRET,
})`}
      </pre>
    </div>
  )
}

export function GeoDashboard(props: GeoDashboardProps) {
  type View = 'overview' | 'evidence' | 'setup'
  const [view, setView] = useState<View>('overview')
  if (props.compact || (!props.setup && !props.evidence)) return <Overview {...props} />
  const tab = (id: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      onClick={() => setView(id)}
      style={{ font: 'inherit', padding: '6px 10px', border: 'none', borderBottom: `2px solid ${view === id ? ACCENT : 'transparent'}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: view === id ? 600 : 400 }}
    >
      {label}
    </button>
  )
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div role="tablist" aria-label="GEO" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
        {tab('overview', 'Overview')}
        {props.evidence && tab('evidence', 'AI referrals & citations')}
        {props.setup && tab('setup', 'Setup status')}
      </div>
      {view === 'overview' && <Overview {...props} />}
      {view === 'evidence' && props.evidence && <GeoEvidence load={props.evidence.load} fetchStats={props.fetchStats} />}
      {view === 'setup' && props.setup && <GeoSetupStatus {...props.setup} />}
    </div>
  )
}

function Overview({ fetchStats, compact, moreHref, hitsHref, title = 'AI visibility' }: GeoDashboardProps) {
  const [days, setDays] = useState(compact ? 7 : 30)
  const [stats, setStats] = useState<CrawlerStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(
    (d: number) => {
      setLoading(true)
      setError(null)
      fetchStats(d)
        .then(setStats)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    },
    [fetchStats],
  )
  useEffect(() => load(days), [load, days])

  const grid = (min: number): CSSProperties => ({
    display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  })

  return (
    <section style={{ display: 'grid', gap: 16, marginBottom: compact ? 24 : 0, fontSize: 14 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: compact ? 18 : 22 }}>{title}</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {compact && moreHref && <a href={moreHref}>Open dashboard</a>}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Date range">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </header>

      {error && <div style={{ ...card, color: '#d93f3f' }}>Could not load GEO stats: {error}</div>}
      {!stats && loading && <div style={muted}>Loading…</div>}

      {stats && (
        <div style={{ display: 'grid', gap: 16, opacity: loading ? 0.6 : 1 }}>
          <div style={grid(160)}>
            <Kpi label="AI crawler visits" value={fmt.format(stats.total)} hint={`${stats.byPlatform.length} platforms`} />
            <Kpi
              label="Live user fetches"
              value={fmt.format(stats.userFetches)}
              hint="An AI opened your page while answering someone"
              accent
            />
            <Kpi
              label="Content coverage"
              value={stats.coverage === undefined ? '–' : pct(stats.coverage)}
              hint={stats.coverage === undefined ? 'Configure llms collections to enable' : 'Crawled by at least one AI'}
            />
            <Kpi label="llms.txt reads" value={fmt.format(stats.llmsTxtReads)} />
          </div>

          {stats.total === 0 ? (
            <SetupHint />
          ) : (
            <div style={card}>
              <DailyChart daily={stats.daily} />
              <Legend />
            </div>
          )}

          {!compact && stats.total > 0 && (
            <div style={grid(320)}>
              <div style={card}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>By platform</h3>
                <table style={table}>
                  <thead>
                    <tr><th style={cell}>Platform</th><th style={num}>Visits</th><th style={num}>Live user</th></tr>
                  </thead>
                  <tbody>
                    {stats.byPlatform.map((p) => (
                      <tr key={p.platform}><td style={cell}>{p.platform}</td><td style={num}>{fmt.format(p.total)}</td><td style={num}>{fmt.format(p.user)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={card}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Top pages</h3>
                <table style={table}>
                  <thead>
                    <tr><th style={cell}>Path</th><th style={num}>Visits</th><th style={num}>Live user</th></tr>
                  </thead>
                  <tbody>
                    {stats.topPaths.map((p) => (
                      <tr key={p.path}>
                        <td style={{ ...cell, wordBreak: 'break-all' }}>{p.path}</td>
                        <td style={num}>{fmt.format(p.total)}</td>
                        <td style={num}>{fmt.format(p.user)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!compact && stats.neverCrawled && stats.neverCrawled.length > 0 && (
            <div style={card}>
              <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Never crawled by AI ({stats.neverCrawled.length})</h3>
              <p style={{ ...muted, margin: '0 0 8px', fontSize: 12 }}>
                Content with no AI crawler visit in this period. Check that it is linked, server-rendered and not blocked in robots.txt.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, columns: '2 260px', fontSize: 13 }}>
                {stats.neverCrawled.slice(0, 50).map((p) => <li key={p} style={{ wordBreak: 'break-all' }}>{p}</li>)}
              </ul>
              {stats.neverCrawled.length > 50 && <div style={{ ...muted, fontSize: 12, marginTop: 6 }}>and {stats.neverCrawled.length - 50} more</div>}
            </div>
          )}

          {stats.byVerification.spoofed > 0 && (
            <div style={{ ...muted, fontSize: 12 }}>
              {fmt.format(stats.byVerification.spoofed)} requests claimed to be an AI crawler but came from outside its official IP
              ranges. They are excluded above.{hitsHref && <> <a href={hitsHref}>See all hits</a></>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
