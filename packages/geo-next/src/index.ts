import {
  AI_BOTS,
  AI_REFERRERS,
  GEO_SECRET_HEADER,
  GEO_SIGNATURE_HEADER,
  SeenEvents,
  classifyReferral,
  parseChangeEvent,
  parseSegmentFile,
  verifyChangeSignature,
  type ContentChangeEvent,
  detectBot,
  markdownSourcePath,
  serializeJsonLd,
  type BotDefinition,
  type HitInput,
  type JsonLd,
  type ReferrerRule,
} from '@garus-ltd/geo-core'

export { serializeJsonLd, type JsonLd, type ContentChangeEvent }

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
  /** Serve the Markdown version of CMS pages at `/<path>.md` and to `Accept: text/markdown` requests. */
  markdown?: MarkdownOptions
  /** Report browser visits that arrive from an AI assistant. Off unless set; the CMS must enable it too. */
  referrals?: ReferralOptions
}

export interface ReferralOptions {
  /** CMS referral endpoint, e.g. `https://cms.example.com/api/geo/referrals` (a path for a CMS in the same app). */
  endpoint: string
  /**
   * The host site's consent check. Return false and nothing is reported for this request,
   * e.g. `(req) => req.headers.get('cookie')?.includes('analytics=yes') ?? false`.
   */
  consent?: (request: Request) => boolean | Promise<boolean>
  /** Referrer rules. Default: the built-in AI assistant list. Keep it the same as the CMS's. */
  rules?: readonly ReferrerRule[]
  /** Also report external referrals that match no rule, stored as `unknown`. Needs `recordUnknown` in the CMS. Default false. */
  unknown?: boolean
}

export interface MarkdownOptions {
  /**
   * CMS Markdown endpoint, e.g. `https://cms.example.com/api/geo/markdown`. Gets `?path=/blog/post`.
   * A path such as `/api/geo/markdown` is resolved against the request, for a CMS in the same app (Payload).
   */
  source: string
  /** Also answer `Accept: text/markdown` on the normal URL. Default true. */
  negotiate?: boolean
  /** Seconds browsers and CDNs may cache a page. Default 300. */
  maxAge?: number
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

/** A top-level page load (not a fetch, prefetch, image or script). */
function isDocumentNavigation(request: Request): boolean {
  if (request.method !== 'GET') return false
  const h = request.headers
  if (h.get('next-router-prefetch') || h.get('purpose') === 'prefetch' || h.get('sec-purpose')?.includes('prefetch') || h.get('rsc')) return false
  const dest = h.get('sec-fetch-dest')
  if (dest) return dest === 'document'
  return (h.get('accept') ?? '').includes('text/html')
}

/**
 * Reports a browser visit whose Referer is a known AI assistant. Only the referrer's origin and the landing path
 * (plus `utm_source`) leave the frontend; the CMS keeps the host and path. Crawlers are not referrals and are
 * left to `trackAICrawler`. Resolves true once a report was sent; never rejects. Run it in `event.waitUntil()`.
 */
export async function trackAIReferral(request: Request, options: GeoTrackOptions): Promise<boolean> {
  const referrals = options.referrals
  if (!referrals || !isDocumentNavigation(request)) return false
  const userAgent = request.headers.get('user-agent')
  if (detectBot(userAgent, options.bots ?? AI_BOTS)) return false
  const url = new URL(request.url)
  if (STATIC_PATH.test(url.pathname) || options.ignore?.(url.pathname) || markdownSourcePath(url.pathname) !== null) return false
  const endpoint = new URL(referrals.endpoint, url)
  if (endpoint.origin === url.origin && endpoint.pathname === url.pathname) return false

  let referrer: string | null = null
  const rawReferrer = request.headers.get('referer')
  if (rawReferrer) {
    try {
      referrer = new URL(rawReferrer).origin
    } catch {
      return false
    }
    if (new URL(referrer).hostname === url.hostname) return false
  }
  const utm = url.searchParams.get('utm_source')
  const landing = url.pathname + (utm ? `?utm_source=${encodeURIComponent(utm)}` : '')
  const match = classifyReferral({ referrer, url: landing }, referrals.rules ?? AI_REFERRERS)
  if (!match && !(referrals.unknown && (referrer || utm))) return false
  try {
    if (referrals.consent && !(await referrals.consent(request))) return false
  } catch {
    return false
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.secret) headers[GEO_SECRET_HEADER] = options.secret
  const body = {
    url: landing,
    referrer,
    host: url.host,
    // For the CMS's in-memory rate limit and duplicate filter only; never stored.
    ip: getClientIP(request.headers),
    userAgent,
    timestamp: new Date().toISOString(),
  }
  try {
    const res = await (options.fetch ?? globalThis.fetch)(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok && res.status !== 429) throw new Error(`Headless GEO referral report responded ${res.status}`)
    return true
  } catch (error) {
    ;(options.onError ?? console.warn)(error)
    return false
  }
}

type Handler<R> = (request: Request, event: WaitUntilEvent) => R

/** True when the client asks for Markdown over HTML, e.g. `Accept: text/markdown` or `text/markdown, text/html;q=0.8`. */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false
  let markdown = 0
  let html = 0
  for (const part of accept.toLowerCase().split(',')) {
    const [type, ...params] = part.trim().split(';')
    const q = Number(params.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? 1)
    if (type === 'text/markdown' || type === 'text/x-markdown') markdown = Math.max(markdown, q)
    if (type === 'text/html' || type === 'application/xhtml+xml') html = Math.max(html, q)
  }
  return markdown > 0 && markdown >= html
}

/**
 * Markdown version of the requested page from the CMS, or null when the request is not for Markdown
 * or the CMS has no published page at that path (so the app can handle it as usual).
 */
export async function markdownResponse(request: Request, options: MarkdownOptions): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  const mdPath = markdownSourcePath(url.pathname)
  const negotiated = mdPath === null && options.negotiate !== false && prefersMarkdown(request.headers.get('accept'))
  if (mdPath === null && !negotiated) return null
  if (mdPath === null && STATIC_PATH.test(url.pathname)) return null

  const source = new URL(options.source, url)
  // The proxy's own fetch of the CMS endpoint (same app, e.g. Payload) comes back through the proxy with
  // `Accept: text/markdown`; answering it would fetch the endpoint again, forever.
  if (source.origin === url.origin && source.pathname === url.pathname) return null
  source.searchParams.set('path', mdPath ?? url.pathname)
  const upstream = await (options.fetch ?? globalThis.fetch)(source, { headers: { accept: 'text/markdown' } }).catch(() => null)
  if (!upstream?.ok) return null
  const maxAge = options.maxAge ?? 300
  const headers: Record<string, string> = {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 12}`,
  }
  if (negotiated) headers.vary = 'Accept'
  else headers.link = `<${new URL(mdPath!, url).href}>; rel="canonical"`
  return new Response(request.method === 'HEAD' ? null : await upstream.text(), { headers })
}

/**
 * Wraps an existing Next.js proxy / middleware, or acts as one on its own.
 *
 * ```ts
 * // proxy.ts (Next 16) or middleware.ts (Next 15)
 * import { withGeo } from '@garus-ltd/geo-next'
 * export const proxy = withGeo({ endpoint: process.env.GEO_INGEST_URL!, secret: process.env.GEO_SECRET })
 * ```
 */
export function withGeo<R = undefined>(
  options: GeoTrackOptions,
  handler?: Handler<R>,
): Handler<R | undefined | Promise<R | Response | undefined>> {
  return (request, event) => {
    const bot = trackAICrawler(request, event, options)
    if (!bot && options.referrals) {
      // Never delays the page: the consent check and report run in the background.
      event.waitUntil(trackAIReferral(request, options))
    }
    if (!options.markdown) return handler?.(request, event)
    const markdown = options.markdown
    return markdownResponse(request, markdown).then((res) => res ?? handler?.(request, event))
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
 * import { llmsRoute } from '@garus-ltd/geo-next'
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

export interface LlmsSegmentRouteOptions {
  /** CMS base URL of the part files, e.g. `https://cms.example.com/api/geo/llms` (Strapi: same path). */
  source: string
  /** Seconds browsers and CDNs may cache a part. Default 300. 404s are cached for at most 60 seconds. */
  maxAge?: number
  fetch?: typeof fetch
}

type RouteContext = { params?: Record<string, string | string[]> | Promise<Record<string, string | string[]>> }

/**
 * Route handler for the part files of a segmented llms.txt (`segments: { enabled: true }` in the CMS plugin).
 * Only well-formed part names (`posts-2.txt`, `posts-2-full.txt`) are forwarded; anything else is a 404 without
 * a CMS request.
 *
 * ```ts
 * // app/llms/[file]/route.ts
 * import { llmsSegmentRoute } from '@garus-ltd/geo-next'
 * export const GET = llmsSegmentRoute({ source: `${process.env.CMS_URL}/api/geo/llms` })
 * ```
 */
export function llmsSegmentRoute(options: LlmsSegmentRouteOptions): (request: Request, context?: RouteContext) => Promise<Response> {
  return async (request, context) => {
    const params = await context?.params
    const raw = params?.file
    const file = (Array.isArray(raw) ? raw.join('/') : raw) ?? new URL(request.url).pathname.split('/').pop() ?? ''
    const maxAge = options.maxAge ?? 300
    const notFound = () => new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${Math.min(maxAge, 60)}` } })
    if (!parseSegmentFile(file)) return notFound()
    const doFetch = options.fetch ?? globalThis.fetch
    const base = new URL(options.source.replace(/\/+$/, '') + '/', request.url)
    const upstream = await doFetch(new URL(file, base), { headers: { accept: 'text/plain' } }).catch(() => null)
    if (upstream?.status === 404) return notFound()
    if (!upstream?.ok) return new Response('llms part is temporarily unavailable\n', { status: 502 })
    return new Response(await upstream.text(), {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 12}` },
    })
  }
}

export interface RevalidationOptions {
  /** The target's `secret` from the CMS plugin's `invalidation.targets`. */
  secret: string
  /**
   * Drop the caches for the event, e.g. `revalidatePath` for every `event.paths` and `revalidateTag('geo')` in
   * Next.js, or a CDN purge of `event.urls`. Throw to answer 500, so the CMS records a failure you can retry.
   */
  onEvent(event: ContentChangeEvent): unknown | Promise<unknown>
  /** Seconds a signature stays valid. Default 300. */
  toleranceSeconds?: number
  /** Largest accepted body. Default 64 KB. */
  maxBodyBytes?: number
  /** Remembers handled event ids so a repeated delivery is acknowledged without acting twice. Default: per process. */
  seen?: SeenEvents
}

/**
 * Receives the CMS plugin's signed cache invalidation notices. Checks the HMAC signature and its age, refuses
 * malformed events, acknowledges repeated deliveries of the same event id without calling `onEvent` again.
 *
 * ```ts
 * // app/api/geo-revalidate/route.ts
 * import { revalidatePath, revalidateTag } from 'next/cache'
 * import { revalidationHandler } from '@garus-ltd/geo-next'
 * export const POST = revalidationHandler({
 *   secret: process.env.GEO_REVALIDATE_SECRET!,
 *   onEvent: (event) => { for (const path of event.paths) revalidatePath(path); revalidateTag('geo') },
 * })
 * ```
 */
export function revalidationHandler(options: RevalidationOptions): (request: Request) => Promise<Response> {
  if (!options.secret || options.secret.length < 16) throw new TypeError('[geo] revalidationHandler needs a secret of at least 16 characters')
  const seen = options.seen ?? new SeenEvents()
  const max = options.maxBodyBytes ?? 65_536
  const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  return async (request) => {
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' })
    const body = await request.text()
    if (new TextEncoder().encode(body).length > max) return reply(413, { ok: false, error: 'too large' })
    if (!(await verifyChangeSignature(options.secret, body, request.headers.get(GEO_SIGNATURE_HEADER), { toleranceSeconds: options.toleranceSeconds }))) {
      return reply(401, { ok: false, error: 'invalid signature' })
    }
    const event = parseChangeEvent(body)
    if (!event) return reply(400, { ok: false, error: 'invalid event' })
    if (!seen.first(event.id)) return reply(200, { ok: true, duplicate: true })
    try {
      await options.onEvent(event)
    } catch (error) {
      seen.forget(event.id)
      return reply(500, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
    return reply(200, { ok: true })
  }
}

export interface GeoFetchOptions extends GeoTrackOptions {
  /** Serve `/llms.txt`, `/llms-full.txt` and segment parts from the CMS. */
  llms?: {
    /** CMS llms.txt URL, e.g. `https://cms.example.com/api/geo/llms.txt`. */
    source: string
    /** CMS llms-full.txt URL. Default: `source` with `llms-full.txt`. */
    fullSource?: string
    /** CMS base URL of segment parts, e.g. `https://cms.example.com/api/geo/llms`. Set it when `segments` are on. */
    segments?: string
    maxAge?: number
  }
}

/**
 * The same features as withGeo and the llms routes, for any framework with Fetch API requests (Astro, Nuxt / h3,
 * Hono, Remix, a Node server with a small adapter): reports AI crawlers and AI referrals, serves llms files and
 * Markdown. Resolves a Response when it handled the request, or null to let the app render the page.
 *
 * Pass `waitUntil` when the platform has one; otherwise reports run in the background of the process.
 */
export function geoFetchHandler(options: GeoFetchOptions): (request: Request, context?: { waitUntil?(promise: Promise<unknown>): void }) => Promise<Response | null> {
  const llms = options.llms
  const txt = llms && llmsRoute({ source: llms.source, maxAge: llms.maxAge, fetch: options.fetch })
  const full = llms && llmsRoute({ source: llms.fullSource ?? llms.source.replace(/llms\.txt$/, 'llms-full.txt'), maxAge: llms.maxAge, fetch: options.fetch })
  const parts = llms?.segments ? llmsSegmentRoute({ source: llms.segments, maxAge: llms.maxAge, fetch: options.fetch }) : null
  return async (request, context) => {
    const event: WaitUntilEvent = { waitUntil: (p) => (context?.waitUntil ? context.waitUntil(p) : void p.catch(() => {})) }
    const bot = trackAICrawler(request, event, options)
    if (!bot && options.referrals) event.waitUntil(trackAIReferral(request, options))
    if (request.method !== 'GET' && request.method !== 'HEAD') return null
    const path = new URL(request.url).pathname
    if (txt && path === '/llms.txt') return txt(request)
    if (full && path === '/llms-full.txt') return full(request)
    if (parts && path.startsWith('/llms/')) return parts(request, { params: { file: path.slice('/llms/'.length) } })
    return options.markdown ? markdownResponse(request, options.markdown) : null
  }
}

export interface JsonLdOptions {
  /** CMS JSON-LD endpoint, e.g. `https://cms.example.com/api/geo/jsonld`, or a path such as `/api/geo/jsonld` with `base`. */
  source: string
  /**
   * Origin a relative `source` is resolved against, e.g. `http://localhost:3000` when the CMS runs in the same app.
   * Server components have no request URL to resolve it against, so a relative `source` needs this.
   */
  base?: string
  /** Frontend path of the page, e.g. `/blog/hello`. */
  path: string
  /**
   * Leave these JSON-LD types out of the page, e.g. `['Article']` when the site's SEO setup already renders the
   * article. `'host'` uses the CMS's `hostManaged` list. References by `@id` to them stay in the graph.
   */
  omit?: 'host' | readonly string[]
  /** Extra `fetch` options, e.g. `{ next: { revalidate: 300 } }` in Next.js. */
  init?: RequestInit & Record<string, unknown>
  fetch?: typeof fetch
}

/** JSON-LD for a page from the CMS, or null when the page has none. Never throws. */
export async function fetchJsonLd(options: JsonLdOptions): Promise<JsonLd | null> {
  let url: URL
  try {
    url = new URL(options.source, options.base)
  } catch {
    console.warn(
      `[geo] fetchJsonLd: cannot resolve source "${options.source}". Use an absolute URL, or pass \`base\` (e.g. http://localhost:3000).`,
    )
    return null
  }
  url.searchParams.set('path', options.path)
  if (options.omit) url.searchParams.set('omit', typeof options.omit === 'string' ? options.omit : options.omit.join(','))
  try {
    const res = await (options.fetch ?? globalThis.fetch)(url, { ...options.init, headers: { accept: 'application/ld+json' } })
    return res.ok ? ((await res.json()) as JsonLd) : null
  } catch {
    return null
  }
}

/**
 * Props for a JSON-LD script tag, escaped so content cannot break out of it.
 *
 * ```tsx
 * const data = await fetchJsonLd({ source: `${process.env.CMS_URL}/api/geo/jsonld`, path: `/blog/${slug}` })
 * return <>{data && <script {...jsonLdScriptProps(data)} />}...</>
 * ```
 */
export function jsonLdScriptProps(data: unknown): { type: 'application/ld+json'; 'data-geo-jsonld': ''; dangerouslySetInnerHTML: { __html: string } } {
  // `data-geo-jsonld` lets the setup check tell the plugin's JSON-LD from the host site's.
  return { type: 'application/ld+json', 'data-geo-jsonld': '', dangerouslySetInnerHTML: { __html: serializeJsonLd(data) } }
}

/** A complete `<script>` tag for templates that aren't React (Astro, Nuxt, plain HTML). Escaped like jsonLdScriptProps. */
export function jsonLdScriptTag(data: unknown): string {
  return `<script type="application/ld+json" data-geo-jsonld>${serializeJsonLd(data)}</script>`
}
