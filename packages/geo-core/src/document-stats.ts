import type { BotPurpose } from './bots.js'
import type { CrawlerHit } from './ingest.js'
import { markdownSourcePath } from './llms.js'
import { normalizePath, windowStart } from './stats.js'
import type { Verification } from './verify.js'

export type DocumentHit = Pick<CrawlerHit, 'platform' | 'purpose' | 'verification' | 'path' | 'timestamp' | 'botId'> &
  Partial<Pick<CrawlerHit, 'host' | 'botName'>>

export interface DocumentStatsOptions {
  /** Frontend path of the document, e.g. `/blog/post`. Its `.md` version counts as the same page. */
  path: string
  /** Hosts of the site the document belongs to. Hits for other hosts are left out. Hits with no host are kept. */
  hosts?: string[]
  days?: number
  now?: Date
  /** Recent records to return. Default 20, max 100. */
  recentLimit?: number
}

export interface DocumentStats {
  path: string
  from: string
  to: string
  days: number
  /** Always UTC: days start at 00:00 UTC. */
  timeZone: 'UTC'
  /** Valid crawls: everything except `spoofed`. */
  total: number
  /** Live user fetches (purpose `user`), the "an assistant opened this page for someone" signal. */
  userFetches: number
  /** Requests for the `.md` version, already included in `total`. */
  markdownHits: number
  byPurpose: Record<BotPurpose, number>
  byVerification: Record<Verification, number>
  byPlatform: Array<{ platform: string; total: number; user: number }>
  daily: Array<{ date: string; total: number; user: number }>
  /** Last valid (non-spoofed) visit. */
  lastSeen: string | null
  /** Newest records first, spoofed included and marked, with the raw request path. */
  recent: Array<{ timestamp: string; platform: string; botId: string; purpose: BotPurpose; verification: Verification; path: string; host: string | null }>
  /** Hits left out because they were for another host. */
  otherHosts: number
}

/** The document path a hit is for, or null: query, hash and trailing slash are ignored, `.md` maps to the page. */
export function hitDocumentPath(rawPath: string): string {
  const normalized = normalizePath(rawPath)
  return markdownSourcePath(normalized) ?? normalized
}

function hostOf(value: string): string {
  return value.toLowerCase().replace(/:(80|443)$/, '')
}

/**
 * Stats for one document's page, from hits already narrowed down by the database (path prefix and time window).
 * The adapter must cap how many rows it loads.
 */
export function summarizeDocumentHits(hits: DocumentHit[], options: DocumentStatsOptions): DocumentStats {
  const days = Math.min(Math.max(Math.floor(options.days ?? 30), 1), 365)
  const now = options.now ?? new Date()
  const from = windowStart(days, now)
  const path = normalizePath(options.path)
  const hosts = options.hosts?.length ? new Set(options.hosts.map(hostOf)) : null

  const byPurpose: Record<BotPurpose, number> = { training: 0, search: 0, user: 0 }
  const byVerification: Record<Verification, number> = { verified: 0, spoofed: 0, unverifiable: 0 }
  const platforms = new Map<string, { total: number; user: number }>()
  const daily = new Map<string, { total: number; user: number }>()
  for (let i = 0; i < days; i++) {
    const d = new Date(from)
    d.setUTCDate(d.getUTCDate() + i)
    daily.set(d.toISOString().slice(0, 10), { total: 0, user: 0 })
  }
  const matched: DocumentHit[] = []
  let total = 0
  let markdownHits = 0
  let otherHosts = 0
  let lastSeen: string | null = null

  for (const hit of hits) {
    const at = new Date(hit.timestamp)
    if (Number.isNaN(at.getTime()) || at < from || at > now) continue
    if (hitDocumentPath(hit.path) !== path) continue
    if (hosts && hit.host && !hosts.has(hostOf(hit.host))) {
      otherHosts++
      continue
    }
    matched.push(hit)
    byVerification[hit.verification] = (byVerification[hit.verification] ?? 0) + 1
    if (hit.verification === 'spoofed') continue
    total++
    byPurpose[hit.purpose]++
    const isUser = hit.purpose === 'user' ? 1 : 0
    if (markdownSourcePath(normalizePath(hit.path)) !== null) markdownHits++
    const p = platforms.get(hit.platform) ?? { total: 0, user: 0 }
    p.total++
    p.user += isUser
    platforms.set(hit.platform, p)
    const day = daily.get(at.toISOString().slice(0, 10))
    if (day) {
      day.total++
      day.user += isUser
    }
    const iso = at.toISOString()
    if (!lastSeen || iso > lastSeen) lastSeen = iso
  }

  const limit = Math.min(Math.max(options.recentLimit ?? 20, 0), 100)
  const recent = matched
    .map((h) => ({ ...h, at: new Date(h.timestamp).toISOString() }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit)
    .map((h) => ({ timestamp: h.at, platform: h.platform, botId: h.botId, purpose: h.purpose, verification: h.verification, path: h.path, host: h.host ?? null }))

  return {
    path,
    from: from.toISOString(),
    to: now.toISOString(),
    days,
    timeZone: 'UTC',
    total,
    userFetches: byPurpose.user,
    markdownHits,
    byPurpose,
    byVerification,
    byPlatform: [...platforms].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.total - a.total),
    daily: [...daily].map(([date, v]) => ({ date, ...v })),
    lastSeen,
    recent,
    otherHosts,
  }
}

/** Raw paths a hit for this document can be stored under, for an exact `IN` query (the adapter adds a `path?` prefix query). */
export function documentPathVariants(path: string): string[] {
  const p = normalizePath(path)
  if (p === '/') return ['/', '/index.md']
  return [p, `${p}/`, `${p}.md`]
}
