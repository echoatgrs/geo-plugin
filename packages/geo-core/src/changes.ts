/**
 * Content change events and cache invalidation notices.
 *
 * The plugin itself caches nothing: llms.txt, Markdown and JSON-LD are built from the CMS on every request, so the
 * next request after a publish, edit, unpublish, delete or permission change already shows the new state. What can
 * still serve old content are caches outside the plugin: the frontend's (Next.js data / full route cache), CDNs and
 * browsers, for up to `cacheMaxAge` seconds. Change events tell those caches what to drop.
 *
 * Notices go only to targets configured in the CMS (never to a URL taken from a request), are signed with
 * HMAC-SHA256, time out, are retried a bounded number of times, and never roll back or block the CMS save.
 * Without a CDN integration, nothing guarantees an instant purge of every cache.
 */
import { isPrivateAddress } from './diagnostics.js'
import { markdownURL, type LlmsDocument } from './llms.js'
import { parseIP } from './cidr.js'

export type ContentChangeType = 'publish' | 'update' | 'unpublish' | 'delete' | 'access' | 'config'

export interface ContentChangeEvent {
  /** Unique per change; repeated deliveries of the same event keep it, so receivers can drop duplicates. */
  id: string
  type: ContentChangeType
  /** Collection slug / content type UID; `*` for site-wide changes. */
  source: string
  documentId?: string
  occurredAt: string
  /** Frontend paths to revalidate: the page before and after (both when the URL changed), and their `.md`. */
  paths: string[]
  /** Absolute URLs of the same, for CDN purge APIs. */
  urls: string[]
  /** Cache tags: `geo`, `geo:llms`, `geo:source:<source>`, `geo:path:<path>`. */
  tags: string[]
  /** The URL changed: the old one must stop serving the old content. */
  previousPath?: string
  path?: string
}

function uuid(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * Builds the event for one document change from its public state before and after (null: not public). Returns
 * null when neither state is public (e.g. a draft saved over a draft): nothing public changed.
 */
export function contentChangeEvent(input: {
  source: string
  documentId?: string | number | null
  before: Pick<LlmsDocument, 'url'> | null
  after: Pick<LlmsDocument, 'url'> | null
  deleted?: boolean
  siteURL: string
  /** Extra frontend paths always invalidated, e.g. the llms files and segment parts. Default llms.txt and llms-full.txt. */
  llmsPaths?: string[]
}): ContentChangeEvent | null {
  const { before, after } = input
  if (!before && !after) return null
  const type: ContentChangeType = input.deleted ? 'delete' : !before ? 'publish' : !after ? 'unpublish' : 'update'
  const pages = [...new Set([before?.url, after?.url].filter((u): u is string => !!u))]
  const urls = [...new Set(pages.flatMap((u) => [u, markdownURL(u)]))]
  const site = input.siteURL.replace(/\/+$/, '')
  const llms = input.llmsPaths ?? ['/llms.txt', '/llms-full.txt']
  const allURLs = [...urls, ...llms.map((p) => `${site}${p}`)]
  const paths = [...new Set(allURLs.map(pathOf))]
  const event: ContentChangeEvent = {
    id: uuid(),
    type,
    source: input.source,
    occurredAt: new Date().toISOString(),
    paths,
    urls: allURLs,
    tags: ['geo', 'geo:llms', `geo:source:${input.source}`, ...pages.map((u) => `geo:path:${pathOf(u)}`)],
  }
  if (input.documentId != null) event.documentId = String(input.documentId)
  if (before && after && before.url !== after.url) {
    event.previousPath = pathOf(before.url)
    event.path = pathOf(after.url)
  }
  return event
}

/** A site-wide event (permission or mapping change): everything the plugin serves is invalidated. */
export function siteChangeEvent(type: 'access' | 'config', siteURL: string, llmsPaths: string[] = ['/llms.txt', '/llms-full.txt']): ContentChangeEvent {
  const site = siteURL.replace(/\/+$/, '')
  return {
    id: uuid(),
    type,
    source: '*',
    occurredAt: new Date().toISOString(),
    paths: llmsPaths,
    urls: llmsPaths.map((p) => `${site}${p}`),
    tags: ['geo', 'geo:llms', 'geo:all'],
  }
}

// ---------- Signatures ----------

export const GEO_SIGNATURE_HEADER = 'x-geo-signature'
export const GEO_EVENT_HEADER = 'x-geo-event'

const enc = new TextEncoder()

async function hmac(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function signChange(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmac(secret, `${timestamp}.${body}`)}`
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Checks a signature header and its age (default at most 5 minutes off). */
export async function verifyChangeSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]))
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1) return false
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false
  return safeEqual(await hmac(secret, `${t}.${body}`), parts.v1)
}

// ---------- Delivery ----------

export interface InvalidationTarget {
  /** Shown in the admin; never the secret. */
  name: string
  /** Endpoint that receives the events, e.g. the frontend's revalidation route. Fixed in the CMS config. */
  url: string
  /** Shared secret for the signature. Required. */
  secret: string
  /** Only these event types. Default all. */
  events?: ContentChangeType[]
}

export interface InvalidationOptions {
  /** HTTP targets that receive signed notices. May be empty when only `onChange` is used. */
  targets: InvalidationTarget[]
  /**
   * In-process listener, called for every change event before the HTTP notices (e.g. purge a CDN through its
   * SDK, or write to your own queue). Errors are logged and never fail the save or stop the notices.
   */
  onChange?: (event: ContentChangeEvent) => void | Promise<void>
  /** Per attempt. Default 5000 ms, at most 30000. */
  timeoutMs?: number
  /** Retries after the first attempt. Default 2, at most 5. */
  retries?: number
  /** Allow targets on loopback / private networks (local development). Default false. */
  allowPrivateNetwork?: boolean
}

export type DeliveryStatus = 'pending' | 'succeeded' | 'failed'

export interface DeliveryRecord {
  eventId: string
  eventType: ContentChangeType
  source: string
  target: string
  status: DeliveryStatus
  attempts: number
  lastError?: string | null
  lastAttemptAt?: string | null
  event: ContentChangeEvent
}

/** Where delivery results are kept, so the admin can see failures and retry them. */
export interface DeliveryStore {
  save(record: DeliveryRecord): Promise<void>
}

/** Validates targets at startup: http(s), no credentials in the URL, a secret, known event types. Throws. */
export function validateInvalidationOptions(options: InvalidationOptions | undefined): void {
  if (!options) return
  if (!Array.isArray(options.targets)) throw new TypeError('[geo] invalidation.targets must be a list')
  if (options.onChange !== undefined && typeof options.onChange !== 'function') throw new TypeError('[geo] invalidation.onChange must be a function')
  const names = new Set<string>()
  for (const t of options.targets) {
    if (!t || typeof t.name !== 'string' || !t.name.trim()) throw new TypeError('[geo] every invalidation target needs a name')
    if (names.has(t.name)) throw new TypeError(`[geo] duplicate invalidation target "${t.name}"`)
    names.add(t.name)
    let u: URL
    try {
      u = new URL(t.url)
    } catch {
      throw new TypeError(`[geo] invalidation target "${t.name}" has an invalid url`)
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError(`[geo] invalidation target "${t.name}" must be http(s)`)
    if (u.username || u.password) throw new TypeError(`[geo] invalidation target "${t.name}" must not contain credentials`)
    if (typeof t.secret !== 'string' || t.secret.length < 16) throw new TypeError(`[geo] invalidation target "${t.name}" needs a secret of at least 16 characters`)
    for (const e of t.events ?? []) if (!['publish', 'update', 'unpublish', 'delete', 'access', 'config'].includes(e)) throw new TypeError(`[geo] unknown event "${e}" for "${t.name}"`)
  }
}

export interface NotifierDeps {
  store?: DeliveryStore
  fetch?: typeof fetch
  /** Resolves a host name, to refuse private addresses (e.g. `dns.promises.lookup` wrapped). */
  resolve?: (host: string) => Promise<string[]>
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

async function checkTarget(url: URL, options: InvalidationOptions, deps: NotifierDeps): Promise<void> {
  if (options.allowPrivateNetwork) return
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = parseIP(host) ? [host] : deps.resolve ? await deps.resolve(host) : []
  if (!addresses.length) throw new Error(`cannot resolve ${host}`)
  if (addresses.some(isPrivateAddress)) throw new Error(`${host} is a private or loopback address (set invalidation.allowPrivateNetwork for local development)`)
}

/** Sends one event to one target with retries. Resolves with the final record; never throws. */
export async function deliver(event: ContentChangeEvent, target: InvalidationTarget, options: InvalidationOptions, deps: NotifierDeps = {}, attemptsSoFar = 0): Promise<DeliveryRecord> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5000, 100), 30_000)
  const retries = Math.min(Math.max(options.retries ?? 2, 0), 5)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const doFetch = deps.fetch ?? globalThis.fetch
  const body = JSON.stringify(event)
  const record: DeliveryRecord = { eventId: event.id, eventType: event.type, source: event.source, target: target.name, status: 'pending', attempts: attemptsSoFar, event }
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(1000 * 4 ** (i - 1))
    record.attempts++
    record.lastAttemptAt = new Date().toISOString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const url = new URL(target.url)
      await checkTarget(url, options, deps)
      const res = await doFetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', [GEO_SIGNATURE_HEADER]: await signChange(target.secret, body), [GEO_EVENT_HEADER]: event.id },
        body,
      })
      if (res.status >= 200 && res.status < 300) {
        record.status = 'succeeded'
        record.lastError = null
        break
      }
      record.lastError = `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`
      // A wrong secret or a bad request won't get better by retrying.
      if (res.status === 400 || res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) break
    } catch (error) {
      const name = (error as Error)?.name
      record.lastError = name === 'AbortError' ? `timed out after ${timeoutMs} ms` : String((error as Error)?.message ?? error).slice(0, 200)
      if (/private or loopback|cannot resolve/.test(record.lastError)) break
    } finally {
      clearTimeout(timer)
    }
  }
  if (record.status !== 'succeeded') record.status = 'failed'
  try {
    await deps.store?.save(record)
  } catch (error) {
    deps.log?.(`[geo] could not record invalidation delivery: ${(error as Error)?.message ?? error}`)
  }
  if (record.status === 'failed') deps.log?.(`[geo] invalidation notice to "${target.name}" failed: ${record.lastError}`)
  return record
}

/** Sends an event to every target that wants it. Run it in the background: it never throws. */
/** Whether change events are produced at all: HTTP targets or an `onChange` listener are configured. */
export function invalidationActive(options: InvalidationOptions | undefined): options is InvalidationOptions {
  return !!options && (!!options.targets?.length || typeof options.onChange === 'function')
}

export async function notifyChange(event: ContentChangeEvent, options: InvalidationOptions | undefined, deps: NotifierDeps = {}): Promise<DeliveryRecord[]> {
  if (!options) return []
  if (options.onChange) {
    try {
      await options.onChange(event)
    } catch (error) {
      deps.log?.(`[geo] invalidation onChange failed: ${(error as Error)?.message ?? error}`)
    }
  }
  if (!options.targets?.length) return []
  const targets = options.targets.filter((t) => !t.events || t.events.includes(event.type))
  return Promise.all(targets.map((t) => deliver(event, t, options, deps)))
}

// ---------- Receiving ----------

/** Remembers recently seen event ids so a repeated delivery is acknowledged but not acted on twice. */
export class SeenEvents {
  private ids = new Map<string, number>()
  constructor(private max = 1000, private ttlMs = 24 * 3600_000) {}
  /** True the first time an id is seen (within the TTL). */
  first(id: string): boolean {
    const now = Date.now()
    for (const [k, at] of this.ids) {
      if (now - at > this.ttlMs || this.ids.size > this.max) this.ids.delete(k)
      else break
    }
    if (this.ids.has(id)) return false
    this.ids.set(id, now)
    return true
  }
  /** Forgets an id, e.g. when handling it failed and the sender should be able to retry it. */
  forget(id: string): void {
    this.ids.delete(id)
  }
}

/** Parses and checks a received event body. Returns null for anything that isn't a well-formed event. */
export function parseChangeEvent(body: string): ContentChangeEvent | null {
  let e: any
  try {
    e = JSON.parse(body)
  } catch {
    return null
  }
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || e.id.length > 100) return null
  if (!['publish', 'update', 'unpublish', 'delete', 'access', 'config'].includes(e.type)) return null
  const strings = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 2048)
  if (!strings(e.paths, 200) || !strings(e.urls, 200) || !strings(e.tags, 200)) return null
  if (!e.paths.every((p: string) => p.startsWith('/'))) return null
  return e as ContentChangeEvent
}
