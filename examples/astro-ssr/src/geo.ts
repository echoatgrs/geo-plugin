import { geoFetchHandler, revalidationHandler } from '@garus-ltd/geo-next'

// Read at runtime (Node adapter), not at build time.
export const CMS = (process.env.CMS_URL ?? 'http://localhost:1337').replace(/\/+$/, '')

export const geo = geoFetchHandler({
  endpoint: `${CMS}/api/geo/ingest`,
  secret: process.env.GEO_SECRET,
  llms: { source: `${CMS}/api/geo/llms.txt`, segments: `${CMS}/api/geo/llms` },
  markdown: { source: `${CMS}/api/geo/markdown` },
})

/** Pages rendered from the CMS, kept until a cache notice drops them. */
export const pageCache = new Map<string, unknown>()

export const revalidate = process.env.GEO_REVALIDATE_SECRET
  ? revalidationHandler({
      secret: process.env.GEO_REVALIDATE_SECRET,
      onEvent(event) {
        for (const path of event.paths) pageCache.delete(path)
        console.log(`[geo] ${event.type} ${event.source}: dropped ${event.paths.join(', ')}`)
      },
    })
  : null
