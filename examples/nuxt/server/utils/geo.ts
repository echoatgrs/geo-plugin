import { geoFetchHandler, revalidationHandler } from '@garus-ltd/geo-next'

let handler: ReturnType<typeof geoFetchHandler> | null = null
let receiver: ReturnType<typeof revalidationHandler> | null | undefined

export function cmsURL(): string {
  return String(useRuntimeConfig().cmsUrl).replace(/\/+$/, '')
}

export function geo() {
  const cms = cmsURL()
  return (handler ??= geoFetchHandler({
    endpoint: `${cms}/api/geo/ingest`,
    secret: String(useRuntimeConfig().geoSecret) || undefined,
    llms: { source: `${cms}/api/geo/llms.txt`, segments: `${cms}/api/geo/llms` },
    markdown: { source: `${cms}/api/geo/markdown` },
  }))
}

/** Signed cache notices from the CMS: drops the cached JSON-LD of every path in the event. */
export function revalidator() {
  if (receiver !== undefined) return receiver
  const secret = String(useRuntimeConfig().geoRevalidateSecret)
  receiver = secret
    ? revalidationHandler({
        secret,
        async onEvent(event) {
          const cache = useStorage('cache')
          for (const path of event.paths) await cache.removeItem(`geo:page:${path}`)
          console.log(`[geo] ${event.type} ${event.source}: dropped ${event.paths.join(', ')}`)
        },
      })
    : null
  return receiver
}
