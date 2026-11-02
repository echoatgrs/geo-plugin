import type { CheckResult, CheckStatus, FieldDiagnostic, Inspection } from '@garus-ltd/geo-core'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { DocumentTraffic, type DocumentStatsResult } from './document-traffic.js'

/** What the CMS's authenticated inspect endpoint returns. */
export interface PanelInspection extends Inspection {
  /** Live public outputs, only when the document is saved, public and has a URL. */
  publicLinks?: { page?: string; markdown?: string; jsonLd?: string }
  /** External validators for the public URL. Never offered for unpublished content. */
  validators?: Array<{ name: string; url: string }>
}

export interface GeoPanelProps {
  /** Identifies the open document. When it changes, the previous document's results are cleared at once. */
  documentKey: string
  /** Current (possibly unsaved) form values. A change re-runs the inspection after `debounceMs`. */
  values: unknown
  /**
   * Calls the CMS's authenticated inspect endpoint. `version` is `current` (the form values) or `published`
   * (the saved published version, to compare with the live output).
   */
  inspect: (values: unknown, signal: AbortSignal, version: PreviewVersion) => Promise<PanelInspection>
  debounceMs?: number
  /** Start collapsed. */
  collapsed?: boolean
  /** No border or padding of its own, for hosts that already frame the panel (Strapi side panels). */
  bare?: boolean
  /** AI crawler visits to this document's page. Adds a "Visits" tab. */
  fetchDocumentStats?: (days: number, signal: AbortSignal) => Promise<DocumentStatsResult>
}

const STATUS: Record<CheckStatus, { label: string; icon: string; color: string }> = {
  error: { label: 'Error', icon: '✕', color: '#d93f3f' },
  warning: { label: 'Warning', icon: '!', color: '#b7791f' },
  pass: { label: 'Pass', icon: '✓', color: '#2f855a' },
  notApplicable: { label: 'N/A', icon: '–', color: 'currentColor' },
}
const ORDER: CheckStatus[] = ['error', 'warning', 'pass', 'notApplicable']

const muted: CSSProperties = { opacity: 0.7 }
const border = '1px solid color-mix(in srgb, currentColor 15%, transparent)'
const pre: CSSProperties = {
  margin: 0,
  padding: 10,
  borderRadius: 6,
  background: 'color-mix(in srgb, currentColor 6%, transparent)',
  overflow: 'auto',
  maxHeight: 360,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
const button: CSSProperties = {
  font: 'inherit',
  fontSize: 12,
  padding: '4px 8px',
  borderRadius: 4,
  border,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

function Badge({ status }: { status: CheckStatus }) {
  const s = STATUS[status]
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 11, fontWeight: 600, color: s.color, minWidth: 64 }}>
      <span aria-hidden style={{ display: 'inline-grid', placeItems: 'center', width: 14, height: 14, borderRadius: 7, border: `1px solid ${s.color}` }}>{s.icon}</span>
      {s.label}
    </span>
  )
}

function CheckList({ checks }: { checks: CheckResult[] }) {
  const sorted = [...checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
      {sorted.map((c) => (
        <li key={c.ruleId} style={{ display: 'grid', gap: 2, paddingBottom: 8, borderBottom: border }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Badge status={c.status} />
            <code style={{ fontSize: 11, ...muted }}>{c.ruleId}</code>
            {c.fieldPath && <code style={{ fontSize: 11, ...muted }}>{c.fieldPath}</code>}
          </div>
          <div>{c.message}</div>
          {c.status !== 'pass' && c.suggestion !== 'Nothing to do.' && <div style={{ ...muted, fontSize: 12 }}>{c.suggestion}</div>}
        </li>
      ))}
    </ul>
  )
}

function Diagnostics({ rows }: { rows: FieldDiagnostic[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, overflowWrap: 'normal' }}>
      <thead>
        <tr>
          {['Output', 'From field', 'Value'].map((h) => <th key={h} style={{ textAlign: 'left', padding: 4, borderBottom: border }}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.property}>
            <td style={{ padding: 4, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{d.property}</td>
            <td style={{ padding: 4, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{d.field ? <code>{d.field}</code> : <span style={muted}>none</span>}</td>
            <td style={{ padding: 4, verticalAlign: 'top', overflowWrap: 'anywhere' }}>
              {d.value ?? <span style={muted}>{d.fallback ? `fallback: ${d.fallback}` : '—'}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => setState('idle'), [text])
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button type="button" style={button} onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}>{label}</button>
      <span role="status" aria-live="polite" style={{ fontSize: 12, color: state === 'fail' ? STATUS.error.color : undefined }}>
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed: select the text and copy it by hand' : ''}
      </span>
    </span>
  )
}

export type PreviewVersion = 'current' | 'published'

const ALL_TABS = ['Checks', 'Markdown', 'JSON-LD', 'Fields', 'Visits'] as const
type Tab = (typeof ALL_TABS)[number]

function summary(checks: CheckResult[]) {
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length
  return `${n('error')} errors, ${n('warning')} warnings, ${n('pass')} passed`
}

/**
 * Read-only GEO panel for the document editor. It never writes to the form: it reads the current values,
 * asks the CMS (debounced) for checks and previews, and shows them.
 */
export function GeoPanel({ documentKey, values, inspect, debounceMs = 800, collapsed = false, bare = false, fetchDocumentStats }: GeoPanelProps) {
  const TABS = ALL_TABS.filter((t) => t !== 'Visits' || !!fetchDocumentStats)
  const [open, setOpen] = useState(!collapsed)
  const [tab, setTab] = useState<Tab>('Checks')
  const [version, setVersion] = useState<PreviewVersion>('current')
  const [result, setResult] = useState<PanelInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Hosts often pass a new function each render; keep the latest without re-running the effect.
  const inspectRef = useRef(inspect)
  inspectRef.current = inspect
  const serialized = (() => {
    try {
      return JSON.stringify(values ?? null)
    } catch {
      return String(Date.now())
    }
  })()

  // A different document: drop the previous one's results right away.
  useEffect(() => {
    setResult(null)
    setError(null)
    setVersion('current')
  }, [documentKey])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      inspectRef.current(JSON.parse(serialized), controller.signal, version)
        .then((r) => {
          if (controller.signal.aborted) return
          setResult(r)
          setError(null)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return
          const message = e instanceof Error ? e.message : String(e)
          setResult(null)
          setError(version === 'published' && /404/.test(message) ? 'There is no published version yet.' : message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [version === 'current' ? serialized : 'published', documentKey, open, debounceMs, version])

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
    setTab(TABS[next]!)
    tabRefs.current[next]?.focus()
  }
  const panelId = `geo-panel-${documentKey.replace(/[^a-zA-Z0-9_-]/g, '')}`

  return (
    <section
      style={{
        display: 'grid',
        gap: 10,
        fontSize: 13,
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        overflowWrap: 'anywhere',
        ...(bare ? {} : { border, borderRadius: 6, padding: 12 }),
      }}
      aria-label="GEO"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...button, border: 'none', padding: 0, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden>{open ? '▾' : '▸'}</span> GEO check
        </button>
        <span role="status" aria-live="polite" style={{ ...muted, fontSize: 12 }}>
          {loading ? 'Checking…' : result ? summary(result.checks) : ''}
        </span>
      </div>
      {open && (
        <div id={panelId} style={{ display: 'grid', gap: 10 }}>
          <div style={{ ...muted, fontSize: 12 }}>
            Deterministic rules from the plugin's own output. Suggestions, not search engine requirements; no AI ranking or
            citation is predicted.
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            Check
            <select value={version} onChange={(e) => setVersion(e.target.value as PreviewVersion)} style={{ font: 'inherit', fontSize: 12, minWidth: 0, flex: 1 }}>
              <option value="current">current edits</option>
              <option value="published">published version</option>
            </select>
          </label>
          <div role="tablist" aria-label="GEO views" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {TABS.map((t, i) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[i] = el
                }}
                type="button"
                role="tab"
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                onKeyDown={(e) => onTabKey(e, i)}
                onClick={() => setTab(t)}
                style={{ ...button, fontWeight: tab === t ? 700 : 400, textDecoration: tab === t ? 'underline' : 'none' }}
              >
                {t}
              </button>
            ))}
          </div>
          {error && <div role="alert" style={{ color: STATUS.error.color }}>Could not run the GEO check: {error}</div>}
          {tab === 'Visits' && fetchDocumentStats && (
            <div role="tabpanel" aria-label="Visits">
              <DocumentTraffic documentKey={documentKey} fetchStats={fetchDocumentStats} />
            </div>
          )}
          {tab !== 'Visits' && !result && !error && <div style={muted}>Checking…</div>}
          {tab !== 'Visits' && result && (
            <div role="tabpanel" aria-label={tab} style={{ display: 'grid', gap: 8, opacity: loading ? 0.6 : 1 }}>
              {tab === 'Checks' && <CheckList checks={result.checks} />}
              {tab === 'Markdown' && (
                <>
                  <div style={{ fontSize: 12 }}>
                    <strong>{version === 'current' ? 'Preview of the current edits' : 'Preview of the published version'}</strong> <span style={muted}>(admin only, not public, not cached)</span>
                  </div>
                  {result.markdown ? (
                    <>
                      <CopyButton text={result.markdown} label="Copy Markdown" />
                      <pre style={pre}>{result.markdown}</pre>
                    </>
                  ) : (
                    <div style={muted}>No Markdown: the document has no frontend URL yet.</div>
                  )}
                  <PublicLinks result={result} />
                </>
              )}
              {tab === 'JSON-LD' && (
                <>
                  <div style={{ fontSize: 12 }}>
                    <strong>{version === 'current' ? 'Preview of the current edits' : 'Preview of the published version'}</strong> <span style={muted}>(admin only, not public, not cached)</span>
                  </div>
                  {result.jsonLd ? (
                    <>
                      <CopyButton text={JSON.stringify(result.jsonLd, null, 2)} label="Copy JSON-LD" />
                      <pre style={pre}>{JSON.stringify(result.jsonLd, null, 2)}</pre>
                    </>
                  ) : (
                    <div style={muted}>No JSON-LD for this document.</div>
                  )}
                  <h4 style={{ margin: '4px 0 0', fontSize: 13 }}>Plugin checks</h4>
                  <CheckList checks={result.validation} />
                  <div style={{ ...muted, fontSize: 12 }}>
                    Passing means the plugin's rules pass. It is not Google rich result eligibility or full schema.org validation.
                  </div>
                  <PublicLinks result={result} />
                </>
              )}
              {tab === 'Fields' && (
                <>
                  <div style={{ ...muted, fontSize: 12 }}>Which document field fed each output value, and the fallback used when it was empty.</div>
                  <Diagnostics rows={result.diagnostics} />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PublicLinks({ result }: { result: PanelInspection }) {
  const links = result.publicLinks
  if (!links || (!links.page && !links.markdown && !links.jsonLd)) {
    return <div style={{ ...muted, fontSize: 12 }}>Live public output: not available until the document is saved, published and public.</div>
  }
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      <strong>Live public output (published version)</strong>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {links.page && <a href={links.page} target="_blank" rel="noreferrer">Page</a>}
        {links.markdown && <a href={links.markdown} target="_blank" rel="noreferrer">Markdown</a>}
        {links.jsonLd && <a href={links.jsonLd} target="_blank" rel="noreferrer">JSON-LD</a>}
        {result.validators?.map((v) => <a key={v.name} href={v.url} target="_blank" rel="noreferrer">{v.name}</a>)}
      </div>
    </div>
  )
}
