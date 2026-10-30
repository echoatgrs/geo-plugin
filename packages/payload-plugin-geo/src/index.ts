import {
  GEO_SECRET_HEADER,
  createIPVerifier,
  ingestHits,
  summarizeHits,
  windowStart,
  type HitStore,
  type IPVerifierOptions,
  type StatsHit,
} from '@headless-geo/core'
import type { CollectionConfig, Config, Endpoint, Plugin } from 'payload'
import { CRAWLER_HITS_SLUG, crawlerHitsCollection } from './collection.js'
import { loadLlmsDocuments, renderLlms, type LlmsOptions, type PayloadLlmsSource } from './llms.js'

export interface GeoPluginOptions {
  /** Shared secret the frontend proxy sends. Strongly recommended when the frontend is on another host. */
  secret?: string
  /** Check crawler IPs against vendor-published ranges. Default true. */
  verifyIPs?: boolean | IPVerifierOptions
  /** Store hits whose IP does not match the claimed bot. Default true. */
  storeSpoofed?: boolean
  /** Path of the ingest endpoint under the Payload API route. Default `/geo/ingest`. */
  ingestPath?: string
  /** Customize the generated collection (labels, access, admin, ...). */
  collection?: Partial<CollectionConfig>
  /** Serve `/api/geo/llms.txt` and `/api/geo/llms-full.txt` from these collections. */
  llms?: LlmsOptions
  /** Show the AI visibility dashboard on the admin home and the crawler hits list. Default true. */
  dashboard?: boolean
  /** Keep the collection and schema but stop accepting hits. Default true. */
  enabled?: boolean
}

export { CRAWLER_HITS_SLUG, crawlerHitsCollection, type LlmsOptions, type PayloadLlmsSource }

const MAX_STATS_HITS = 100_000

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  })
}

export const geoPlugin =
  (options: GeoPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    const verifyIPs = options.verifyIPs ?? true
    const verifier = verifyIPs ? createIPVerifier(verifyIPs === true ? {} : verifyIPs) : undefined
    const collection = crawlerHitsCollection(options.collection)
    const collections = [...(config.collections ?? []), collection]

    const ingestEndpoint: Endpoint = {
      path: options.ingestPath ?? '/geo/ingest',
      method: 'post',
      handler: async (req) => {
        if (options.enabled === false) return Response.json({ ok: false, error: 'disabled' }, { status: 503 })
        let body: unknown
        try {
          body = await req.json?.()
        } catch {
          return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
        }
        const store: HitStore = {
          async save(hit) {
            await req.payload.create({ collection: collection.slug as never, data: hit as never, overrideAccess: true, req })
          },
        }
        const result = await ingestHits(body, req.headers.get(GEO_SECRET_HEADER), {
          secret: options.secret,
          verifier,
          storeSpoofed: options.storeSpoofed,
          store,
        })
        return Response.json(result.body, { status: result.status })
      },
    }

    const statsEndpoint: Endpoint = {
      path: '/geo/stats',
      method: 'get',
      handler: async (req) => {
        if (!req.user) return Response.json({ error: 'unauthorized' }, { status: 401 })
        const days = Number(new URL(req.url ?? '', 'http://x').searchParams.get('days') ?? 7) || 7
        const result = await req.payload.find({
          collection: collection.slug as never,
          where: { timestamp: { greater_than_equal: windowStart(days).toISOString() } },
          limit: MAX_STATS_HITS,
          pagination: false,
          depth: 0,
          select: { platform: true, purpose: true, verification: true, path: true, timestamp: true, botId: true } as never,
          overrideAccess: true,
        })
        const contentPaths = options.llms
          ? (await loadLlmsDocuments(req.payload, options.llms, collections)).map((d) => d.url)
          : undefined
        return Response.json(summarizeHits(result.docs as unknown as StatsHit[], { days, contentPaths }))
      },
    }

    const endpoints: Endpoint[] = [ingestEndpoint, statsEndpoint]
    if (options.llms) {
      const llms = options.llms
      for (const full of [false, true]) {
        endpoints.push({
          path: full ? '/geo/llms-full.txt' : '/geo/llms.txt',
          method: 'get',
          handler: async (req) => text(renderLlms(llms, await loadLlmsDocuments(req.payload, llms, collections), full)),
        })
      }
    }

    if (options.dashboard !== false) {
      const apiRoute = `${config.serverURL ?? ''}${config.routes?.api ?? '/api'}`
      const hitsHref = `${config.routes?.admin ?? '/admin'}/collections/${collection.slug}`
      const component = (compact: boolean) => ({
        path: 'payload-plugin-geo/client#GeoDashboardClient',
        clientProps: { statsURL: `${apiRoute}/geo/stats`, compact, moreHref: hitsHref, hitsHref },
      })
      collection.admin = {
        ...collection.admin,
        components: {
          ...collection.admin?.components,
          beforeList: [...(collection.admin?.components?.beforeList ?? []), component(false)],
        },
      }
      config = {
        ...config,
        admin: {
          ...config.admin,
          components: {
            ...config.admin?.components,
            beforeDashboard: [...(config.admin?.components?.beforeDashboard ?? []), component(true)],
          },
        },
      }
    }

    return {
      ...config,
      collections,
      endpoints: [...(config.endpoints ?? []), ...endpoints],
    }
  }
