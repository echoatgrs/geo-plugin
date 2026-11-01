import {
  GEO_SECRET_HEADER,
  buildJsonLd,
  buildLlmsFullTxt,
  buildLlmsTxt,
  createIPVerifier,
  documentMarkdown,
  findDocumentByPath,
  ingestHits,
  lastSegment,
  richTextToMarkdown,
  summarizeHits,
  toLlmsDocument,
  windowStart,
  type IPVerifier,
  type LlmsDocument,
  type StatsHit,
} from '@garus-ltd/geo-core'
import config, { type GeoStrapiConfig, type StrapiLlmsConfig } from './config'
import crawlerHitSchema from './content-types/crawler-hit/schema'
import type { KoaContextLike, StrapiLike } from './types'

export const CRAWLER_HIT_UID = 'plugin::geo.crawler-hit'
const PAGE_SIZE = 1000
const MAX_STATS_HITS = 100_000

let verifier: IPVerifier | undefined

function getConfig(strapi: StrapiLike): GeoStrapiConfig {
  const plugin = strapi.plugin('geo')
  return {
    secret: plugin.config('secret', ''),
    verifyIPs: plugin.config('verifyIPs', true),
    storeSpoofed: plugin.config('storeSpoofed', true),
    enabled: plugin.config('enabled', true),
    llms: plugin.config('llms', null),
  }
}

type StrapiLlmsSource = StrapiLlmsConfig['contentTypes'][string]

async function findEntries(strapi: StrapiLike, uid: string, source: StrapiLlmsSource, extra?: Record<string, unknown>) {
  const filters = source.filters && extra ? { $and: [source.filters, extra] } : (extra ?? source.filters)
  return strapi.documents(uid).findMany({
    // Only published entries for draft & publish content types; ignored otherwise.
    status: 'published',
    filters,
    // Relations and media (author, cover image, FAQ components) for JSON-LD.
    populate: '*',
    limit: source.limit ?? 500,
    sort: 'updatedAt:desc',
  })
}

function mapper(strapi: StrapiLike, llms: StrapiLlmsConfig, uid: string, source: StrapiLlmsSource) {
  const name = strapi.contentType?.(uid)?.info?.pluralName ?? uid.split('.').pop() ?? uid
  const mediaURL = llms.mediaURL ?? (strapi.config?.get<string>('server.url', '') || undefined)
  return (entry: Record<string, any>) =>
    toLlmsDocument(entry, { name, siteURL: llms.siteURL, source, markdown: richTextToMarkdown, mediaURL })
}

export async function loadLlmsDocuments(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<LlmsDocument[]> {
  const docs: LlmsDocument[] = []
  for (const [uid, source] of Object.entries(llms.contentTypes)) {
    const map = mapper(strapi, llms, uid, source)
    for (const entry of await findEntries(strapi, uid, source)) {
      const mapped = map(entry)
      if (mapped) docs.push(mapped)
    }
  }
  return docs
}

/**
 * The published entry served at a frontend path. Content types with a `slug` attribute are
 * queried by the path's last segment; others are scanned.
 */
export async function loadDocumentByPath(strapi: StrapiLike, llms: StrapiLlmsConfig, path: string): Promise<LlmsDocument | undefined> {
  const slug = lastSegment(path)
  for (const [uid, source] of Object.entries(llms.contentTypes)) {
    const bySlug = !!strapi.contentType?.(uid)?.attributes?.slug
    if (bySlug && !slug) continue
    const map = mapper(strapi, llms, uid, source)
    const entries = await findEntries(strapi, uid, source, bySlug ? { slug: { $eq: slug } } : undefined)
    const match = findDocumentByPath(entries.map(map).filter((d): d is LlmsDocument => !!d), path)
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

function sendText(ctx: KoaContextLike, body: string, type = 'text/plain', status = 200) {
  ctx.set?.('Content-Type', `${type}; charset=utf-8`)
  ctx.set?.('Cache-Control', `public, max-age=${status === 200 ? 300 : 60}`)
  ctx.status = status
  ctx.body = body
}

function pathQuery(ctx: KoaContextLike): string | null {
  const path = ctx.query?.path
  return typeof path === 'string' && path.startsWith('/') ? path : null
}

export const controllers = {
  ingest: ({ strapi }: { strapi: StrapiLike }) => ({
    async ingest(ctx: KoaContextLike) {
      const cfg = getConfig(strapi)
      if (!cfg.enabled) {
        ctx.status = 503
        ctx.body = { ok: false, error: 'disabled' }
        return
      }
      const result = await ingestHits(ctx.request.body, ctx.request.get(GEO_SECRET_HEADER) || null, {
        secret: cfg.secret || undefined,
        verifier: cfg.verifyIPs ? (verifier ??= createIPVerifier()) : undefined,
        storeSpoofed: cfg.storeSpoofed,
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
      const docs = await loadLlmsDocuments(strapi, llms)
      const site = { name: llms.name ?? llms.siteURL, description: llms.description, details: llms.details }
      sendText(ctx, full ? buildLlmsFullTxt(site, docs) : buildLlmsTxt(site, docs, { markdownLinks: llms.markdownLinks }))
    }
    return {
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
      if (!doc) sendText(ctx, 'Not found\n', 'text/plain', 404)
      return doc ? { llms, doc } : null
    }
    return {
      async markdown(ctx: KoaContextLike) {
        const found = await find(ctx)
        if (found) sendText(ctx, documentMarkdown(found.doc), 'text/markdown')
      },
      async jsonLd(ctx: KoaContextLike) {
        const found = await find(ctx)
        if (!found) return
        const { llms, doc } = found
        const data = buildJsonLd(
          { name: llms.name ?? llms.siteURL, url: llms.siteURL, logo: llms.logo, language: llms.language },
          doc,
        )
        if (!data) return sendText(ctx, 'Not found\n', 'text/plain', 404)
        sendText(ctx, JSON.stringify(data), 'application/ld+json')
      },
    }
  },

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
      publicRoute('GET', '/llms.txt', 'llms.llmsTxt'),
      publicRoute('GET', '/llms-full.txt', 'llms.llmsFullTxt'),
      publicRoute('GET', '/markdown', 'page.markdown'),
      publicRoute('GET', '/jsonld', 'page.jsonLd'),
    ],
  },
  admin: {
    type: 'admin',
    routes: [
      { method: 'GET', path: '/stats', handler: 'stats.stats', config: { policies: ['admin::isAuthenticatedAdmin'] } },
    ],
  },
}

export default {
  config,
  contentTypes: { 'crawler-hit': { schema: crawlerHitSchema } },
  controllers,
  routes,
  register() {},
  bootstrap({ strapi }: { strapi: StrapiLike }) {
    if (!getConfig(strapi).secret) {
      strapi.log.warn('[geo] No secret configured: anyone can post crawler hits to /api/geo/ingest.')
    }
  },
}
