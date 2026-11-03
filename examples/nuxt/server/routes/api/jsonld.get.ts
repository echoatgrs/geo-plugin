import { fetchJsonLd } from '@garus-ltd/geo-next'

/** JSON-LD of a page, cached in Nitro storage until a cache notice drops it. */
export default defineEventHandler(async (event) => {
  const path = String(getQuery(event).path ?? '')
  if (!path.startsWith('/')) throw createError({ statusCode: 400 })
  const cache = useStorage('cache')
  const key = `geo:page:${path}`
  const cached = await cache.getItem(key)
  if (cached !== null) return cached
  const data = await fetchJsonLd({ source: `${cmsURL()}/api/geo/jsonld`, path }).catch(() => null)
  await cache.setItem(key, data)
  return data
})
