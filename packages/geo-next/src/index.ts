import { AI_BOTS, GEO_SECRET_HEADER, detectBot, type BotDefinition, type HitInput } from '@garus-ltd/core'

/** Structural subset of Next's `NextFetchEvent`, so this also works in Cloudflare Workers and other Fetch runtimes. */
export interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void
}

export interface GeoTrackOptions {
  /** Absolute URL of the CMS ingest endpoint, e.g. `https://cms.example.com/api/geo/ingest`. */
  endpoint: string
  /** Must match the secret configured in the CMS plugin. */
  secret?: string
  bots?: readonly BotDefinition[]
  /** Return true to ignore a path. Static assets and Next internals are already ignored. */
  ignore?: (pathname: string) => boolean
  /** Called when reporting fails. Reporting never blocks or breaks the page response. */
  onError?: (error: unknown) => void
  fetch?: typeof fetch
}

const STATIC_PATH = /^\/(_next|_vercel|favicon\.ico)(\/|$)|\.(?:js|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)$/i

/** First hop of X-Forwarded-For, then the common single-IP headers. */
export function getClientIP(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('cf-connecting-ip') ?? headers.get('x-real-ip') ?? null
}

/**
 * Detects an AI crawler and reports it in the background.
 * Returns the detected bot (or null) so callers can also act on it, e.g. serve Markdown.
 */
export function trackAICrawler(
  request: Request,
  event: WaitUntilEvent,
  options: GeoTrackOptions,
): BotDefinition | null {
  const userAgent = request.headers.get('user-agent')
  const bot = detectBot(userAgent, options.bots ?? AI_BOTS)
  if (!bot || !userAgent) return null

  const url = new URL(request.url)
  if (STATIC_PATH.test(url.pathname) || options.ignore?.(url.pathname)) return null
  // Never report requests to the ingest endpoint itself.
  if (new URL(options.endpoint, url).pathname === url.pathname) return null

  const hit: HitInput = {
    path: url.pathname + url.search,
    userAgent,
    ip: getClientIP(request.headers),
    method: request.method,
    host: url.host,
    referer: request.headers.get('referer'),
    timestamp: new Date().toISOString(),
  }
  const doFetch = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.secret) headers[GEO_SECRET_HEADER] = options.secret

  event.waitUntil(
    doFetch(new URL(options.endpoint, url), { method: 'POST', headers, body: JSON.stringify(hit) })
      .then((res) => {
        if (!res.ok) throw new Error(`Headless GEO ingest responded ${res.status}`)
      })
      .catch((error: unknown) => (options.onError ?? console.warn)(error)),
  )
  return bot
}

type Handler<R> = (request: Request, event: WaitUntilEvent) => R

/**
 * Wraps an existing Next.js proxy / middleware, or acts as one on its own.
 *
 * ```ts
 * // proxy.ts (Next 16) or middleware.ts (Next 15)
 * import { withGeo } from '@garus-ltd/next'
 * export const proxy = withGeo({ endpoint: process.env.GEO_INGEST_URL!, secret: process.env.GEO_SECRET })
 * ```
 */
export function withGeo<R = undefined>(options: GeoTrackOptions, handler?: Handler<R>): Handler<R | undefined> {
  return (request, event) => {
    trackAICrawler(request, event, options)
    return handler?.(request, event)
  }
}

export interface LlmsRouteOptions {
  /** CMS URL serving the file, e.g. `https://cms.example.com/api/geo/llms.txt`. */
  source: string
  /** Seconds browsers and CDNs may cache the file. Default 300. */
  maxAge?: number
  fetch?: typeof fetch
}

/**
 * Route handler that serves the CMS-generated llms.txt from the frontend's own domain,
 * where AI assistants look for it.
 *
 * ```ts
 * // app/llms.txt/route.ts
 * import { llmsRoute } from '@garus-ltd/next'
 * export const GET = llmsRoute({ source: `${process.env.CMS_URL}/api/geo/llms.txt` })
 * ```
 */
export function llmsRoute(options: LlmsRouteOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const doFetch = options.fetch ?? globalThis.fetch
    const upstream = await doFetch(new URL(options.source, request.url), { headers: { accept: 'text/plain' } }).catch(
      () => null,
    )
    if (!upstream?.ok) return new Response('llms.txt is temporarily unavailable\n', { status: 502 })
    const maxAge = options.maxAge ?? 300
    return new Response(await upstream.text(), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 12}`,
      },
    })
  }
}
