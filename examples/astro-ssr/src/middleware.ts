import { defineMiddleware } from 'astro:middleware'
import { geo } from './geo'

export const onRequest = defineMiddleware(async (context, next) => {
  // Reports AI crawlers in the background; answers /llms.txt, /llms/<part>.txt and Markdown requests itself.
  const handled = await geo(context.request)
  return handled ?? next()
})
