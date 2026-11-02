import { lookup } from 'node:dns/promises'
import {
  configChecks,
  documentPathVariants,
  evidenceChecks,
  manualSteps,
  runActiveChecks,
  summarizeDocumentHits,
  type DocumentHit,
  type IngestLog,
  type ProbeRegistry,
  type SetupFacts,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, PayloadRequest, Where } from 'payload'
import { mapDoc, queryCollection, type LlmsOptions } from './llms.js'

export interface DiagnosticsOptions {
  /** Let the connectivity test request loopback / private addresses (local development only). Default false. */
  allowPrivateNetwork?: boolean
  /** Seconds to wait for the frontend proxy's report of the test request. Default 4. */
  probeWaitSeconds?: number
}

export interface SetupContext {
  llms?: LlmsOptions
  collections: CollectionConfig[]
  hitsSlug: string
  serverURL?: string
  secretConfigured: boolean
  ingestEnabled: boolean
  verifyIPs: boolean
  referralsEnabled: boolean
  probes: ProbeRegistry
  log: IngestLog
  diagnostics?: DiagnosticsOptions
}

const MAX_DOCUMENT_HITS = 20_000
const noStore = { 'cache-control': 'private, no-store' }

export async function resolveHost(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address)
}

async function facts(req: PayloadRequest, ctx: SetupContext): Promise<SetupFacts> {
  const payload = req.payload
  const sources: SetupFacts['sources'] = []
  let sample: SetupFacts['sample']
  if (ctx.llms) {
    for (const [slug, source] of Object.entries(ctx.llms.collections)) {
      const config = ctx.collections.find((c) => c.slug === slug)
      if (!config) {
        sources.push({ name: slug, exists: false, publicDocuments: null })
        continue
      }
      const docs = (await queryCollection(payload, slug, config, source))
        .map((d) => mapDoc(d, slug, source, ctx.llms!, ctx.serverURL))
        .filter((d): d is NonNullable<typeof d> => !!d)
      sources.push({ name: slug, exists: true, publicDocuments: docs.length, note: docs.length ? undefined : 'none published and readable anonymously, or no URL' })
      sample ??= docs[0] ? { url: docs[0].url, title: docs[0].title } : undefined
    }
  }
  const latest = await payload.find({ collection: ctx.hitsSlug as never, sort: '-timestamp', limit: 1, depth: 0, overrideAccess: true })
  const hit = latest.docs[0] as Record<string, any> | undefined
  return {
    llmsConfigured: !!ctx.llms,
    siteURL: ctx.llms?.siteURL,
    sources,
    sample,
    markdownLinks: !!ctx.llms?.markdownLinks,
    ingestEnabled: ctx.ingestEnabled,
    secretConfigured: ctx.secretConfigured,
    verifyIPs: ctx.verifyIPs,
    referralsEnabled: ctx.referralsEnabled,
    latestHit: hit ? { timestamp: hit.timestamp, botName: hit.botName, path: hit.path, host: hit.host } : null,
    lastIngestSuccess: ctx.log.lastSuccess,
    recentIngestErrors: ctx.log.recentErrors(),
  }
}

export async function setupReport(req: PayloadRequest, ctx: SetupContext): Promise<Response> {
  if (!req.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore })
  const f = await facts(req, ctx)
  return Response.json(
    { config: configChecks(f), evidence: evidenceChecks(f), manual: manualSteps(f.siteURL, f.sample ? new URL(f.sample.url).pathname : undefined) },
    { headers: noStore },
  )
}

export async function runSetupTest(req: PayloadRequest, ctx: SetupContext): Promise<Response> {
  if (!req.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore })
  if (!ctx.llms) return Response.json({ active: [] }, { headers: noStore })
  const f = await facts(req, ctx)
  const active = await runActiveChecks({
    siteURL: ctx.llms.siteURL,
    sample: f.sample,
    probes: ctx.probes,
    ingestEnabled: ctx.ingestEnabled,
    referralsEnabled: ctx.referralsEnabled && ctx.secretConfigured,
    allowPrivateNetwork: ctx.diagnostics?.allowPrivateNetwork === true,
    resolve: resolveHost,
    probeWaitMs: (ctx.diagnostics?.probeWaitSeconds ?? 4) * 1000,
    signal: (req as { signal?: AbortSignal }).signal,
  })
  return Response.json({ active }, { headers: noStore })
}

/**
 * AI crawler visits to one document's page. The path comes from the document itself (published version when
 * there is one) through the same URL mapping as llms.txt, never from the title or a client-sent path.
 */
export async function documentStats(req: PayloadRequest, ctx: SetupContext): Promise<Response> {
  if (!req.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore })
  const params = new URL(req.url ?? '', 'http://x').searchParams
  const slug = params.get('collection') ?? ''
  const id = params.get('id')
  const days = Number(params.get('days') ?? 30) || 30
  const source = ctx.llms && Object.prototype.hasOwnProperty.call(ctx.llms.collections, slug) ? ctx.llms.collections[slug] : undefined
  if (!ctx.llms || !source || !ctx.collections.some((c) => c.slug === slug)) return Response.json({ error: 'collection is not configured for GEO' }, { status: 404, headers: noStore })
  if (!id) return Response.json({ unavailable: 'Save the document to see its visits.' }, { headers: noStore })
  let doc: Record<string, any>
  try {
    doc = (await req.payload.findByID({ collection: slug as never, id, depth: 1, overrideAccess: false, user: req.user, req })) as Record<string, any>
  } catch (error) {
    const status = (error as { status?: number })?.status
    return Response.json({ error: status === 404 ? 'not found' : 'forbidden' }, { status: status === 404 ? 404 : 403, headers: noStore })
  }
  const mapped = mapDoc(doc, slug, source, ctx.llms, ctx.serverURL)
  if (!mapped) return Response.json({ unavailable: 'This document has no frontend URL yet.' }, { headers: noStore })
  const url = new URL(mapped.url)
  const path = url.pathname
  const from = new Date(Date.now() - (Math.min(days, 365) + 1) * 86_400_000).toISOString()
  const where: Where = {
    and: [
      { timestamp: { greater_than_equal: from } },
      { or: [{ path: { in: documentPathVariants(path) } }, { path: { contains: `${path}?` } }, { path: { contains: `${path}.md?` } }, { path: { contains: `${path}/?` } }] },
    ],
  }
  const result = await req.payload.find({
    collection: ctx.hitsSlug as never,
    where,
    limit: MAX_DOCUMENT_HITS,
    pagination: false,
    depth: 0,
    sort: '-timestamp',
    select: { platform: true, purpose: true, verification: true, path: true, timestamp: true, botId: true, host: true } as never,
    overrideAccess: true,
  })
  const hosts = [url.host, ...(ctx.llms.hosts ?? [])]
  return Response.json(summarizeDocumentHits(result.docs as unknown as DocumentHit[], { path, hosts, days }), { headers: noStore })
}
