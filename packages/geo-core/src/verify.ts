import type { BotDefinition } from './bots.js'
import { ipInRanges, parseCIDR, type CIDR } from './cidr.js'

/**
 * - `verified`: the IP is inside the vendor's published ranges.
 * - `spoofed`: the vendor publishes ranges and the IP is outside them, so the User-Agent is fake.
 * - `unverifiable`: no published ranges, the list could not be fetched, or no IP was provided.
 */
export type Verification = 'verified' | 'spoofed' | 'unverifiable'

export interface IPVerifierOptions {
  /** How long a fetched range list is reused. Default 24 hours. */
  ttlMs?: number
  /** Injected for tests and non-standard runtimes. Defaults to global `fetch`. */
  fetch?: typeof fetch
  /** Override or add ranges per bot id, e.g. for bots with no public list. */
  staticRanges?: Record<string, string[]>
  /** Time limit of a bot's own `verify()` function. Default 2000 ms. */
  verifyTimeoutMs?: number
}

export interface IPVerifier {
  verify(bot: BotDefinition, ip: string | null | undefined): Promise<Verification>
}

interface CacheEntry {
  ranges: CIDR[]
  expiresAt: number
}

/** Parses the `{ prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }` format used by OpenAI, Perplexity and Google. */
export function parseRangeList(json: unknown): CIDR[] {
  const prefixes = (json as { prefixes?: unknown })?.prefixes
  if (!Array.isArray(prefixes)) return []
  const ranges: CIDR[] = []
  for (const entry of prefixes) {
    const raw = (entry as { ipv4Prefix?: string; ipv6Prefix?: string })?.ipv4Prefix ??
      (entry as { ipv6Prefix?: string })?.ipv6Prefix
    const cidr = typeof raw === 'string' ? parseCIDR(raw) : null
    if (cidr) ranges.push(cidr)
  }
  return ranges
}

export function createIPVerifier(options: IPVerifierOptions = {}): IPVerifier {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
  const doFetch = options.fetch ?? globalThis.fetch
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<CIDR[] | null>>()

  async function load(url: string): Promise<CIDR[] | null> {
    const cached = cache.get(url)
    if (cached && cached.expiresAt > Date.now()) return cached.ranges
    let pending = inflight.get(url)
    if (!pending) {
      pending = (async () => {
        try {
          const res = await doFetch(url, { headers: { accept: 'application/json' } })
          if (!res.ok) return cached?.ranges ?? null
          const ranges = parseRangeList(await res.json())
          if (ranges.length === 0) return cached?.ranges ?? null
          cache.set(url, { ranges, expiresAt: Date.now() + ttlMs })
          return ranges
        } catch {
          // Keep serving a stale list rather than marking real bots as unverifiable.
          return cached?.ranges ?? null
        } finally {
          inflight.delete(url)
        }
      })()
      inflight.set(url, pending)
    }
    return pending
  }

  const staticRanges = new Map(
    Object.entries(options.staticRanges ?? {}).map(([id, list]) => [
      id,
      list.map(parseCIDR).filter((c): c is CIDR => c !== null),
    ]),
  )

  const botRanges = new WeakMap<BotDefinition, CIDR[]>()
  const rangesOf = (bot: BotDefinition) => {
    if (!bot.ipRanges?.length) return null
    let list = botRanges.get(bot)
    if (!list) botRanges.set(bot, (list = bot.ipRanges.map(parseCIDR).filter((c): c is CIDR => c !== null)))
    return list
  }

  return {
    async verify(bot, ip) {
      if (!ip) return 'unverifiable'
      if (bot.verify) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => bot.verify!(ip, bot)),
            new Promise<'unverifiable'>((r) => (timer = setTimeout(() => r('unverifiable'), options.verifyTimeoutMs ?? 2000))),
          ])
          return result === 'verified' || result === 'spoofed' ? result : 'unverifiable'
        } catch {
          return 'unverifiable'
        } finally {
          clearTimeout(timer)
        }
      }
      const ranges = staticRanges.get(bot.id) ?? rangesOf(bot) ?? (bot.ipRangesUrl ? await load(bot.ipRangesUrl) : null)
      if (!ranges) return 'unverifiable'
      return ipInRanges(ip, ranges) ? 'verified' : 'spoofed'
    },
  }
}
