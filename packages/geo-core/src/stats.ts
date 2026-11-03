import { AI_BOTS, type BotPurpose } from './bots.js'
import type { CrawlerHit } from './ingest.js'
import { markdownSourcePath } from './llms.js'
import type { Verification } from './verify.js'

export type StatsHit = Pick<CrawlerHit, 'platform' | 'purpose' | 'verification' | 'path' | 'timestamp' | 'botId'>

export interface CrawlerStats {
  /** Set by the CMS plugins: the window reaches before the last retention cleanup, so older visits are missing. */
  historyIncomplete?: boolean
  /** Hits older than this were deleted by the last cleanup. */
  deletedBefore?: string | null
  from: string
  to: string
  days: number
  total: number
  /** Live user fetches (ChatGPT-User, Claude-User...): the strongest "used to answer someone" signal. */
  userFetches: number
  llmsTxtReads: number
  byPurpose: Record<BotPurpose, number>
  byVerification: Record<Verification, number>
  byPlatform: Array<{ platform: string; total: number; user: number }>
  /** One entry per day, oldest first, including empty days. */
  daily: Array<{ date: string; total: number; user: number }>
  topPaths: Array<{ path: string; total: number; user: number }>
  /** Known content URLs with no AI crawler hit in the window. Only set when `contentPaths` is passed. */
  neverCrawled?: string[]
  /** Share of known content crawled at least once, 0..1. */
  coverage?: number
}

export interface StatsOptions {
  days?: number
  now?: Date
  /** Frontend paths of all known content, to compute coverage and the never-crawled list. */
  contentPaths?: string[]
  /** Exclude hits marked `spoofed`. Default true. */
  excludeSpoofed?: boolean
  topPathsLimit?: number
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Strips query string, hash and trailing slash so `/a/?x=1` and `/a` count as one page. */
export function normalizePath(path: string): string {
  let p = path
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname
  } catch {
    // keep as is
  }
  p = p.split(/[?#]/)[0] ?? '/'
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

export function windowStart(days: number, now = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return start
}

export function summarizeHits(hits: StatsHit[], options: StatsOptions = {}): CrawlerStats {
  const days = Math.min(Math.max(Math.floor(options.days ?? 7), 1), 365)
  const now = options.now ?? new Date()
  const from = windowStart(days, now)
  const excludeSpoofed = options.excludeSpoofed ?? true

  const byPurpose: Record<BotPurpose, number> = { training: 0, search: 0, user: 0 }
  const byVerification: Record<Verification, number> = { verified: 0, spoofed: 0, unverifiable: 0 }
  const platforms = new Map<string, { total: number; user: number }>()
  const paths = new Map<string, { total: number; user: number }>()
  const daily = new Map<string, { total: number; user: number }>()
  for (let i = 0; i < days; i++) {
    const d = new Date(from)
    d.setUTCDate(d.getUTCDate() + i)
    daily.set(dayKey(d), { total: 0, user: 0 })
  }

  let total = 0
  let llmsTxtReads = 0
  for (const hit of hits) {
    const at = new Date(hit.timestamp)
    if (Number.isNaN(at.getTime()) || at < from || at > now) continue
    byVerification[hit.verification] = (byVerification[hit.verification] ?? 0) + 1
    if (excludeSpoofed && hit.verification === 'spoofed') continue
    const isUser = hit.purpose === 'user' ? 1 : 0
    total++
    byPurpose[hit.purpose]++
    // A read of `/blog/post.md` is a read of `/blog/post`.
    const normalized = normalizePath(hit.path)
    const path = markdownSourcePath(normalized) ?? normalized
    if (path === '/llms.txt' || path === '/llms-full.txt') llmsTxtReads++
    for (const [map, key] of [[platforms, hit.platform], [paths, path]] as const) {
      const entry = map.get(key) ?? { total: 0, user: 0 }
      entry.total++
      entry.user += isUser
      map.set(key, entry)
    }
    const day = daily.get(dayKey(at))
    if (day) {
      day.total++
      day.user += isUser
    }
  }

  const stats: CrawlerStats = {
    from: from.toISOString(),
    to: now.toISOString(),
    days,
    total,
    userFetches: byPurpose.user,
    llmsTxtReads,
    byPurpose,
    byVerification,
    byPlatform: [...platforms].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.total - a.total),
    daily: [...daily].map(([date, v]) => ({ date, ...v })),
    topPaths: [...paths]
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.user - a.user || b.total - a.total)
      .slice(0, options.topPathsLimit ?? 20),
  }

  if (options.contentPaths) {
    const content = [...new Set(options.contentPaths.map(normalizePath))]
    stats.neverCrawled = content.filter((p) => !paths.has(p))
    stats.coverage = content.length ? (content.length - stats.neverCrawled.length) / content.length : 0
  }
  return stats
}

/** Platforms in the bot list, for showing zero rows in the dashboard. */
export const KNOWN_PLATFORMS = [...new Set(AI_BOTS.map((b) => b.platform))]
