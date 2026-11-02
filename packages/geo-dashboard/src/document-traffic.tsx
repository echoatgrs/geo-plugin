import type { DocumentStats } from '@garus-ltd/geo-core'
import { useEffect, useState, type CSSProperties } from 'react'

export type DocumentStatsResult = DocumentStats | { unavailable: string }

const muted: CSSProperties = { opacity: 0.7 }
const fmt = new Intl.NumberFormat('en')
const cell: CSSProperties = { padding: '3px 4px', textAlign: 'left', borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)' }
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Bars({ daily }: { daily: DocumentStats['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.total))
  return (
    <div>
      <svg viewBox={`0 0 ${daily.length * 4} 40`} width="100%" height={48} preserveAspectRatio="none" role="img" aria-label="Valid AI crawler visits per day (UTC)">
        {daily.map((d, i) => (
          <g key={d.date}>
            <title>{`${d.date}: ${d.total} visits, ${d.user} live user fetches`}</title>
            <rect x={i * 4} y={39} width={3} height={1} fill="currentColor" opacity={0.15} />
            <rect x={i * 4} y={40 - (d.total / max) * 40} width={3} height={(d.total / max) * 40} fill="currentColor" opacity={0.25} />
            <rect x={i * 4} y={40 - (d.user / max) * 40} width={3} height={(d.user / max) * 40} fill="#6d5dfc" />
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, ...muted }}>
        <span>{daily[0]?.date}</span>
        <span>{daily.at(-1)?.date}</span>
      </div>
    </div>
  )
}

/** AI crawler visits to one document's page. */
export function DocumentTraffic({ documentKey, fetchStats }: { documentKey: string; fetchStats: (days: number, signal: AbortSignal) => Promise<DocumentStatsResult> }) {
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<DocumentStatsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setStats(null)
  }, [documentKey])
  useEffect(() => {
    const c = new AbortController()
    setError(null)
    fetchStats(days, c.signal)
      .then((s) => !c.signal.aborted && setStats(s))
      .catch((e: unknown) => !c.signal.aborted && setError(e instanceof Error ? e.message : String(e)))
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, documentKey])

  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        Range
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ font: 'inherit', fontSize: 12 }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </label>
      {error && <div role="alert" style={{ color: '#d93f3f' }}>Could not load visits: {error}</div>}
      {!stats && !error && <div style={muted}>Loading…</div>}
      {stats && 'unavailable' in stats && <div style={muted}>{stats.unavailable}</div>}
      {stats && !('unavailable' in stats) && (
        <>
          <div style={muted}>
            Page <code>{stats.path}</code>, days in UTC. Only this URL is counted (earlier URLs after a rename are not).
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
            {[
              ['Valid visits', stats.total],
              ['Live user fetches', stats.userFetches],
              ['Of which .md', stats.markdownHits],
            ].map(([label, value]) => (
              <div key={label as string} style={{ border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 6, padding: 6 }}>
                <div style={muted}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{fmt.format(value as number)}</div>
              </div>
            ))}
          </div>
          <Bars daily={stats.daily} />
          <div>Last visit: {stats.lastSeen ?? 'none in this range'}</div>
          {stats.total === 0 && (
            <div style={muted}>No visits recorded. That doesn't mean AI assistants never cite this page: it only means no crawler request reached the site in this range.</div>
          )}
          {stats.byPlatform.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={cell}>Platform</th><th style={num}>Visits</th><th style={num}>Live user</th></tr></thead>
              <tbody>{stats.byPlatform.map((p) => <tr key={p.platform}><td style={cell}>{p.platform}</td><td style={num}>{p.total}</td><td style={num}>{p.user}</td></tr>)}</tbody>
            </table>
          )}
          <div>
            Purpose: training {stats.byPurpose.training} · search {stats.byPurpose.search} · user {stats.byPurpose.user}
          </div>
          <div>
            IP check: verified {stats.byVerification.verified} · unverifiable {stats.byVerification.unverifiable} (no published IP list, not
            proof of identity) · spoofed {stats.byVerification.spoofed} (excluded above)
            {stats.otherHosts > 0 && <> · {stats.otherHosts} hits for other hosts left out</>}
          </div>
          {stats.recent.length > 0 && (
            <details>
              <summary>Recent records ({stats.recent.length})</summary>
              <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 6 }}>
                {stats.recent.map((r, i) => (
                  <li key={i} style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)', paddingBottom: 4 }}>
                    <div>
                      {r.timestamp.slice(0, 16).replace('T', ' ')} UTC · {r.botId} · <span style={{ fontWeight: r.verification === 'spoofed' ? 700 : 400 }}>{r.verification}</span>
                    </div>
                    <div style={{ ...muted, overflowWrap: 'anywhere' }}>{r.host ? `${r.host}` : ''}{r.path}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}
