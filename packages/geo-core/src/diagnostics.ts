/**
 * Setup diagnostics shared by the Payload and Strapi admin "Setup status" view.
 *
 * Three kinds of evidence are kept apart:
 * - configuration checks (what the CMS can see in its own config),
 * - active checks (an admin-triggered request to the configured site, with SSRF limits),
 * - recent ingest evidence (the newest stored hit, recent ingest results in this process).
 *
 * Anything without evidence is `unknown`, never a green pass.
 */
import { ipInRanges, parseCIDR, parseIP } from './cidr.js'
import { markdownURL } from './llms.js'

// No Node imports here: geo-core also runs in edge runtimes. Adapters pass a DNS resolver.
function isIP(value: string): 4 | 6 | 0 {
  const parsed = parseIP(value)
  return parsed ? (parsed.version === 4 ? 4 : 6) : 0
}

export type DiagnosticStatus = 'pass' | 'warning' | 'error' | 'unknown' | 'notEnabled'

export interface DiagnosticItem {
  id: string
  status: DiagnosticStatus
  title: string
  detail: string
  /** What to do, or how to check by hand. */
  suggestion?: string
}

// ---------- Probe tokens: test traffic that is recognised and never stored ----------

const PROBE_PATTERN = /GeoProbe\/([a-f0-9]{32})/

interface ProbeState {
  createdAt: number
  received?: { at: string; outcome: 'ok' | 'invalid-secret' | 'disabled'; path?: string; host?: string | null }
}

/**
 * One-time tokens for diagnostic requests. The CMS creates a token, sends a request to the frontend whose
 * User-Agent carries it, and the ingest endpoint recognises the token when the frontend proxy reports the
 * request: the hit is recorded as diagnostic evidence and not stored, so it never counts as traffic.
 * Only tokens this process issued in the last 10 minutes count; a made-up token is an ordinary hit.
 */
export class ProbeRegistry {
  private probes = new Map<string, ProbeState>()
  constructor(private ttlMs = 10 * 60_000) {}

  create(): string {
    this.prune()
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    this.probes.set(token, { createdAt: Date.now() })
    return token
  }

  /** The issued token in a User-Agent, or null. */
  match(userAgent: string | null | undefined): string | null {
    const token = userAgent ? PROBE_PATTERN.exec(userAgent)?.[1] : undefined
    if (!token) return null
    this.prune()
    return this.probes.has(token) ? token : null
  }

  record(token: string, outcome: NonNullable<ProbeState['received']>['outcome'], hit?: { path?: string; host?: string | null }) {
    const probe = this.probes.get(token)
    if (probe && !probe.received) probe.received = { at: new Date().toISOString(), outcome, ...hit }
  }

  result(token: string): ProbeState['received'] | undefined {
    return this.probes.get(token)?.received
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs
    for (const [k, v] of this.probes) if (v.createdAt < cutoff) this.probes.delete(k)
  }
}

export function probeUserAgent(token: string): string {
  return `Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot) GeoProbe/${token}`
}

/** Finds an issued probe token in an ingest body (one hit or a batch), without trusting anything else in it. */
export function findProbeInBody(body: unknown, probes: ProbeRegistry): { token: string; path?: string; host?: string | null } | null {
  const list = Array.isArray(body) ? body : ((body as { hits?: unknown })?.hits ?? [body])
  if (!Array.isArray(list)) return null
  for (const item of list.slice(0, 100)) {
    const token = probes.match((item as { userAgent?: string })?.userAgent)
    if (token) return { token, path: (item as { path?: string }).path, host: (item as { host?: string | null }).host ?? null }
  }
  return null
}

// ---------- Ingest evidence kept in memory ----------

export interface IngestEvent {
  at: string
  status: number
  /** Short reason, never the secret or the request body. */
  error?: string
  stored?: number
}

/** Recent ingest results of this process (lost on restart; the newest stored hit is the durable evidence). */
export class IngestLog {
  lastSuccess: string | null = null
  private errors: IngestEvent[] = []
  record(event: IngestEvent) {
    if (event.status === 200) this.lastSuccess = event.at
    else this.errors = [event, ...this.errors].slice(0, 10)
  }
  recentErrors(): IngestEvent[] {
    return [...this.errors]
  }
}

// ---------- Safe fetch for active checks ----------

export interface SafeFetchOptions {
  /** Only URLs on these origins may be fetched (the configured site). */
  allowedOrigins: string[]
  /** Allow loopback / private network addresses (local development). Default false. */
  allowPrivateNetwork?: boolean
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Resolves a host name to IP addresses (e.g. `dns.promises.lookup`). Required unless `allowPrivateNetwork`. */
  resolve?: (host: string) => Promise<string[]>
}

export interface SafeResponse {
  status: number
  url: string
  contentType: string
  body: string
  truncated: boolean
}

const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '198.18.0.0/15', '224.0.0.0/3', '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8',
].map((c) => parseCIDR(c)!)

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses (IPv4-mapped IPv6 included). Unparseable counts as private. */
export function isPrivateAddress(ip: string): boolean {
  if (!parseIP(ip)) return true
  return ipInRanges(ip, PRIVATE_RANGES)
}

async function noResolver(host: string): Promise<string[]> {
  if (isIP(host)) return [host]
  throw new BlockedURLError('no DNS resolver was passed, so the address cannot be checked')
}

export class BlockedURLError extends Error {}

/**
 * GET with SSRF limits: only the allowed origins, no private addresses unless allowed, limited redirects
 * (each re-checked), a timeout and a body size cap.
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const allowed = new Set(options.allowedOrigins.map((o) => new URL(o).origin))
  const doFetch = options.fetch ?? globalThis.fetch
  const resolve = options.resolve ?? noResolver
  const maxBytes = options.maxBytes ?? 256 * 1024
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  try {
    let current = new URL(url)
    for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new BlockedURLError(`blocked protocol ${current.protocol}`)
      if (!allowed.has(current.origin)) throw new BlockedURLError(`${current.origin} is not the configured site`)
      if (!options.allowPrivateNetwork) {
        const host = current.hostname.replace(/^\[|\]$/g, '')
        const addresses = await resolve(host)
        if (!addresses.length || addresses.some(isPrivateAddress)) {
          throw new BlockedURLError(`${host} resolves to a private or loopback address; set diagnostics.allowPrivateNetwork for local development`)
        }
      }
      const res = await doFetch(current, { redirect: 'manual', headers: options.headers, signal: controller.signal })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current)
        continue
      }
      let body = ''
      let truncated = false
      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) {
            truncated = true
            body += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (size - maxBytes))))
            await reader.cancel()
            break
          }
          body += decoder.decode(value, { stream: true })
        }
      }
      return { status: res.status, url: current.href, contentType: res.headers.get('content-type') ?? '', body, truncated }
    }
    throw new BlockedURLError('too many redirects')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

// ---------- Config and evidence ----------

export interface SetupFacts {
  llmsConfigured: boolean
  siteURL?: string
  /** Configured collections / content types and whether each exists in the CMS. */
  sources: Array<{ name: string; exists: boolean; publicDocuments: number | null; note?: string }>
  /** A public document to test against, if any. */
  sample?: { url: string; title: string }
  markdownLinks: boolean
  ingestEnabled: boolean
  secretConfigured: boolean
  verifyIPs: boolean
  /** AI referral collection: undefined when the adapter doesn't support it. */
  referralsEnabled?: boolean
  /** Newest stored hit, any verification. */
  latestHit: { timestamp: string; botName?: string; path: string; host?: string | null } | null
  lastIngestSuccess: string | null
  recentIngestErrors: IngestEvent[]
}

export function configChecks(f: SetupFacts): DiagnosticItem[] {
  const items: DiagnosticItem[] = []
  if (!f.llmsConfigured) {
    items.push({ id: 'CFG-LLMS', status: 'notEnabled', title: 'llms.txt, Markdown and JSON-LD', detail: 'Not configured.', suggestion: 'Add the `llms` option to serve them.' })
  } else {
    let siteOK = false
    try {
      const u = new URL(f.siteURL ?? '')
      siteOK = u.protocol === 'https:' || u.protocol === 'http:'
      const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
      items.push(
        !siteOK
          ? { id: 'CFG-SITE', status: 'error', title: 'siteURL', detail: `${f.siteURL} is not an http(s) URL.`, suggestion: 'Set llms.siteURL to the public frontend URL.' }
          : u.pathname !== '/' && u.pathname !== ''
            ? { id: 'CFG-SITE', status: 'warning', title: 'siteURL', detail: `${f.siteURL} has a path; URLs are joined onto it.`, suggestion: 'Usually siteURL is just the origin.' }
            : local || u.protocol === 'http:'
              ? { id: 'CFG-SITE', status: 'warning', title: 'siteURL', detail: `${f.siteURL} is ${local ? 'a local address' : 'not https'}.`, suggestion: 'Use the public https URL in production.' }
              : { id: 'CFG-SITE', status: 'pass', title: 'siteURL', detail: f.siteURL! },
      )
    } catch {
      items.push({ id: 'CFG-SITE', status: 'error', title: 'siteURL', detail: `${f.siteURL ?? '(empty)'} is not a URL.`, suggestion: 'Set llms.siteURL.' })
    }
    for (const s of f.sources) {
      items.push(
        !s.exists
          ? { id: `CFG-SOURCE:${s.name}`, status: 'error', title: `Mapping: ${s.name}`, detail: 'Does not exist in the CMS.', suggestion: 'Fix the collection slug / content type UID in the config.' }
          : s.publicDocuments === 0
            ? { id: `CFG-SOURCE:${s.name}`, status: 'warning', title: `Mapping: ${s.name}`, detail: `No public documents${s.note ? `: ${s.note}` : '.'}`, suggestion: 'Publish content and allow anonymous read access.' }
            : { id: `CFG-SOURCE:${s.name}`, status: 'pass', title: `Mapping: ${s.name}`, detail: `${s.publicDocuments ?? '?'} public documents.` },
      )
    }
    items.push(
      f.sample
        ? { id: 'CFG-SAMPLE', status: 'pass', title: 'Sample public document', detail: `${f.sample.title} → ${f.sample.url}` }
        : { id: 'CFG-SAMPLE', status: 'warning', title: 'Sample public document', detail: 'No public document with a URL, so llms.txt is empty.', suggestion: 'Publish one, and check `url()`.' },
    )
  }
  items.push(
    f.ingestEnabled
      ? { id: 'CFG-INGEST', status: 'pass', title: 'Crawler ingest', detail: 'Enabled.' }
      : { id: 'CFG-INGEST', status: 'notEnabled', title: 'Crawler ingest', detail: 'Disabled: the CMS answers 503 and stores nothing.' },
  )
  items.push(
    f.secretConfigured
      ? { id: 'CFG-SECRET', status: 'pass', title: 'Ingest secret', detail: 'Configured (the value is never shown).' }
      : { id: 'CFG-SECRET', status: 'warning', title: 'Ingest secret', detail: 'Not configured: anyone can post hits.', suggestion: 'Set the same secret in the CMS plugin and the frontend proxy.' },
  )
  items.push({ id: 'CFG-VERIFY', status: f.verifyIPs ? 'pass' : 'warning', title: 'IP verification', detail: f.verifyIPs ? 'On: hits are checked against published ranges.' : 'Off: every hit is unverifiable.' })
  if (f.referralsEnabled !== undefined) {
    items.push(
      !f.referralsEnabled
        ? { id: 'CFG-REFERRALS', status: 'notEnabled', title: 'AI referral visits', detail: 'Off (default). No visitor data is collected.', suggestion: 'Set `referrals: { enabled: true }` in the plugin and `referrals` in withGeo() to count visits from AI assistants.' }
        : !f.secretConfigured
          ? { id: 'CFG-REFERRALS', status: 'error', title: 'AI referral visits', detail: 'Enabled, but no secret is set, so reports are refused.', suggestion: 'Set GEO_SECRET in both the CMS and the frontend.' }
          : { id: 'CFG-REFERRALS', status: 'pass', title: 'AI referral visits', detail: 'On: the frontend reports browser visits whose Referer is a known AI assistant (host and landing path only).' },
    )
  }
  return items
}

export function evidenceChecks(f: SetupFacts): DiagnosticItem[] {
  const items: DiagnosticItem[] = []
  items.push(
    f.latestHit
      ? { id: 'EV-LATEST', status: 'pass', title: 'Latest stored crawler hit', detail: `${f.latestHit.timestamp} · ${f.latestHit.botName ?? ''} ${f.latestHit.path}${f.latestHit.host ? ` (${f.latestHit.host})` : ''}` }
      : {
          id: 'EV-LATEST',
          status: 'unknown',
          title: 'Latest stored crawler hit',
          detail: 'No data received yet. A new or quiet site may simply have had no AI crawler visits; this is not an error.',
          suggestion: 'Run the test below, or follow the manual steps.',
        },
  )
  items.push(
    f.lastIngestSuccess
      ? { id: 'EV-INGEST', status: 'pass', title: 'Last successful report (since restart)', detail: f.lastIngestSuccess }
      : { id: 'EV-INGEST', status: 'unknown', title: 'Last successful report (since restart)', detail: 'None since the CMS started.' },
  )
  const errors = f.recentIngestErrors
  items.push(
    errors.length
      ? {
          id: 'EV-ERRORS',
          status: errors[0]!.error === 'invalid secret' ? 'error' : 'warning',
          title: 'Recent rejected reports',
          detail: errors.slice(0, 5).map((e) => `${e.at} ${e.status} ${e.error ?? ''}`).join('\n'),
          suggestion: errors[0]!.error === 'invalid secret' ? 'The frontend sends a different secret: check GEO_SECRET on both sides.' : undefined,
        }
      : { id: 'EV-ERRORS', status: 'pass', title: 'Recent rejected reports', detail: 'None since the CMS started.' },
  )
  return items
}

/** Steps to verify by hand, for split deployments the CMS can't see into. */
export function manualSteps(siteURL: string | undefined, samplePath: string | undefined): string[] {
  const site = siteURL?.replace(/\/+$/, '') ?? 'https://your-site'
  const page = `${site}${samplePath ?? '/'}`
  return [
    `curl -A "GPTBot/1.2" -I ${page}   # then check that a hit appears in AI Crawler Hits`,
    `curl ${markdownURL(page)}   # Markdown version (needs withGeo({ markdown }))`,
    `curl -H "Accept: text/markdown" ${page}`,
    `curl ${site}/llms.txt   # needs the llmsRoute in the frontend`,
    `curl -s ${page} | grep application/ld+json   # JSON-LD rendered in the page`,
  ]
}

// ---------- Active checks ----------

export interface ActiveCheckOptions extends Omit<SafeFetchOptions, 'headers' | 'allowedOrigins'> {
  siteURL: string
  sample?: { url: string; title: string }
  probes?: ProbeRegistry
  /** How long to wait for the proxy's report of the probe request. Default 4000 ms. */
  probeWaitMs?: number
  ingestEnabled: boolean
  /** AI referral collection is enabled in the CMS: also test that the proxy reports a visit from an AI referrer. */
  referralsEnabled?: boolean
  /** Set when the frontend is a different deployment, to word unknown results. */
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function attempt(id: string, title: string, run: () => Promise<DiagnosticItem>): Promise<DiagnosticItem> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof BlockedURLError) return { id, status: 'error', title, detail: `Blocked: ${error.message}` }
    const name = (error as Error)?.name
    return {
      id,
      status: 'unknown',
      title,
      detail: name === 'AbortError' || name === 'TimeoutError' ? 'Timed out or cancelled.' : `Request failed: ${(error as Error)?.message ?? error}`,
      suggestion: 'Check that the site is reachable from the CMS server.',
    }
  }
}

/**
 * Requests the configured site the way an AI crawler would and checks each response type. A failed check
 * only reports; it never changes anything on the site.
 */
export async function runActiveChecks(options: ActiveCheckOptions): Promise<DiagnosticItem[]> {
  const site = new URL(options.siteURL)
  const base = { ...options, allowedOrigins: [site.origin] }
  const items: DiagnosticItem[] = []
  const sample = options.sample
  const token = options.probes?.create()

  if (!sample) {
    items.push({ id: 'ACT-HTML', status: 'unknown', title: 'Article page', detail: 'No public document to test.' })
  } else {
    items.push(
      await attempt('ACT-HTML', 'Article page (HTML)', async () => {
        const res = await safeFetch(sample.url, { ...base, headers: { 'user-agent': token ? probeUserAgent(token) : 'GeoDiagnostics', accept: 'text/html' } })
        if (res.status !== 200) return { id: 'ACT-HTML', status: 'error', title: 'Article page (HTML)', detail: `${sample.url} answered ${res.status}.`, suggestion: 'Check `url()` and that the page exists on the frontend.' }
        if (!/text\/html/i.test(res.contentType)) return { id: 'ACT-HTML', status: 'warning', title: 'Article page (HTML)', detail: `Answered ${res.contentType || 'no content type'} instead of HTML.` }
        return { id: 'ACT-HTML', status: 'pass', title: 'Article page (HTML)', detail: `${sample.url} answered 200 HTML.` }
      }),
    )
    items.push(
      await attempt('ACT-JSONLD', 'JSON-LD in the page', async () => {
        const res = await safeFetch(sample.url, { ...base, headers: { 'user-agent': 'GeoDiagnostics', accept: 'text/html' } })
        const found = /<script[^>]+application\/ld\+json/i.test(res.body)
        return found
          ? { id: 'ACT-JSONLD', status: 'pass', title: 'JSON-LD in the page', detail: 'A JSON-LD script tag is rendered.' }
          : { id: 'ACT-JSONLD', status: res.truncated ? 'unknown' : 'notEnabled', title: 'JSON-LD in the page', detail: res.truncated ? 'Page too large to check fully.' : 'No JSON-LD script tag found.', suggestion: 'Render fetchJsonLd + jsonLdScriptProps in the page.' }
      }),
    )
    items.push(
      await attempt('ACT-MD', 'Markdown version (.md)', async () => {
        const url = markdownURL(sample.url)
        const res = await safeFetch(url, { ...base, headers: { 'user-agent': 'GeoDiagnostics' } })
        if (res.status === 200 && /text\/markdown/i.test(res.contentType)) return { id: 'ACT-MD', status: 'pass', title: 'Markdown version (.md)', detail: `${url} answered Markdown.` }
        return { id: 'ACT-MD', status: 'notEnabled', title: 'Markdown version (.md)', detail: `${url} answered ${res.status} ${res.contentType}.`, suggestion: 'Pass `markdown: { source }` to withGeo in the frontend.' }
      }),
    )
    items.push(
      await attempt('ACT-ACCEPT', 'Accept: text/markdown', async () => {
        const res = await safeFetch(sample.url, { ...base, headers: { 'user-agent': 'GeoDiagnostics', accept: 'text/markdown' } })
        if (res.status === 200 && /text\/markdown/i.test(res.contentType)) return { id: 'ACT-ACCEPT', status: 'pass', title: 'Accept: text/markdown', detail: 'The page answers Markdown when asked for it.' }
        return { id: 'ACT-ACCEPT', status: 'notEnabled', title: 'Accept: text/markdown', detail: `Answered ${res.status} ${res.contentType}.`, suggestion: 'withGeo({ markdown }) with `negotiate` left on.' }
      }),
    )
  }
  items.push(
    await attempt('ACT-LLMS', 'llms.txt on the site', async () => {
      const url = `${site.origin}/llms.txt`
      const res = await safeFetch(url, { ...base, headers: { 'user-agent': 'GeoDiagnostics' } })
      if (res.status === 200 && /text\/plain|text\/markdown/i.test(res.contentType) && res.body.startsWith('# ')) return { id: 'ACT-LLMS', status: 'pass', title: 'llms.txt on the site', detail: `${url} answered.` }
      return { id: 'ACT-LLMS', status: 'notEnabled', title: 'llms.txt on the site', detail: `${url} answered ${res.status} ${res.contentType}.`, suggestion: 'Add app/llms.txt/route.ts with llmsRoute().' }
    }),
  )

  if (token && sample) {
    const sleep = options.sleep ?? wait
    const deadline = Date.now() + (options.probeWaitMs ?? 4000)
    let got = options.probes!.result(token)
    while (!got && Date.now() < deadline && !options.signal?.aborted) {
      await sleep(250)
      got = options.probes!.result(token)
    }
    items.push(
      !got
        ? {
            id: 'ACT-PROBE',
            status: 'unknown',
            title: 'Frontend proxy reports to the CMS',
            detail: options.ingestEnabled ? 'Not verified yet: no report of the test request arrived.' : 'Ingest is disabled.',
            suggestion: 'Check that the proxy runs on article pages and GEO_INGEST_URL points at this CMS. Reports can arrive late on some hosts: run the test again.',
          }
        : got.outcome === 'ok'
          ? { id: 'ACT-PROBE', status: 'pass', title: 'Frontend proxy reports to the CMS', detail: `Report received with a valid secret at ${got.at}${got.host ? ` from ${got.host}` : ''}. The test request was not stored.` }
          : got.outcome === 'disabled'
            ? { id: 'ACT-PROBE', status: 'notEnabled', title: 'Frontend proxy reports to the CMS', detail: 'Report arrived but ingest is disabled.' }
            : { id: 'ACT-PROBE', status: 'error', title: 'Frontend proxy reports to the CMS', detail: 'Report arrived with a wrong or missing secret.', suggestion: 'Use the same secret in the CMS plugin and withGeo().' },
    )
  }

  if (options.referralsEnabled && options.probes && sample) {
    const title = 'Frontend proxy reports AI referral visits'
    const refToken = options.probes.create()
    const sent = await attempt('ACT-REFERRAL', title, async () => {
      await safeFetch(sample.url, {
        ...base,
        headers: { 'user-agent': `Mozilla/5.0 (GeoDiagnostics) GeoProbe/${refToken}`, accept: 'text/html', referer: 'https://chatgpt.com/', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
      })
      return { id: 'ACT-REFERRAL', status: 'pass', title, detail: '' }
    })
    if (sent.status !== 'pass') items.push(sent)
    else {
      const sleep = options.sleep ?? wait
      const deadline = Date.now() + (options.probeWaitMs ?? 4000)
      let got = options.probes.result(refToken)
      while (!got && Date.now() < deadline && !options.signal?.aborted) {
        await sleep(250)
        got = options.probes.result(refToken)
      }
      items.push(
        !got
          ? {
              id: 'ACT-REFERRAL',
              status: 'unknown',
              title,
              detail: 'Not verified yet: no report of the test visit (Referer chatgpt.com) arrived.',
              suggestion: 'Pass `referrals: { endpoint }` to withGeo() and check that it points at this CMS. Reports can arrive late on some hosts: run the test again.',
            }
          : got.outcome === 'ok'
            ? { id: 'ACT-REFERRAL', status: 'pass', title, detail: `Test visit reported at ${got.at}. It was recognised as a test and not stored or counted.` }
            : { id: 'ACT-REFERRAL', status: 'error', title, detail: 'Report arrived with a wrong or missing secret.', suggestion: 'Use the same secret in the CMS plugin and withGeo().' },
      )
    }
  }
  return items
}
