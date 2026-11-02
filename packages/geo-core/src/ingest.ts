import { AI_BOTS, detectBot, type BotDefinition, type BotPurpose } from './bots.js'
import type { IPVerifier, Verification } from './verify.js'
import { findProbeInBody, type IngestLog, type ProbeRegistry } from './diagnostics.js'

/** Header the frontend SDK uses to authenticate with the CMS ingest endpoint. */
export const GEO_SECRET_HEADER = 'x-geo-secret'

/** What the frontend SDK sends for each AI crawler request. */
export interface HitInput {
  path: string
  userAgent: string
  ip?: string | null
  method?: string
  /** Host the request was made to, useful when one CMS serves several frontends. */
  host?: string | null
  referer?: string | null
  /** ISO timestamp from the frontend. Defaults to the time of ingestion. */
  timestamp?: string
}

/** What a CMS adapter stores. */
export interface CrawlerHit {
  botId: string
  botName: string
  platform: string
  purpose: BotPurpose
  verification: Verification
  path: string
  host: string | null
  method: string
  ip: string | null
  userAgent: string
  referer: string | null
  timestamp: string
}

/** The only thing a CMS adapter has to implement. */
export interface HitStore {
  save(hit: CrawlerHit): Promise<void>
}

export interface IngestOptions {
  /** Shared secret. When set, requests without the matching header are rejected. */
  secret?: string
  store: HitStore
  /** Omit to skip IP verification (every hit becomes `unverifiable`). */
  verifier?: IPVerifier
  /** Store hits whose IP is outside the vendor's ranges. Default true, so spoofing shows up in the dashboard. */
  storeSpoofed?: boolean
  bots?: readonly BotDefinition[]
  /** Diagnostic probe tokens: matching hits are recorded as test evidence and never stored. */
  probes?: ProbeRegistry
  /** Records the outcome of each ingest call for the setup status view. */
  log?: IngestLog
}

export interface IngestResult {
  status: number
  body: { ok: boolean; error?: string; stored?: number; skipped?: number }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function asHitInputs(body: unknown): HitInput[] | null {
  const list = Array.isArray(body) ? body : (body as { hits?: unknown })?.hits ?? [body]
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) return null
  for (const item of list) {
    const hit = item as Partial<HitInput>
    if (!hit || typeof hit.path !== 'string' || typeof hit.userAgent !== 'string') return null
  }
  return list as HitInput[]
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Framework-agnostic ingest logic. Adapters pass in the parsed JSON body and the secret header,
 * then turn the result into their own response type.
 *
 * The User-Agent is re-classified here instead of trusting the frontend, and the IP is checked
 * against the vendor's published ranges.
 */
export async function ingestHits(
  body: unknown,
  providedSecret: string | null | undefined,
  options: IngestOptions,
): Promise<IngestResult> {
  const done = (result: IngestResult): IngestResult => {
    options.log?.record({ at: new Date().toISOString(), status: result.status, error: result.body.error, stored: result.body.stored })
    return result
  }
  if (options.secret && !(providedSecret && safeEqual(providedSecret, options.secret))) {
    const probe = options.probes && findProbeInBody(body, options.probes)
    if (probe) options.probes!.record(probe.token, 'invalid-secret', probe)
    return done({ status: 401, body: { ok: false, error: 'invalid secret' } })
  }
  const inputs = asHitInputs(body)
  if (!inputs) return done({ status: 400, body: { ok: false, error: 'invalid payload' } })

  let stored = 0
  let skipped = 0
  for (const input of inputs) {
    const probe = options.probes?.match(input.userAgent)
    if (probe) {
      // Diagnostic test request: evidence only, never counted as traffic.
      options.probes!.record(probe, 'ok', { path: input.path, host: input.host ?? null })
      skipped++
      continue
    }
    const bot = detectBot(input.userAgent, options.bots ?? AI_BOTS)
    if (!bot) {
      skipped++
      continue
    }
    const ip = clip(input.ip?.trim() || null, 64)
    const verification = options.verifier ? await options.verifier.verify(bot, ip) : 'unverifiable'
    if (verification === 'spoofed' && options.storeSpoofed === false) {
      skipped++
      continue
    }
    const timestamp = input.timestamp && !Number.isNaN(Date.parse(input.timestamp))
      ? new Date(input.timestamp).toISOString()
      : new Date().toISOString()
    await options.store.save({
      botId: bot.id,
      botName: bot.name,
      platform: bot.platform,
      purpose: bot.purpose,
      verification,
      path: clip(input.path, 2048)!,
      host: clip(input.host, 255),
      method: (input.method ?? 'GET').toUpperCase().slice(0, 10),
      ip,
      userAgent: clip(input.userAgent, 512)!,
      referer: clip(input.referer, 2048),
      timestamp,
    })
    stored++
  }
  return done({ status: 200, body: { ok: true, stored, skipped } })
}
