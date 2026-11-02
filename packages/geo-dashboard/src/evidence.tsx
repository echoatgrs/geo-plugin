import type { CitationSummary, CrawlerStats, ReferralStats } from '@garus-ltd/geo-core'
import { useEffect, useState, type CSSProperties } from 'react'

export interface EvidenceReport {
  /** null when AI referral collection is not enabled. */
  referrals: ReferralStats | null
  /** null when citation evidence records are not enabled. */
  citations: CitationSummary | null
  /** Link to the list of recorded referral visits / citation evidence in the CMS. */
  referralsHref?: string
  citationsHref?: string
  /** Link to add a new citation evidence record. */
  newCitationHref?: string
}

export interface GeoEvidenceProps {
  load: (days: number, signal: AbortSignal) => Promise<EvidenceReport>
  /** Crawler stats for the same range, shown next to the other two signals. */
  fetchStats?: (days: number) => Promise<CrawlerStats>
}

const fmt = new Intl.NumberFormat('en')
const muted: CSSProperties = { opacity: 0.7 }
const card: CSSProperties = { border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: 8, padding: 16, minWidth: 0, display: 'grid', gap: 8, alignContent: 'start' }
const cell: CSSProperties = { padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid color-mix(in srgb, currentColor 10%, transparent)' }
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const big: CSSProperties = { fontSize: 28, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }

function Rows({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (!rows.length) return null
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
      <thead>
        <tr>{head.map((h, i) => <th key={h} style={i ? num : cell}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r[0])}>{r.map((v, i) => <td key={i} style={i ? num : { ...cell, overflowWrap: 'anywhere' }}>{typeof v === 'number' ? fmt.format(v) : v}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Three separate signals, never added together: crawler visits (pages fetched by AI bots), AI referral visits
 * (people arriving from an assistant) and recorded citation evidence (answers someone checked by hand).
 */
export function GeoEvidence({ load, fetchStats }: GeoEvidenceProps) {
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<EvidenceReport | null>(null)
  const [crawler, setCrawler] = useState<CrawlerStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const c = new AbortController()
    setError(null)
    load(days, c.signal)
      .then((r) => !c.signal.aborted && setReport(r))
      .catch((e: unknown) => !c.signal.aborted && setError(e instanceof Error ? e.message : String(e)))
    fetchStats?.(days)
      .then((s) => !c.signal.aborted && setCrawler(s))
      .catch(() => undefined)
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const referrals = report?.referrals
  const citations = report?.citations
  return (
    <div style={{ display: 'grid', gap: 16, fontSize: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <p style={{ ...muted, margin: 0, maxWidth: 720 }}>
          Three different signals, counted separately. A crawler visit or a referral visit is not a citation, and the citation count is
          only what has been recorded here, not every citation that exists.
        </p>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Range
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ font: 'inherit' }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      {error && <div role="alert" style={{ color: '#d93f3f' }}>Could not load: {error}</div>}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <section style={card} aria-label="AI crawler visits">
          <h3 style={{ margin: 0, fontSize: 15 }}>AI crawler visits</h3>
          <div style={muted}>Requests by AI bots, excluding spoofed ones. Proves a page was fetched, not that it was cited.</div>
          {crawler ? (
            <>
              <div style={big}>{fmt.format(crawler.total)} <span style={{ fontSize: 13, fontWeight: 400 }}>requests</span></div>
              <div>{fmt.format(crawler.userFetches)} live user fetches</div>
            </>
          ) : (
            <div style={muted}>{fetchStats ? 'Loading…' : 'See Overview.'}</div>
          )}
        </section>

        <section style={card} aria-label="AI referral visits">
          <h3 style={{ margin: 0, fontSize: 15 }}>AI referral visits</h3>
          <div style={muted}>
            Browser visits whose Referer is a known AI assistant. Evidence of traffic, not of every citation. The Referer can be forged, so
            this is not a verified identity.
          </div>
          {!report && !error && <div style={muted}>Loading…</div>}
          {report && !referrals && (
            <div style={muted}>Not enabled. Nothing about visitors is collected. Enable `referrals` in the CMS plugin and in withGeo().</div>
          )}
          {referrals && (
            <>
              <div style={big}>{fmt.format(referrals.total)} <span style={{ fontSize: 13, fontWeight: 400 }}>visits</span></div>
              <div style={{ fontSize: 12, ...muted }}>
                By Referer {fmt.format(referrals.bySource.referrer)} · by utm_source only {fmt.format(referrals.bySource.utm)}
                {referrals.unknown > 0 && <> · {fmt.format(referrals.unknown)} unknown external referrals (not counted)</>}
              </div>
              <Rows head={['Assistant', 'Visits']} rows={referrals.byPlatform.map((p) => [p.platform, p.total])} />
              <Rows head={['Landing page', 'Visits']} rows={referrals.topPaths.slice(0, 10).map((p) => [p.path, p.total])} />
              {report.referralsHref && <a href={report.referralsHref} style={{ color: 'inherit' }}>See all referral visits →</a>}
            </>
          )}
        </section>

        <section style={card} aria-label="Recorded citation evidence">
          <h3 style={{ margin: 0, fontSize: 15 }}>Recorded citation evidence</h3>
          <div style={muted}>
            Answers in which someone saw a link to this site and recorded it here. “Verified” means a person checked the record, not that the
            platform confirmed it. All time, not limited to the range.
          </div>
          {!report && !error && <div style={muted}>Loading…</div>}
          {report && !citations && <div style={muted}>Not enabled. Enable `citations` in the CMS plugin to record evidence by hand.</div>}
          {citations && (
            <>
              <div style={big}>{fmt.format(citations.total)} <span style={{ fontSize: 13, fontWeight: 400 }}>records</span></div>
              <div style={{ fontSize: 12 }}>
                Verified {fmt.format(citations.byStatus.verified)} · pending {fmt.format(citations.byStatus.pending)} · invalid {fmt.format(citations.byStatus.invalid)}
              </div>
              <Rows head={['Platform', 'Records', 'Verified']} rows={citations.byPlatform.map((p) => [p.platform, p.total, p.verified])} />
              <div style={{ fontSize: 12 }}>
                Automatic monitoring: {citations.providers.length ? citations.providers.join(', ') : 'not configured. Records are entered by hand only.'}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {report.newCitationHref && <a href={report.newCitationHref} style={{ color: 'inherit' }}>Record evidence →</a>}
                {report.citationsHref && <a href={report.citationsHref} style={{ color: 'inherit' }}>All records →</a>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
