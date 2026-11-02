import { lookup } from 'node:dns/promises'
import {
  configChecks,
  documentPathVariants,
  evidenceChecks,
  manualSteps,
  mapLlmsDocument,
  richTextToMarkdown,
  runActiveChecks,
  summarizeDocumentHits,
  type DocumentHit,
  type IngestLog,
  type ProbeRegistry,
  type SetupFacts,
} from '@garus-ltd/geo-core'
import { publicAccess } from './access'
import type { GeoStrapiConfig } from './config'
import type { KoaContextLike, StrapiLike } from './types'

const MAX_DOCUMENT_HITS = 20_000

export interface SetupState {
  probes: ProbeRegistry
  log: IngestLog
}

async function facts(strapi: StrapiLike, cfg: GeoStrapiConfig, state: SetupState, hitsUID: string): Promise<SetupFacts> {
  const llms = cfg.llms
  const sources: SetupFacts['sources'] = []
  let sample: SetupFacts['sample']
  if (llms) {
    const access = await publicAccess(strapi, llms)
    for (const [uid, source] of Object.entries(llms.contentTypes)) {
      if (!strapi.contentType?.(uid)) {
        sources.push({ name: uid, exists: false, publicDocuments: null })
        continue
      }
      if (!access.allowed.has(uid)) {
        sources.push({ name: uid, exists: true, publicDocuments: 0, note: 'the Public role can’t `find` it, or its route has policies without `isPublic`' })
        continue
      }
      const name = strapi.contentType?.(uid)?.info?.pluralName ?? uid
      const entries = await strapi.documents(uid).findMany({ status: 'published', filters: source.filters, populate: '*', limit: source.limit ?? 500 })
      let count = 0
      for (const entry of entries) {
        const visible = await access.filter(uid, source, entry)
        const doc = visible && mapLlmsDocument(visible, { name, siteURL: llms.siteURL, source, markdown: richTextToMarkdown }).document
        if (!doc) continue
        count++
        sample ??= { url: doc.url, title: doc.title }
      }
      sources.push({ name: uid, exists: true, publicDocuments: count, note: count ? undefined : 'nothing published, or no URL' })
    }
  }
  const [hit] = await strapi.documents(hitsUID).findMany({ sort: 'timestamp:desc', limit: 1, fields: ['timestamp', 'botName', 'path', 'host'] })
  return {
    llmsConfigured: !!llms,
    siteURL: llms?.siteURL,
    sources,
    sample,
    markdownLinks: !!llms?.markdownLinks,
    ingestEnabled: cfg.enabled,
    secretConfigured: !!cfg.secret,
    verifyIPs: cfg.verifyIPs,
    referralsEnabled: cfg.referrals?.enabled === true,
    latestHit: hit ? { timestamp: hit.timestamp, botName: hit.botName, path: hit.path, host: hit.host } : null,
    lastIngestSuccess: state.log.lastSuccess,
    recentIngestErrors: state.log.recentErrors(),
  }
}

function noStore(ctx: KoaContextLike) {
  ctx.set?.('Cache-Control', 'private, no-store')
}

export async function setupReport(strapi: StrapiLike, cfg: GeoStrapiConfig, state: SetupState, hitsUID: string, ctx: KoaContextLike) {
  noStore(ctx)
  const f = await facts(strapi, cfg, state, hitsUID)
  ctx.status = 200
  ctx.body = { config: configChecks(f), evidence: evidenceChecks(f), manual: manualSteps(f.siteURL, f.sample ? new URL(f.sample.url).pathname : undefined) }
}

export async function runSetupTest(strapi: StrapiLike, cfg: GeoStrapiConfig, state: SetupState, hitsUID: string, ctx: KoaContextLike) {
  noStore(ctx)
  if (!cfg.llms) {
    ctx.status = 200
    ctx.body = { active: [] }
    return
  }
  const f = await facts(strapi, cfg, state, hitsUID)
  const diagnostics = cfg.diagnostics ?? {}
  ctx.status = 200
  ctx.body = {
    active: await runActiveChecks({
      siteURL: cfg.llms.siteURL,
      sample: f.sample,
      probes: state.probes,
      ingestEnabled: cfg.enabled,
      referralsEnabled: cfg.referrals?.enabled === true && !!cfg.secret,
      allowPrivateNetwork: diagnostics.allowPrivateNetwork === true,
      resolve: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
      probeWaitMs: (diagnostics.probeWaitSeconds ?? 4) * 1000,
    }),
  }
}

/** Visits to one entry's page. The path comes from the entry through the llms URL mapping, never from the client. */
export async function documentStats(strapi: StrapiLike, cfg: GeoStrapiConfig, hitsUID: string, ctx: KoaContextLike) {
  noStore(ctx)
  const uid = typeof ctx.query?.model === 'string' ? ctx.query.model : ''
  const documentId = typeof ctx.query?.documentId === 'string' ? ctx.query.documentId : ''
  const days = Number(ctx.query?.days ?? 30) || 30
  const llms = cfg.llms
  const source = llms && Object.prototype.hasOwnProperty.call(llms.contentTypes, uid) ? llms.contentTypes[uid] : undefined
  if (!llms || !source) {
    ctx.status = 404
    ctx.body = { error: 'content type is not configured for GEO' }
    return
  }
  if (!ctx.state?.userAbility?.can('plugin::content-manager.explorer.read', uid)) {
    ctx.status = 403
    ctx.body = { error: 'forbidden' }
    return
  }
  if (!documentId) {
    ctx.status = 200
    ctx.body = { unavailable: 'Save the entry to see its visits.' }
    return
  }
  const docs = strapi.documents(uid)
  const entry = (await docs.findOne?.({ documentId, status: 'published', populate: '*' })) ?? (await docs.findOne?.({ documentId, status: 'draft', populate: '*' }))
  if (!entry) {
    ctx.status = 404
    ctx.body = { error: 'not found' }
    return
  }
  const name = strapi.contentType?.(uid)?.info?.pluralName ?? uid
  const doc = mapLlmsDocument(entry, { name, siteURL: llms.siteURL, source, markdown: richTextToMarkdown }).document
  if (!doc) {
    ctx.status = 200
    ctx.body = { unavailable: 'This entry has no frontend URL yet.' }
    return
  }
  const url = new URL(doc.url)
  const path = url.pathname
  const from = new Date(Date.now() - (Math.min(days, 365) + 1) * 86_400_000).toISOString()
  const hits = await strapi.documents(hitsUID).findMany({
    filters: {
      timestamp: { $gte: from },
      $or: [{ path: { $in: documentPathVariants(path) } }, { path: { $startsWith: `${path}?` } }, { path: { $startsWith: `${path}.md?` } }, { path: { $startsWith: `${path}/?` } }],
    },
    fields: ['platform', 'purpose', 'verification', 'path', 'timestamp', 'botId', 'host'],
    sort: 'timestamp:desc',
    limit: MAX_DOCUMENT_HITS,
  })
  ctx.status = 200
  ctx.body = summarizeDocumentHits(hits as unknown as DocumentHit[], { path, hosts: [url.host, ...(llms.hosts ?? [])], days })
}
