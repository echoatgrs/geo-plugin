import type { DiagnosticItem, DiagnosticStatus } from '@garus-ltd/geo-core'
import { useEffect, useRef, useState, type CSSProperties } from 'react'

export interface SetupReport {
  config: DiagnosticItem[]
  evidence: DiagnosticItem[]
  /** Commands to verify by hand when the frontend is a separate deployment. */
  manual: string[]
}

export interface GeoSetupStatusProps {
  /** Loads configuration checks and recent evidence. No requests to the site are made. */
  load: () => Promise<SetupReport>
  /** Runs the active checks against the configured site. Admin-triggered only. */
  run: (signal: AbortSignal) => Promise<{ active: DiagnosticItem[] }>
}

const LOOK: Record<DiagnosticStatus, { label: string; icon: string; color: string }> = {
  pass: { label: 'OK', icon: '✓', color: '#2f855a' },
  warning: { label: 'Warning', icon: '!', color: '#b7791f' },
  error: { label: 'Problem', icon: '✕', color: '#d93f3f' },
  unknown: { label: 'Not verified', icon: '?', color: 'currentColor' },
  notEnabled: { label: 'Not enabled', icon: '–', color: 'currentColor' },
}

const card: CSSProperties = { border: '1px solid color-mix(in srgb, currentColor 15%, transparent)', borderRadius: 8, padding: 16, minWidth: 0 }
const muted: CSSProperties = { opacity: 0.7 }
const btn: CSSProperties = { font: 'inherit', fontSize: 13, padding: '6px 12px', borderRadius: 4, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }

function Items({ items }: { items: DiagnosticItem[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
      {items.map((i) => {
        const look = LOOK[i.status]
        return (
          <li key={i.id} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'start' }}>
            <span style={{ color: look.color, fontWeight: 600, fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span aria-hidden style={{ display: 'inline-grid', placeItems: 'center', width: 16, height: 16, borderRadius: 8, border: `1px solid ${look.color}` }}>{look.icon}</span>
              {look.label}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{i.title}</div>
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{i.detail}</div>
              {i.suggestion && <div style={{ ...muted, fontSize: 12 }}>{i.suggestion}</div>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** "Setup status": configuration, an explicit test run against the site, and recent ingest evidence, kept apart. */
export function GeoSetupStatus({ load, run }: GeoSetupStatusProps) {
  const [report, setReport] = useState<SetupReport | null>(null)
  const [active, setActive] = useState<DiagnosticItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const reload = () =>
    load()
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  useEffect(() => {
    void reload()
    return () => controller.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    controller.current?.abort()
    const c = new AbortController()
    controller.current = c
    setRunning(true)
    setError(null)
    try {
      const res = await run(c.signal)
      if (!c.signal.aborted) setActive(res.active)
      await reload()
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (controller.current === c) setRunning(false)
    }
  }
  const cancel = () => {
    controller.current?.abort()
    setRunning(false)
    setError('Test cancelled.')
  }

  return (
    <div style={{ display: 'grid', gap: 16, fontSize: 14 }}>
      {error && <div role="alert" style={{ ...card, color: LOOK.error.color }}>{error}</div>}
      {!report && !error && <div style={muted}>Loading…</div>}
      {report && (
        <>
          <section style={card} aria-label="Configuration">
            <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Configuration</h3>
            <Items items={report.config} />
          </section>
          <section style={card} aria-label="Connectivity test">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Connectivity test</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={{ ...btn, opacity: running ? 0.6 : 1 }} onClick={start} disabled={running}>{running ? 'Running…' : 'Run test'}</button>
                {running && <button type="button" style={btn} onClick={cancel}>Cancel</button>}
              </div>
            </div>
            <p style={{ ...muted, margin: '0 0 12px', fontSize: 12 }}>
              Requests the configured site like an AI crawler: article HTML, JSON-LD, <code>.md</code>, <code>Accept: text/markdown</code>,
              llms.txt, and whether the frontend proxy reports back. The test request carries a one-time token, so it is recognised
              and never stored or counted as traffic. Only the configured site is requested.
            </p>
            <div role="status" aria-live="polite">
              {active ? <Items items={active} /> : <div style={muted}>Not run yet.</div>}
            </div>
          </section>
          <section style={card} aria-label="Recent evidence">
            <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Recent evidence</h3>
            <Items items={report.evidence} />
          </section>
          <section style={card} aria-label="Manual steps">
            <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Check by hand</h3>
            <p style={{ ...muted, margin: '0 0 8px', fontSize: 12 }}>
              When the frontend is a separate deployment, the CMS can't see its environment variables. Run these from anywhere:
            </p>
            <pre style={{ margin: 0, padding: 12, borderRadius: 6, background: 'color-mix(in srgb, currentColor 6%, transparent)', overflowX: 'auto', fontSize: 12 }}>
              {report.manual.join('\n')}
            </pre>
          </section>
        </>
      )}
    </div>
  )
}
