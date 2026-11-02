/**
 * AI referral visits: a browser landing on the site from an AI assistant, recognised by the Referer host.
 *
 * This is a traffic signal, not proof of every citation, and it can be forged by anyone sending a Referer
 * header, so it is never shown as verified. Only the referrer's host is kept; the full referrer URL, query
 * strings, IP addresses and User-Agents are never stored.
 */
import type { ProbeRegistry } from './diagnostics.js'
import { normalizePath, windowStart } from './stats.js'

export interface ReferrerRule {
  platform: string
  /** Hosts, matched exactly or as a parent domain (`perplexity.ai` matches `www.perplexity.ai`). Never a substring. */
  hosts: string[]
}

export const AI_REFERRERS: readonly ReferrerRule[] = [
  { platform: 'OpenAI', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { platform: 'Perplexity', hosts: ['perplexity.ai'] },
  { platform: 'Anthropic', hosts: ['claude.ai'] },
  { platform: 'Google', hosts: ['gemini.google.com', 'bard.google.com', 'aistudio.google.com'] },
  { platform: 'Microsoft', hosts: ['copilot.microsoft.com'] },
  { platform: 'DeepSeek', hosts: ['chat.deepseek.com'] },
  { platform: 'ByteDance', hosts: ['doubao.com'] },
  { platform: 'Moonshot', hosts: ['kimi.moonshot.cn', 'kimi.com'] },
  { platform: 'Mistral', hosts: ['chat.mistral.ai'] },
  { platform: 'xAI', hosts: ['grok.com'] },
  { platform: 'Meta', hosts: ['meta.ai'] },
  { platform: 'You.com', hosts: ['you.com'] },
  { platform: 'Poe', hosts: ['poe.com'] },
  { platform: 'Phind', hosts: ['phind.com'] },
  { platform: 'Yandex', hosts: ['alice.yandex.ru'] },
  { platform: 'Sber', hosts: ['giga.chat'] },
]

export type ReferralSource = 'referrer' | 'utm'

/** Platform name stored for an external referral that matches no rule. Never counted as an AI visit. */
export const UNKNOWN_PLATFORM = 'unknown'

export interface ReferralMatch {
  platform: string
  /** Where the signal came from: the Referer header, or an exact `utm_source=<known host>` when there was none. */
  source: ReferralSource
  /** Host only. */
  referrerHost: string
}

function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const r = rule.toLowerCase()
  return h === r || h.endsWith(`.${r}`)
}

export function matchReferrerHost(host: string, rules: readonly ReferrerRule[] = AI_REFERRERS): ReferrerRule | null {
  return rules.find((rule) => rule.hosts.some((r) => hostMatches(host, r))) ?? null
}

/**
 * Classifies a landing. The Referer wins; a `utm_source` only counts when there is no Referer and it is exactly
 * one of the known hosts (ChatGPT adds `utm_source=chatgpt.com`). Anything else is unknown (null).
 */
export function classifyReferral(
  input: { referrer?: string | null; url: string },
  rules: readonly ReferrerRule[] = AI_REFERRERS,
): ReferralMatch | null {
  if (input.referrer) {
    let host: string
    try {
      host = new URL(input.referrer).hostname
    } catch {
      return null
    }
    const rule = matchReferrerHost(host, rules)
    return rule ? { platform: rule.platform, source: 'referrer', referrerHost: host.toLowerCase() } : null
  }
  let utm: string | null = null
  try {
    utm = new URL(input.url, 'http://x').searchParams.get('utm_source')
  } catch {
    return null
  }
  if (!utm || !/^[a-z0-9.-]+$/i.test(utm)) return null
  const rule = rules.find((r) => r.hosts.some((h) => h === utm!.toLowerCase()))
  return rule ? { platform: rule.platform, source: 'utm', referrerHost: utm.toLowerCase() } : null
}

/** What the frontend proxy reports and the CMS stores. No IP, User-Agent or full referrer. */
export interface ReferralEvent {
  timestamp: string
  platform: string
  source: ReferralSource
  referrerHost: string
  /** Landing path without query string or hash. */
  path: string
  host: string | null
}

export interface ReferralInput {
  /** Landing URL path (query allowed; only `utm_source` is read, nothing is kept). */
  url: string
  referrer?: string | null
  host?: string | null
  /** Used only for rate limiting and de-duplication in memory, never stored. */
  ip?: string | null
  userAgent?: string | null
  timestamp?: string
}

export interface ReferralStore {
  save(event: ReferralEvent): Promise<void>
}

export interface ReferralIngestOptions {
  secret?: string
  store: ReferralStore
  rules?: readonly ReferrerRule[]
  limiter?: ReferralLimiter
  /** Diagnostic probe tokens in the User-Agent: recorded as test evidence, never stored or counted. */
  probes?: ProbeRegistry
  /**
   * Store external referrals that match no rule as platform `unknown` (host only), instead of dropping them.
   * Default false. They are never counted as AI visits.
   */
  recordUnknown?: boolean
}

/** Host of a referrer URL, or null when it is missing or not a URL. */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/\.$/, '')
    return host || null
  } catch {
    return null
  }
}

/**
 * In-memory duplicate filter and rate limits. Keys are hashed, kept for at most `dedupeMs`, and never stored,
 * so nothing links visits across days or sites.
 */
export class ReferralLimiter {
  private seen = new Map<string, number>()
  private perClient = new Map<string, { start: number; count: number }>()
  private global = { start: 0, count: 0 }
  constructor(
    private options: { dedupeMs?: number; perClientPerMinute?: number; globalPerMinute?: number } = {},
  ) {}

  private prune(now: number) {
    const ttl = this.options.dedupeMs ?? 30 * 60_000
    if (this.seen.size > 50_000) this.seen.clear()
    for (const [k, t] of this.seen) if (now - t > ttl) this.seen.delete(k)
    for (const [k, v] of this.perClient) if (now - v.start > 60_000) this.perClient.delete(k)
  }

  /** `limited` (too many), `duplicate` (same client, page and platform recently) or `ok`. */
  check(client: string, key: string, now = Date.now()): 'ok' | 'duplicate' | 'limited' {
    this.prune(now)
    if (now - this.global.start > 60_000) this.global = { start: now, count: 0 }
    if (++this.global.count > (this.options.globalPerMinute ?? 600)) return 'limited'
    const c = this.perClient.get(client) ?? { start: now, count: 0 }
    c.count++
    this.perClient.set(client, c)
    if (c.count > (this.options.perClientPerMinute ?? 20)) return 'limited'
    const dedupe = `${client}|${key}`
    if (this.seen.has(dedupe)) return 'duplicate'
    this.seen.set(dedupe, now)
    return 'ok'
  }
}

function simpleHash(value: string): string {
  // FNV-1a, enough for an in-memory key that is never stored.
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface ReferralIngestResult {
  status: number
  body: { ok: boolean; error?: string; stored?: number; skipped?: number; duplicates?: number; limited?: number }
}

/** Separate from crawler ingest: different endpoint, different store, same shared secret. */
export async function ingestReferrals(body: unknown, providedSecret: string | null | undefined, options: ReferralIngestOptions): Promise<ReferralIngestResult> {
  const list = Array.isArray(body) ? body : ((body as { events?: unknown })?.events ?? [body])
  if (!options.secret) return { status: 503, body: { ok: false, error: 'referral collection needs a secret' } }
  if (!(providedSecret && safeEqual(providedSecret, options.secret))) {
    if (options.probes && Array.isArray(list)) {
      for (const item of list.slice(0, 50)) {
        const token = options.probes.match((item as { userAgent?: string })?.userAgent)
        if (token) options.probes.record(token, 'invalid-secret')
      }
    }
    return { status: 401, body: { ok: false, error: 'invalid secret' } }
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) return { status: 400, body: { ok: false, error: 'invalid payload' } }
  let stored = 0
  let skipped = 0
  let duplicates = 0
  let limited = 0
  for (const raw of list) {
    const input = raw as Partial<ReferralInput>
    if (!input || typeof input.url !== 'string' || !input.url.startsWith('/') || input.url.length > 4096 || (input.referrer != null && typeof input.referrer !== 'string')) {
      skipped++
      continue
    }
    let path: string
    try {
      path = normalizePath(new URL(input.url, 'http://x').pathname).slice(0, 1024)
    } catch {
      skipped++
      continue
    }
    const host = typeof input.host === 'string' ? input.host.slice(0, 255).toLowerCase() : null
    const probe = options.probes?.match(typeof input.userAgent === 'string' ? input.userAgent : null)
    if (probe) {
      options.probes!.record(probe, 'ok', { path, host })
      skipped++
      continue
    }
    const referrer = typeof input.referrer === 'string' ? input.referrer.slice(0, 2048) : null
    const fromHost = referrerHost(referrer)
    // Navigation inside the site is not a referral.
    if (fromHost && host && fromHost === host.replace(/:\d+$/, '')) {
      skipped++
      continue
    }
    let match: ReferralMatch | null = classifyReferral({ referrer, url: input.url }, options.rules)
    if (!match && options.recordUnknown && (fromHost || referrer === null)) {
      let utm: string | null = null
      try {
        utm = new URL(input.url, 'http://x').searchParams.get('utm_source')
      } catch {}
      // The value of an unknown utm_source is not kept: it can be anything.
      if (fromHost) match = { platform: UNKNOWN_PLATFORM, source: 'referrer', referrerHost: fromHost }
      else if (utm) match = { platform: UNKNOWN_PLATFORM, source: 'utm', referrerHost: '' }
    }
    if (!match) {
      skipped++
      continue
    }
    const client = simpleHash(`${input.ip ?? ''}|${input.userAgent ?? ''}`)
    const verdict = options.limiter?.check(client, `${host}|${path}|${match.platform}`) ?? 'ok'
    if (verdict === 'duplicate') {
      duplicates++
      continue
    }
    if (verdict === 'limited') {
      limited++
      continue
    }
    const timestamp = input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) && Math.abs(Date.parse(input.timestamp) - Date.now()) < 3600_000
      ? new Date(input.timestamp).toISOString()
      : new Date().toISOString()
    await options.store.save({ timestamp, platform: match.platform, source: match.source, referrerHost: match.referrerHost.slice(0, 255), path, host })
    stored++
  }
  return { status: limited && !stored ? 429 : 200, body: { ok: true, stored, skipped, duplicates, limited } }
}

export interface ReferralStats {
  days: number
  from: string
  to: string
  /** Browser visits with a recognised AI referrer. */
  total: number
  /** External referrals that matched no rule (only when unknown referrals are recorded). Not in `total`. */
  unknown: number
  byPlatform: Array<{ platform: string; total: number }>
  bySource: Record<ReferralSource, number>
  daily: Array<{ date: string; total: number }>
  topPaths: Array<{ path: string; total: number }>
}

export function summarizeReferrals(events: Pick<ReferralEvent, 'timestamp' | 'platform' | 'source' | 'path'>[], options: { days?: number; now?: Date } = {}): ReferralStats {
  const days = Math.min(Math.max(Math.floor(options.days ?? 30), 1), 365)
  const now = options.now ?? new Date()
  const from = windowStart(days, now)
  const daily = new Map<string, number>()
  for (let i = 0; i < days; i++) {
    const d = new Date(from)
    d.setUTCDate(d.getUTCDate() + i)
    daily.set(d.toISOString().slice(0, 10), 0)
  }
  const platforms = new Map<string, number>()
  const paths = new Map<string, number>()
  const bySource: Record<ReferralSource, number> = { referrer: 0, utm: 0 }
  let total = 0
  let unknown = 0
  for (const e of events) {
    const at = new Date(e.timestamp)
    if (Number.isNaN(at.getTime()) || at < from || at > now) continue
    if (e.platform === UNKNOWN_PLATFORM) {
      unknown++
      continue
    }
    total++
    bySource[e.source] = (bySource[e.source] ?? 0) + 1
    platforms.set(e.platform, (platforms.get(e.platform) ?? 0) + 1)
    paths.set(e.path, (paths.get(e.path) ?? 0) + 1)
    const k = at.toISOString().slice(0, 10)
    if (daily.has(k)) daily.set(k, daily.get(k)! + 1)
  }
  return {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    total,
    unknown,
    byPlatform: [...platforms].map(([platform, n]) => ({ platform, total: n })).sort((a, b) => b.total - a.total),
    bySource,
    daily: [...daily].map(([date, n]) => ({ date, total: n })),
    topPaths: [...paths].map(([path, n]) => ({ path, total: n })).sort((a, b) => b.total - a.total).slice(0, 20),
  }
}

// ---------- Citation evidence (entered by hand) ----------

export type CitationStatus = 'pending' | 'verified' | 'invalid'

export interface CitationSummary {
  /** Recorded citation evidence, by review status. Not a count of all citations anywhere. */
  total: number
  byStatus: Record<CitationStatus, number>
  byPlatform: Array<{ platform: string; total: number; verified: number }>
  /** No automatic monitoring provider is configured unless this lists one. */
  providers: string[]
}

export function summarizeCitations(rows: Array<{ platform: string; status: CitationStatus }>, providers: string[] = []): CitationSummary {
  const byStatus: Record<CitationStatus, number> = { pending: 0, verified: 0, invalid: 0 }
  const platforms = new Map<string, { total: number; verified: number }>()
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const p = platforms.get(r.platform) ?? { total: 0, verified: 0 }
    p.total++
    if (r.status === 'verified') p.verified++
    platforms.set(r.platform, p)
  }
  return {
    total: rows.length,
    byStatus,
    byPlatform: [...platforms].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.total - a.total),
    providers,
  }
}

/**
 * De-duplication key of a citation record: platform + answer id + cited URL (normalized). Without an answer id
 * there is no key, and duplicates are left to the reviewer.
 */
export function citationKey(input: { platform?: string | null; answerId?: string | null; citedURL?: string | null }): string | null {
  if (!input.platform || !input.answerId?.trim() || !input.citedURL) return null
  let url = input.citedURL.trim()
  try {
    const u = new URL(url)
    url = `${u.host.toLowerCase()}${normalizePath(u.pathname)}`
  } catch {
    url = url.toLowerCase()
  }
  return `${input.platform.toLowerCase()}|${input.answerId.trim()}|${url}`
}

/** Placeholder for future automatic monitoring through an authorised API that returns verifiable citations. */
export interface CitationMonitorProvider {
  id: string
  name: string
  check(query: { question: string; url: string; language?: string; region?: string }): Promise<Array<{ answerId: string; answerURL?: string; citedURL: string; observedAt: string }>>
}

export const CITATION_PLATFORMS = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'Copilot', 'Google AI Overviews', 'DeepSeek', 'Doubao', 'Kimi', 'YandexGPT', 'GigaChat', 'Other'] as const
