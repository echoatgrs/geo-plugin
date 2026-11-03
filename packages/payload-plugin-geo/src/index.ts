import {
  GEO_SECRET_HEADER,
  IngestLog,
  ProbeRegistry,
  createIPVerifier,
  findProbeInBody,
  ingestHits,
  parseOmit,
  summarizeHits,
  windowStart,
  type BotDefinition,
  type HitStore,
  type IPVerifierOptions,
  type StatsHit,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Config, Endpoint, Plugin } from 'payload'
import { CRAWLER_HITS_SLUG, crawlerHitsCollection } from './collection.js'
import {
  AI_REFERRALS_SLUG,
  CITATIONS_SLUG,
  citationScreenshotsCollection,
  citationsCollection,
  evidenceEndpoints,
  referralsCollection,
  type CitationOptions,
  type ReferralOptions,
} from './evidence.js'
import { inspectPayloadDocument } from './inspect.js'
import { documentStats, runSetupTest, setupReport, type DiagnosticsOptions, type SetupContext } from './setup.js'
import {
  loadDocumentByPath,
  loadLlmsDocuments,
  validateLlmsOptions,
  renderJsonLd,
  renderLlms,
  renderMarkdown,
  type LlmsOptions,
  type PayloadLlmsSource,
} from './llms.js'

export interface GeoPluginOptions {
  /** Shared secret the frontend proxy sends. Strongly recommended when the frontend is on another host. */
  secret?: string
  /** Check crawler IPs against vendor-published ranges. Default true. */
  verifyIPs?: boolean | IPVerifierOptions
  /** Store hits whose IP does not match the claimed bot. Default true. */
  storeSpoofed?: boolean
  /**
   * Bot list used to classify reported hits. Default: the built-in list. Use `defineBots([...])` to add your own,
   * and pass the same list to withGeo({ bots }) in the frontend.
   */
  bots?: readonly BotDefinition[]
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
  /**
   * Add a read-only GEO check panel to the sidebar of every collection in `llms.collections`. Default true.
   * It stores nothing and never changes the document.
   */
  editorPanel?: boolean
  /** Setup status view: connectivity test limits. */
  diagnostics?: DiagnosticsOptions
  /**
   * AI referral visits: browser visits from an AI assistant, reported by withGeo({ referrals }). Off by default;
   * enabling it adds the `geo-ai-referrals` collection (a migration on SQL databases).
   */
  referrals?: ReferralOptions
  /**
   * Citation evidence entered by hand. Off by default; enabling it adds the `geo-citations` collection
   * (and `geo-citation-screenshots` unless `screenshots: false`), which needs a migration on SQL databases.
   */
  citations?: CitationOptions
}

export { AI_REFERRALS_SLUG, CITATIONS_SLUG, type CitationOptions, type ReferralOptions }
export { CRAWLER_HITS_SLUG, crawlerHitsCollection, loadDocumentByPath, loadLlmsDocuments, type LlmsOptions, type PayloadLlmsSource }

const MAX_STATS_HITS = 100_000

/** `Cache-Control` for public output. Errors are cached briefly so a newly published page shows up soon. */
export function cacheControl(maxAge: number | undefined, status: number): string {
  const age = maxAge ?? 300
  if (age <= 0) return 'no-store'
  return `public, max-age=${status === 200 ? age : Math.min(age, 60)}`
}

function text(body: string, status = 200, type = 'text/plain', maxAge?: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': cacheControl(maxAge, status) },
  })
}

function pathParam(req: { url?: string }): string | null {
  const path = new URL(req.url ?? '', 'http://x').searchParams.get('path')
  return path && path.startsWith('/') ? path : null
}

export const geoPlugin =
  (options: GeoPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    if (options.llms) validateLlmsOptions(options.llms)
    const verifyIPs = options.verifyIPs ?? true
    const verifier = verifyIPs ? createIPVerifier(verifyIPs === true ? {} : verifyIPs) : undefined
    const probes = new ProbeRegistry()
    const ingestLog = new IngestLog()
    const collection = crawlerHitsCollection(options.collection)
    const apiRoute = config.routes?.api ?? '/api'
    const editorPanel = options.llms && options.editorPanel !== false
    const collections = [
      ...(config.collections ?? []).map((c) =>
        editorPanel && options.llms!.collections[c.slug]
          ? {
              ...c,
              fields: [
                ...c.fields,
                {
                  name: 'geoPanel',
                  type: 'ui' as const,
                  admin: {
                    position: 'sidebar' as const,
                    components: {
                      Field: {
                        path: 'payload-plugin-geo/client#GeoEditPanel',
                        clientProps: {
                          inspectURL: `${config.serverURL ?? ''}${apiRoute}/geo/inspect`,
                          statsURL: `${config.serverURL ?? ''}${apiRoute}/geo/document-stats`,
                          collection: c.slug,
                        },
                      },
                    },
                  },
                },
              ],
            }
          : c,
      ),
      collection,
    ]
    const referralsOn = options.referrals?.enabled === true
    const citationsOn = options.citations?.enabled === true
    if (referralsOn) collections.push(referralsCollection(options.referrals?.collection))
    if (citationsOn) {
      const screenshots = options.citations?.screenshots !== false
      if (screenshots) collections.push(citationScreenshotsCollection())
      collections.push(citationsCollection({ usersSlug: config.admin?.user ?? 'users', screenshots, overrides: options.citations?.collection }))
    }

    const ingestEndpoint: Endpoint = {
      path: options.ingestPath ?? '/geo/ingest',
      method: 'post',
      handler: async (req) => {
        let body: unknown
        try {
          body = await req.json?.()
        } catch {
          if (options.enabled === false) return Response.json({ ok: false, error: 'disabled' }, { status: 503 })
          ingestLog.record({ at: new Date().toISOString(), status: 400, error: 'invalid json' })
          return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
        }
        if (options.enabled === false) {
          const probe = findProbeInBody(body, probes)
          if (probe) probes.record(probe.token, 'disabled', probe)
          return Response.json({ ok: false, error: 'disabled' }, { status: 503 })
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
          bots: options.bots,
          store,
          probes,
          log: ingestLog,
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
          ? (await loadLlmsDocuments(req.payload, options.llms, collections, config.serverURL)).map((d) => d.url)
          : undefined
        return Response.json(summarizeHits(result.docs as unknown as StatsHit[], { days, contentPaths }))
      },
    }

    const setupContext: SetupContext = {
      llms: options.llms,
      collections,
      hitsSlug: collection.slug,
      serverURL: config.serverURL,
      secretConfigured: !!options.secret,
      ingestEnabled: options.enabled !== false,
      verifyIPs: !!verifyIPs,
      referralsEnabled: referralsOn,
      probes,
      log: ingestLog,
      diagnostics: options.diagnostics,
    }
    const endpoints: Endpoint[] = [
      ingestEndpoint,
      statsEndpoint,
      // Admin only: setup status, the explicit connectivity test, and per-document visits.
      { path: '/geo/setup', method: 'get', handler: (req) => setupReport(req, setupContext) },
      { path: '/geo/setup/test', method: 'post', handler: (req) => runSetupTest(req, setupContext) },
      { path: '/geo/document-stats', method: 'get', handler: (req) => documentStats(req, setupContext) },
      ...evidenceEndpoints({ referrals: options.referrals, citations: options.citations, secret: options.secret, probes, adminRoute: config.routes?.admin ?? '/admin' }),
    ]
    if (options.llms) {
      const llms = options.llms
      for (const full of [false, true]) {
        endpoints.push({
          path: full ? '/geo/llms-full.txt' : '/geo/llms.txt',
          method: 'get',
          handler: async (req) =>
            text(renderLlms(llms, await loadLlmsDocuments(req.payload, llms, collections, config.serverURL), full), 200, 'text/plain', llms.cacheMaxAge),
        })
      }
      // Editor checks and previews of the current (possibly unsaved) edits: logged-in users only, never cached.
      endpoints.push({
        path: '/geo/inspect',
        method: 'post',
        handler: async (req) => {
          let body: unknown
          try {
            body = await req.json?.()
          } catch {
            return Response.json({ error: 'invalid json' }, { status: 400, headers: { 'cache-control': 'private, no-store' } })
          }
          const result = await inspectPayloadDocument(req, { llms, collections, serverURL: config.serverURL, apiRoute }, body)
          return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'private, no-store' } })
        },
      })
      // Per-page Markdown and JSON-LD: `?path=/blog/post` (the frontend path, without `.md`).
      endpoints.push(
        {
          path: '/geo/markdown',
          method: 'get',
          handler: async (req) => {
            const path = pathParam(req)
            if (!path) return text('`path` query parameter is required\n', 400)
            const doc = await loadDocumentByPath(req.payload, llms, collections, path, config.serverURL)
            return doc ? text(renderMarkdown(doc), 200, 'text/markdown', llms.cacheMaxAge) : text('Not found\n', 404, 'text/plain', llms.cacheMaxAge)
          },
        },
        {
          path: '/geo/jsonld',
          method: 'get',
          handler: async (req) => {
            const path = pathParam(req)
            if (!path) return Response.json({ error: '`path` query parameter is required' }, { status: 400 })
            const doc = await loadDocumentByPath(req.payload, llms, collections, path, config.serverURL)
            const omit = parseOmit(new URL(req.url ?? '', 'http://x').searchParams.get('omit'), llms.hostManaged)
            const data = doc ? renderJsonLd(llms, doc, omit) : null
            if (!data) return Response.json({ error: 'not found' }, { status: 404, headers: { 'cache-control': cacheControl(llms.cacheMaxAge, 404) } })
            return new Response(JSON.stringify(data), {
              headers: { 'content-type': 'application/ld+json; charset=utf-8', 'cache-control': cacheControl(llms.cacheMaxAge, 200) },
            })
          },
        },
      )
    }

    if (options.dashboard !== false) {
      const statsBase = `${config.serverURL ?? ''}${apiRoute}`
      const hitsHref = `${config.routes?.admin ?? '/admin'}/collections/${collection.slug}`
      const component = (compact: boolean) => ({
        path: 'payload-plugin-geo/client#GeoDashboardClient',
        clientProps: {
          statsURL: `${statsBase}/geo/stats`,
          setupURL: compact ? undefined : `${statsBase}/geo/setup`,
          evidenceURL: compact ? undefined : `${statsBase}/geo/evidence`,
          compact,
          moreHref: hitsHref,
          hitsHref,
        },
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

    const onInit = config.onInit
    return {
      ...config,
      collections,
      endpoints: [...(config.endpoints ?? []), ...endpoints],
      async onInit(payload) {
        if (options.enabled !== false && !options.secret) {
          payload.logger.warn('[geo] No secret configured: anyone can post crawler hits to the ingest endpoint. Set `secret` in geoPlugin().')
        }
        if (referralsOn && !options.secret) {
          payload.logger.warn('[geo] `referrals` is enabled but no secret is configured, so referral reports are refused. Set `secret` in geoPlugin().')
        }
        await onInit?.(payload)
      },
    }
  }
