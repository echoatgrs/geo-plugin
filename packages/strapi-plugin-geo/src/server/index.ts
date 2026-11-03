import {
  GEO_SECRET_HEADER,
  IngestLog,
  ProbeRegistry,
  findProbeInBody,
  buildJsonLd,
  buildSegment,
  buildSegmentIndex,
  included,
  parseSegmentFile,
  resolvedSegments,
  segmentKey,
  type SegmentSource,
  buildLlmsFullTxt,
  buildLlmsTxt,
  createIPVerifier,
  documentMarkdown,
  findDocumentByPath,
  ingestHits,
  lastSegment,
  omitJsonLdTypes,
  parseOmit,
  summarizeHits,
  toLlmsDocument,
  windowStart,
  type IPVerifier,
  type LlmsDocument,
  type StatsHit,
} from '@garus-ltd/geo-core'
import { publicAccess, type PublicAccess } from './access'
import { jsonLdSite, mappingOptions, pluralName, populateOf } from './content'
import config, { type GeoStrapiConfig, type StrapiLlmsConfig } from './config'
import { AI_REFERRAL_UID, CITATION_UID, citationMiddleware, evidenceReport, ingestReferralReport } from './evidence'
import { changeMiddleware, invalidationControllers, subscribePermissionChanges, type ChangeDeps } from './changes'
import { inspectStrapiEntry } from './inspect'
import { documentStats, runSetupTest, setupReport, type SetupState } from './setup'
import aiReferralSchema from './content-types/ai-referral/schema'
import citationSchema from './content-types/citation/schema'
import crawlerHitSchema from './content-types/crawler-hit/schema'
import invalidationSchema from './content-types/invalidation/schema'
import type { KoaContextLike, StrapiLike } from './types'

export { checkFindRoute, publicAccess, type PublicAccess } from './access'
export { AI_REFERRAL_UID, CITATION_UID } from './evidence'
export { INVALIDATION_UID } from './changes'
export const CRAWLER_HIT_UID = 'plugin::geo.crawler-hit'
const PAGE_SIZE = 1000
const MAX_STATS_HITS = 100_000

let verifier: IPVerifier | undefined
/** Diagnostic probe tokens and recent ingest results, per process. */
const setupState: SetupState = { probes: new ProbeRegistry(), log: new IngestLog() }

function getConfig(strapi: StrapiLike): GeoStrapiConfig {
  const plugin = strapi.plugin('geo')
  return {
    secret: plugin.config('secret', ''),
    verifyIPs: plugin.config('verifyIPs', true),
    storeSpoofed: plugin.config('storeSpoofed', true),
    enabled: plugin.config('enabled', true),
    bots: plugin.config('bots', undefined),
    llms: plugin.config('llms', null),
    diagnostics: plugin.config('diagnostics', {}),
    referrals: plugin.config('referrals', {}),
    citations: plugin.config('citations', {}),
    invalidation: plugin.config('invalidation', undefined),
  }
}



type StrapiLlmsSource = StrapiLlmsConfig['contentTypes'][string]

/** Content types from the config whose entries the anonymous public may read. */
export async function publicContentTypes(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<Set<string>> {
  return (await publicAccess(strapi, llms)).allowed
}

const READ_BATCH = 100

function sortOf(source: StrapiLlmsSource, segmented: boolean): string[] {
  const own = source.sort == null ? [] : Array.isArray(source.sort) ? source.sort : [source.sort]
  const base = own.length ? own : segmented ? ['createdAt:asc'] : ['updatedAt:desc']
  // `id` last, so entries with the same date always come in the same order.
  return base.some((s) => s.split(':')[0] === 'id') ? base : [...base, 'id:asc']
}

function filtersOf(source: StrapiLlmsSource, extra?: Record<string, unknown>) {
  return source.filters && extra ? { $and: [source.filters, extra] } : (extra ?? source.filters)
}

async function findEntries(
  strapi: StrapiLike,
  uid: string,
  source: StrapiLlmsSource,
  extra?: Record<string, unknown>,
  page: { start?: number; limit?: number; segmented?: boolean } = {},
) {
  return strapi.documents(uid).findMany({
    // Only published entries for draft & publish content types; ignored otherwise.
    status: 'published',
    filters: filtersOf(source, extra),
    // Media, components, dynamic zones and relations (author, cover image, FAQ) from the schema.
    populate: populateOf(strapi, uid, source) as never,
    start: page.start ?? 0,
    limit: page.limit ?? source.limit ?? 500,
    sort: sortOf(source, !!page.segmented),
  })
}

/** Published entries of a content type (before the per-entry public checks). */
async function countEntries(strapi: StrapiLike, uid: string, source: StrapiLlmsSource): Promise<number> {
  const service = strapi.documents(uid)
  if (service.count) return service.count({ status: 'published', filters: filtersOf(source) })
  let total = 0
  for (;;) {
    const batch = await service.findMany({ status: 'published', filters: filtersOf(source), fields: ['documentId'], start: total, limit: 1000 })
    total += batch.length
    if (batch.length < 1000) return total
  }
}

function mapper(strapi: StrapiLike, llms: StrapiLlmsConfig, uid: string, source: StrapiLlmsSource) {
  const options = mappingOptions(strapi, llms, uid, source)
  return (entry: Record<string, any>) => toLlmsDocument(entry, options)
}

/** Published entries of one content type that the public may read, as llms documents. */
async function publicDocuments(
  strapi: StrapiLike,
  llms: StrapiLlmsConfig,
  access: PublicAccess,
  uid: string,
  extra?: Record<string, unknown>,
  page?: { start?: number; limit?: number; segmented?: boolean },
  listing = false,
): Promise<LlmsDocument[]> {
  const source = llms.contentTypes[uid]!
  const map = mapper(strapi, llms, uid, source)
  const docs: LlmsDocument[] = []
  for (const entry of await findEntries(strapi, uid, source, extra, page)) {
    const visible = await access.filter(uid, source, entry)
    // `include` only shapes the lists; Markdown and JSON-LD of a page stay available.
    if (listing && visible && !included(visible, source)) continue
    const mapped = visible && map(visible)
    if (mapped) docs.push(mapped)
  }
  return docs
}

export interface LlmsListing {
  docs: LlmsDocument[]
  /** Visible notes per section when a `limit` cut the list. */
  notes: Record<string, string>
}

/**
 * Every listed entry the public may read, read page by page (READ_BATCH per query) up to each content type's
 * `limit`, filtered by `include`, without duplicate URLs. llms.txt, llms-full.txt and the dashboard coverage
 * all use this list, so they always agree.
 */
export async function loadLlmsListing(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<LlmsListing> {
  const access = await publicAccess(strapi, llms)
  const docs: LlmsDocument[] = []
  const notes: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [uid, source] of Object.entries(llms.contentTypes)) {
    if (!access.allowed.has(uid)) continue
    const limit = source.limit ?? 500
    let read = 0
    while (read < limit) {
      const size = Math.min(READ_BATCH, limit - read)
      const batch = await findEntries(strapi, uid, source, undefined, { start: read, limit: size })
      const map = mapper(strapi, llms, uid, source)
      for (const entry of batch) {
        const visible = await access.filter(uid, source, entry)
        if (!visible || !included(visible, source)) continue
        const mapped = map(visible)
        if (!mapped || seen.has(mapped.url)) continue
        seen.add(mapped.url)
        docs.push(mapped)
      }
      read += batch.length
      if (batch.length < size) break
    }
    if (read >= limit) {
      const total = await countEntries(strapi, uid, source)
      if (total > limit) notes[source.section ?? pluralName(strapi, uid)] = `Lists ${limit} of ${total} entries (limit ${limit}). Raise \`limit\` or turn on \`segments\` to list all.`
    }
  }
  return { docs, notes }
}

export async function loadLlmsDocuments(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<LlmsDocument[]> {
  return (await loadLlmsListing(strapi, llms)).docs
}

/** Segment sources: one per readable content type, read one part at a time. */
export async function segmentSources(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<SegmentSource[]> {
  const access = await publicAccess(strapi, llms)
  return Object.entries(llms.contentTypes)
    .filter(([uid]) => access.allowed.has(uid))
    .map(([uid, source]) => ({
      key: segmentKey(pluralName(strapi, uid)),
      section: source.section ?? pluralName(strapi, uid),
      count: () => countEntries(strapi, uid, source),
      page: (offset: number, limit: number) => publicDocuments(strapi, llms, access, uid, undefined, { start: offset, limit, segmented: true }, true),
      featured: async () =>
        typeof source.featured === 'string' ? publicDocuments(strapi, llms, access, uid, { [source.featured]: { $eq: true } }, { limit: 50 }, true) : [],
    }))
}

/** The public state of one entry right now (null: not public), for change events. */
export async function publicEntry(strapi: StrapiLike, llms: StrapiLlmsConfig, uid: string, documentId: string): Promise<LlmsDocument | null> {
  if (!llms.contentTypes[uid]) return null
  const access = await publicAccess(strapi, llms)
  if (!access.allowed.has(uid)) return null
  const [doc] = await publicDocuments(strapi, llms, access, uid, { documentId: { $eq: documentId } }, { limit: 1 })
  return doc ?? null
}

export function llmsSite(llms: StrapiLlmsConfig) {
  return { name: llms.name ?? llms.siteURL, description: llms.description, details: llms.details }
}

/**
 * The published, publicly readable entry served at a frontend path. Content types with a `slug`
 * attribute are queried by the path's last segment; others are scanned. The full path must match the
 * entry's URL, so the same slug in two content types never resolves to the wrong one.
 */
export async function loadDocumentByPath(strapi: StrapiLike, llms: StrapiLlmsConfig, path: string): Promise<LlmsDocument | undefined> {
  const slug = lastSegment(path)
  const access = await publicAccess(strapi, llms)
  for (const uid of Object.keys(llms.contentTypes)) {
    if (!access.allowed.has(uid)) continue
    const bySlug = !!strapi.contentType?.(uid)?.attributes?.slug
    if (bySlug && !slug) continue
    const docs = await publicDocuments(strapi, llms, access, uid, bySlug ? { slug: { $eq: slug } } : undefined)
    const match = findDocumentByPath(docs, path)
    if (match) return match
  }
  return undefined
}

async function loadHits(strapi: StrapiLike, days: number): Promise<StatsHit[]> {
  const hits: StatsHit[] = []
  const from = windowStart(days).toISOString()
  for (let start = 0; start < MAX_STATS_HITS; start += PAGE_SIZE) {
    const page = await strapi.documents(CRAWLER_HIT_UID).findMany({
      filters: { timestamp: { $gte: from } },
      fields: ['platform', 'purpose', 'verification', 'path', 'timestamp', 'botId'],
      sort: 'timestamp:desc',
      start,
      limit: PAGE_SIZE,
    })
    hits.push(...(page as unknown as StatsHit[]))
    if (page.length < PAGE_SIZE) break
  }
  return hits
}

/** `Cache-Control` for public output. Errors are cached briefly so a newly published entry shows up soon. */
export function cacheControl(maxAge: number | undefined, status: number, notFoundMaxAge?: number): string {
  const age = maxAge ?? 300
  if (age <= 0) return 'no-store'
  if (status === 200) return `public, max-age=${age}`
  const short = notFoundMaxAge ?? Math.min(age, 60)
  return short <= 0 ? 'no-store' : `public, max-age=${Math.min(short, age)}`
}

function sendText(ctx: KoaContextLike, body: string, type = 'text/plain', status = 200, maxAge?: number, notFoundMaxAge?: number) {
  ctx.set?.('Content-Type', `${type}; charset=utf-8`)
  ctx.set?.('Cache-Control', cacheControl(maxAge, status, notFoundMaxAge))
  ctx.status = status
  ctx.body = body
}

function pathQuery(ctx: KoaContextLike): string | null {
  const path = ctx.query?.path
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

function changeDeps(strapi: StrapiLike): ChangeDeps {
  return {
    llms: () => getConfig(strapi).llms,
    invalidation: () => getConfig(strapi).invalidation,
    publicEntry: (uid, documentId) => publicEntry(strapi, getConfig(strapi).llms!, uid, documentId),
  }
}

export const controllers = {
  invalidations: ({ strapi }: { strapi: StrapiLike }) => invalidationControllers(strapi, changeDeps(strapi)),
  ingest: ({ strapi }: { strapi: StrapiLike }) => ({
    async ingest(ctx: KoaContextLike) {
      const cfg = getConfig(strapi)
      if (!cfg.enabled) {
        const probe = findProbeInBody(ctx.request.body, setupState.probes)
        if (probe) setupState.probes.record(probe.token, 'disabled', probe)
        ctx.status = 503
        ctx.body = { ok: false, error: 'disabled' }
        return
      }
      const result = await ingestHits(ctx.request.body, ctx.request.get(GEO_SECRET_HEADER) || null, {
        secret: cfg.secret || undefined,
        verifier: cfg.verifyIPs ? (verifier ??= createIPVerifier()) : undefined,
        storeSpoofed: cfg.storeSpoofed,
        bots: cfg.bots,
        probes: setupState.probes,
        log: setupState.log,
        store: {
          async save(hit) {
            await strapi.documents(CRAWLER_HIT_UID).create({ data: { ...hit } })
          },
        },
      })
      ctx.status = result.status
      ctx.body = result.body
    },
  }),

  llms: ({ strapi }: { strapi: StrapiLike }) => {
    const render = async (ctx: KoaContextLike, full: boolean) => {
      const { llms } = getConfig(strapi)
      if (!llms) {
        ctx.status = 404
        ctx.body = 'llms.txt is not configured\n'
        return
      }
      if (resolvedSegments(llms.segments, llms.siteURL).enabled) {
        const index = await buildSegmentIndex(llmsSite(llms), await segmentSources(strapi, llms), llms.segments, llms.siteURL, { full, markdownLinks: llms.markdownLinks })
        return sendText(ctx, index, 'text/plain', 200, llms.cacheMaxAge)
      }
      const { docs, notes } = await loadLlmsListing(strapi, llms)
      const body = full
        ? buildLlmsFullTxt(llmsSite(llms), docs, { maxBytes: llms.fullMaxBytes, notes: Object.entries(notes).map(([k, v]) => `${k}: ${v}`) })
        : buildLlmsTxt(llmsSite(llms), docs, { markdownLinks: llms.markdownLinks, sectionNotes: notes })
      sendText(ctx, body, 'text/plain', 200, llms.cacheMaxAge)
    }
    // Part files of segmented llms.txt: `/api/geo/llms/<plural name>-<n>.txt` and `…-<n>-full.txt`.
    const part = async (ctx: KoaContextLike & { params?: Record<string, string> }) => {
      const { llms } = getConfig(strapi)
      const parsed = llms && resolvedSegments(llms.segments, llms.siteURL).enabled ? parseSegmentFile(String(ctx.params?.file ?? '')) : null
      const source = parsed && (await segmentSources(strapi, llms!)).find((s) => s.key === parsed.key)
      const body = parsed && source ? await buildSegment(llmsSite(llms!), source, parsed.part, parsed.full, llms!.segments, llms!.siteURL, { markdownLinks: llms!.markdownLinks }) : null
      if (body === null) return sendText(ctx, 'Not found\n', 'text/plain', 404, llms?.cacheMaxAge, llms?.notFoundMaxAge)
      sendText(ctx, body, 'text/plain', 200, llms!.cacheMaxAge)
    }
    return {
      llmsPart: part,
      llmsTxt: (ctx: KoaContextLike) => render(ctx, false),
      llmsFullTxt: (ctx: KoaContextLike) => render(ctx, true),
    }
  },

  page: ({ strapi }: { strapi: StrapiLike }) => {
    const find = async (ctx: KoaContextLike) => {
      const { llms } = getConfig(strapi)
      const path = pathQuery(ctx)
      if (!llms || !path) {
        sendText(ctx, llms ? '`path` query parameter is required\n' : 'llms is not configured\n', 'text/plain', llms ? 400 : 404)
        return null
      }
      const doc = await loadDocumentByPath(strapi, llms, path)
      // Same 404 whether the entry is missing, a draft or not public, so its existence isn't revealed.
      if (!doc) sendText(ctx, 'Not found\n', 'text/plain', 404, llms.cacheMaxAge, llms.notFoundMaxAge)
      return doc ? { llms, doc } : null
    }
    return {
      async markdown(ctx: KoaContextLike) {
        const found = await find(ctx)
        if (found) sendText(ctx, documentMarkdown(found.doc), 'text/markdown', 200, found.llms.cacheMaxAge)
      },
      async jsonLd(ctx: KoaContextLike) {
        const found = await find(ctx)
        if (!found) return
        const { llms, doc } = found
        const built = buildJsonLd(jsonLdSite(llms), doc)
        const omit = parseOmit(typeof ctx.query?.omit === 'string' ? ctx.query.omit : null, llms.hostManaged)
        const data = built && omit.length ? omitJsonLdTypes(built, omit) : built
        if (!data) return sendText(ctx, 'Not found\n', 'text/plain', 404, llms.cacheMaxAge, llms.notFoundMaxAge)
        sendText(ctx, JSON.stringify(data), 'application/ld+json', 200, llms.cacheMaxAge)
      },
    }
  },

  editor: ({ strapi }: { strapi: StrapiLike }) => ({
    /** Which content types get the edit view panel. Admin only. */
    async config(ctx: KoaContextLike) {
      const { llms } = getConfig(strapi)
      ctx.set?.('Cache-Control', 'private, no-store')
      ctx.status = 200
      ctx.body = { contentTypes: llms && llms.editorPanel !== false ? Object.keys(llms.contentTypes) : [] }
    },
    /** Checks and previews of the entry being edited (current unsaved values). Admin only, never cached. */
    async inspect(ctx: KoaContextLike) {
      const { llms } = getConfig(strapi)
      ctx.set?.('Cache-Control', 'private, no-store')
      if (!llms) {
        ctx.status = 404
        ctx.body = { error: 'llms is not configured' }
        return
      }
      const result = await inspectStrapiEntry(strapi, llms, ctx, ctx.request.body)
      ctx.status = result.status
      ctx.body = result.body
    },
  }),

  referrals: ({ strapi }: { strapi: StrapiLike }) => ({
    ingest: (ctx: KoaContextLike) => ingestReferralReport(strapi, ctx, getConfig(strapi), setupState.probes),
    evidence: (ctx: KoaContextLike) => evidenceReport(strapi, ctx, getConfig(strapi), ''),
  }),

  setup: ({ strapi }: { strapi: StrapiLike }) => ({
    report: (ctx: KoaContextLike) => setupReport(strapi, getConfig(strapi), setupState, CRAWLER_HIT_UID, ctx),
    test: (ctx: KoaContextLike) => runSetupTest(strapi, getConfig(strapi), setupState, CRAWLER_HIT_UID, ctx),
    documentStats: (ctx: KoaContextLike) => documentStats(strapi, getConfig(strapi), CRAWLER_HIT_UID, ctx),
  }),

  stats: ({ strapi }: { strapi: StrapiLike }) => ({
    async stats(ctx: KoaContextLike) {
      const days = Number(ctx.query?.days ?? 7) || 7
      const { llms } = getConfig(strapi)
      const [hits, contentPaths] = await Promise.all([
        loadHits(strapi, days),
        llms ? loadLlmsDocuments(strapi, llms).then((docs) => docs.map((d) => d.url)) : Promise.resolve(undefined),
      ])
      ctx.status = 200
      ctx.body = summarizeHits(hits, { days, contentPaths })
    },
  }),
}

// Public routes authenticate with the shared secret (ingest) or serve public content (llms), so no API token is needed.
const publicRoute = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [] },
})

export const routes = {
  'content-api': {
    type: 'content-api',
    routes: [
      publicRoute('POST', '/ingest', 'ingest.ingest'),
      publicRoute('POST', '/referrals', 'referrals.ingest'),
      publicRoute('GET', '/llms.txt', 'llms.llmsTxt'),
      publicRoute('GET', '/llms-full.txt', 'llms.llmsFullTxt'),
      publicRoute('GET', '/llms/:file', 'llms.llmsPart'),
      publicRoute('GET', '/markdown', 'page.markdown'),
      publicRoute('GET', '/jsonld', 'page.jsonLd'),
    ],
  },
  admin: {
    type: 'admin',
    routes: [
      { method: 'GET', path: '/stats', handler: 'stats.stats', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'GET', path: '/editor-config', handler: 'editor.config', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'POST', path: '/inspect', handler: 'editor.inspect', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'GET', path: '/setup', handler: 'setup.report', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'POST', path: '/setup/test', handler: 'setup.test', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'GET', path: '/document-stats', handler: 'setup.documentStats', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'GET', path: '/evidence', handler: 'referrals.evidence', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'GET', path: '/invalidations', handler: 'invalidations.list', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'POST', path: '/invalidations/retry', handler: 'invalidations.retry', config: { policies: ['admin::isAuthenticatedAdmin'] } },
      { method: 'POST', path: '/invalidations/flush', handler: 'invalidations.flush', config: { policies: ['admin::isAuthenticatedAdmin'] } },
    ],
  },
}

export default {
  config,
  // Always registered, so Strapi creates the tables; nothing is written to them unless the feature is enabled.
  contentTypes: {
    'crawler-hit': { schema: crawlerHitSchema },
    'ai-referral': { schema: aiReferralSchema },
    citation: { schema: citationSchema },
    invalidation: { schema: invalidationSchema },
  },
  controllers,
  routes,
  register({ strapi }: { strapi: StrapiLike & { documents: { use?(mw: unknown): unknown } } }) {
    ;(strapi.documents as { use?(mw: unknown): unknown }).use?.(citationMiddleware(strapi))
    // Cache notices: does nothing unless `invalidation.targets` is set.
    ;(strapi.documents as { use?(mw: unknown): unknown }).use?.(changeMiddleware(strapi, changeDeps(strapi)))
  },
  bootstrap({ strapi }: { strapi: StrapiLike }) {
    const cfg = getConfig(strapi)
    if (cfg.llms && cfg.invalidation?.targets?.length) subscribePermissionChanges(strapi as never, changeDeps(strapi))
    if (!cfg.secret) {
      strapi.log.warn('[geo] No secret configured: anyone can post crawler hits to /api/geo/ingest.')
      if (cfg.referrals?.enabled) strapi.log.warn('[geo] `referrals` is enabled but no secret is configured, so referral reports are refused.')
    }
  },
}
