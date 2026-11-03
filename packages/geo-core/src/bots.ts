/**
 * Known AI crawlers.
 *
 * `purpose` separates the signals the dashboard cares about:
 * - `training`: bulk crawling for model training. Means the content was collected.
 * - `search`: indexing for an AI search product. Means the content can be surfaced.
 * - `user`: a fetch made while a real user was asking the assistant a question.
 *   This is the strongest "AI used your page to answer someone" signal.
 */
export type BotPurpose = 'training' | 'search' | 'user'

export interface BotDefinition {
  /** Stable id stored with each hit, e.g. `gptbot`. */
  id: string
  /** Display name, e.g. `GPTBot`. */
  name: string
  /** Platform the bot belongs to, e.g. `OpenAI`. */
  platform: string
  purpose: BotPurpose
  /** Case-insensitive substring matched against the User-Agent. */
  uaToken: string
  /**
   * URL of the vendor's published IP ranges, in the
   * `{ prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }` format.
   * Bots without a published list can only be reported as `unverifiable`.
   */
  ipRangesUrl?: string
  /** Static CIDR ranges for bots whose vendor publishes them elsewhere (checked before `ipRangesUrl`). */
  ipRanges?: readonly string[]
  /**
   * Custom IP check, e.g. reverse DNS. Return `verified`, `spoofed` or `unverifiable`. Runs in the CMS with a
   * time limit; a throw or timeout counts as `unverifiable`. Takes precedence over the ranges.
   */
  verify?: (ip: string, bot: BotDefinition) => 'verified' | 'spoofed' | 'unverifiable' | Promise<'verified' | 'spoofed' | 'unverifiable'>
}

export const AI_BOTS: readonly BotDefinition[] = [
  // OpenAI
  { id: 'gptbot', name: 'GPTBot', platform: 'OpenAI', purpose: 'training', uaToken: 'GPTBot', ipRangesUrl: 'https://openai.com/gptbot.json' },
  { id: 'oai-searchbot', name: 'OAI-SearchBot', platform: 'OpenAI', purpose: 'search', uaToken: 'OAI-SearchBot', ipRangesUrl: 'https://openai.com/searchbot.json' },
  { id: 'chatgpt-user', name: 'ChatGPT-User', platform: 'OpenAI', purpose: 'user', uaToken: 'ChatGPT-User', ipRangesUrl: 'https://openai.com/chatgpt-user.json' },
  // Anthropic
  { id: 'claudebot', name: 'ClaudeBot', platform: 'Anthropic', purpose: 'training', uaToken: 'ClaudeBot' },
  { id: 'claude-searchbot', name: 'Claude-SearchBot', platform: 'Anthropic', purpose: 'search', uaToken: 'Claude-SearchBot' },
  { id: 'claude-user', name: 'Claude-User', platform: 'Anthropic', purpose: 'user', uaToken: 'Claude-User' },
  // Perplexity
  { id: 'perplexitybot', name: 'PerplexityBot', platform: 'Perplexity', purpose: 'search', uaToken: 'PerplexityBot', ipRangesUrl: 'https://www.perplexity.com/perplexitybot.json' },
  { id: 'perplexity-user', name: 'Perplexity-User', platform: 'Perplexity', purpose: 'user', uaToken: 'Perplexity-User', ipRangesUrl: 'https://www.perplexity.com/perplexity-user.json' },
  // Google (Googlebot itself is classic search and intentionally not listed)
  { id: 'google-cloudvertexbot', name: 'Google-CloudVertexBot', platform: 'Google', purpose: 'training', uaToken: 'Google-CloudVertexBot' },
  // Meta
  { id: 'meta-externalagent', name: 'Meta-ExternalAgent', platform: 'Meta', purpose: 'training', uaToken: 'meta-externalagent' },
  { id: 'meta-externalfetcher', name: 'Meta-ExternalFetcher', platform: 'Meta', purpose: 'user', uaToken: 'meta-externalfetcher' },
  // Others
  { id: 'bytespider', name: 'Bytespider', platform: 'ByteDance', purpose: 'training', uaToken: 'Bytespider' },
  { id: 'amazonbot', name: 'Amazonbot', platform: 'Amazon', purpose: 'search', uaToken: 'Amazonbot' },
  { id: 'applebot', name: 'Applebot', platform: 'Apple', purpose: 'search', uaToken: 'Applebot' },
  { id: 'ccbot', name: 'CCBot', platform: 'Common Crawl', purpose: 'training', uaToken: 'CCBot' },
  { id: 'duckassistbot', name: 'DuckAssistBot', platform: 'DuckDuckGo', purpose: 'user', uaToken: 'DuckAssistBot' },
  { id: 'mistralai-user', name: 'MistralAI-User', platform: 'Mistral', purpose: 'user', uaToken: 'MistralAI-User' },
  { id: 'cohere-ai', name: 'cohere-ai', platform: 'Cohere', purpose: 'training', uaToken: 'cohere-ai' },
  { id: 'youbot', name: 'YouBot', platform: 'You.com', purpose: 'search', uaToken: 'YouBot' },
]

/** Tokens so generic they would match ordinary browsers or unrelated crawlers. */
const TOO_BROAD = new Set(['bot', 'crawler', 'spider', 'mozilla', 'compatible', 'http', 'https', 'www', 'chrome', 'safari', 'agent', 'user', 'search', 'fetch', 'ai'])

export interface DefineBotsOptions {
  /** Bots the new ones are added to. Default `AI_BOTS`. */
  base?: readonly BotDefinition[]
  /** Ids of base bots the new list replaces (same id) instead of being refused as a duplicate. */
  replace?: boolean
}

/**
 * Adds your bots to the built-in list, validated: unique lowercase ids, a known purpose, and a User-Agent token
 * specific enough not to swallow other traffic (at least 4 characters, not a generic word, and not a substring
 * of an existing bot's token, which would make detection depend on token length alone). Throws on a mistake.
 *
 * Detection order is predictable: the longest token wins; equal lengths keep list order (base bots first).
 * Use the same list in the CMS plugin (`bots`) and in the frontend proxy (`bots`).
 */
export function defineBots(bots: readonly BotDefinition[], options: DefineBotsOptions = {}): BotDefinition[] {
  const base = [...(options.base ?? AI_BOTS)]
  const out = [...base]
  for (const bot of bots) {
    if (!bot || typeof bot !== 'object') throw new TypeError('[geo] a bot definition must be an object')
    const { id, name, platform, purpose, uaToken } = bot
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new TypeError(`[geo] invalid bot id "${String(id)}": lowercase letters, digits, . _ -`)
    if (typeof name !== 'string' || !name.trim() || typeof platform !== 'string' || !platform.trim()) throw new TypeError(`[geo] bot "${id}" needs a name and a platform`)
    if (purpose !== 'training' && purpose !== 'search' && purpose !== 'user') throw new TypeError(`[geo] bot "${id}" has purpose "${String(purpose)}"; use training, search or user`)
    if (typeof uaToken !== 'string' || uaToken.trim().length < 4)
      throw new TypeError(`[geo] bot "${id}": uaToken must be at least 4 characters`)
    const token = uaToken.toLowerCase()
    if (TOO_BROAD.has(token.replace(/[^a-z]/g, ''))) throw new TypeError(`[geo] bot "${id}": uaToken "${uaToken}" is too generic and would match other traffic`)
    if (bot.ipRangesUrl !== undefined && !/^https:\/\//.test(bot.ipRangesUrl)) throw new TypeError(`[geo] bot "${id}": ipRangesUrl must be https`)
    if (bot.verify !== undefined && typeof bot.verify !== 'function') throw new TypeError(`[geo] bot "${id}": verify must be a function`)
    const sameId = out.findIndex((b) => b.id === id)
    if (sameId !== -1) {
      if (!options.replace) throw new TypeError(`[geo] duplicate bot id "${id}" (pass { replace: true } to override a built-in bot)`)
      out.splice(sameId, 1)
    }
    const clash = out.find((b) => {
      const other = b.uaToken.toLowerCase()
      // A longer token containing an existing one (e.g. `GPTBot-Custom`) is fine: longest match wins.
      return other !== token && other.includes(token)
    })
    if (clash) throw new TypeError(`[geo] bot "${id}": uaToken "${uaToken}" is part of ${clash.name}'s token "${clash.uaToken}" and would be ambiguous`)
    if (out.some((b) => b.uaToken.toLowerCase() === token)) throw new TypeError(`[geo] bot "${id}": another bot already uses uaToken "${uaToken}"`)
    out.push({ ...bot })
  }
  return out
}

/**
 * Returns the AI bot a User-Agent claims to be, or `null`.
 * Longer tokens are checked first so `Claude-SearchBot` never matches a shorter token by accident;
 * equal lengths keep list order.
 */
export function detectBot(
  userAgent: string | null | undefined,
  bots: readonly BotDefinition[] = AI_BOTS,
): BotDefinition | null {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  const sorted = [...bots].sort((a, b) => b.uaToken.length - a.uaToken.length)
  return sorted.find((bot) => ua.includes(bot.uaToken.toLowerCase())) ?? null
}
