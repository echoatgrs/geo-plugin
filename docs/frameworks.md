# Frontends other than Next.js

`@garus-ltd/geo-next` has no Next.js dependency. Next.js uses `withGeo`, `llmsRoute`, `llmsSegmentRoute` and
`revalidationHandler` directly. Every other framework with Fetch API `Request` / `Response` uses
`geoFetchHandler`, which does what `withGeo` and the llms routes do together:

```ts
import { geoFetchHandler } from '@garus-ltd/geo-next'

const geo = geoFetchHandler({
  endpoint: `${CMS}/api/geo/ingest`,          // crawler reports
  secret: process.env.GEO_SECRET,
  referrals: { endpoint: `${CMS}/api/geo/referrals`, consent: (req) => hasAnalyticsConsent(req) }, // optional
  llms: { source: `${CMS}/api/geo/llms.txt`, segments: `${CMS}/api/geo/llms` },                  // /llms.txt, /llms-full.txt, /llms/<part>
  markdown: { source: `${CMS}/api/geo/markdown` },                                             // /x.md and Accept: text/markdown
})

const response = await geo(request, { waitUntil }) // Response when it handled the request, else null
```

Runnable examples (pinned versions, tested with real requests against Strapi 5.60 and Payload 3.92):

| Example | Versions | Where GEO hooks in |
| --- | --- | --- |
| [`examples/astro-ssr`](../examples/astro-ssr) | Astro 7.4.1, @astrojs/node 11.1.9 (`output: 'server'`) | `src/middleware.ts`; JSON-LD in `src/pages/[...path].astro`; receiver `src/pages/api/geo-revalidate.ts` |
| [`examples/nuxt`](../examples/nuxt) | Nuxt 4.6.2 | `server/middleware/geo.ts`; JSON-LD via `server/routes/api/jsonld.get.ts` + `useHead`; receiver `server/routes/api/geo-revalidate.post.ts` |
| [`examples/node-http`](../examples/node-http) | Node ≥ 20, no framework | `server.mjs`: Node request → `Request`, `Response` → Node response |

Each needs `CMS_URL` (Nuxt: `NUXT_CMS_URL`), `GEO_SECRET` and, for cache notices, `GEO_REVALIDATE_SECRET`
(the target `secret` in the CMS's `invalidation.targets`).

```bash
cd examples/node-http && npm install && CMS_URL=http://localhost:1337 GEO_SECRET=… node server.mjs
cd examples/astro-ssr && npm install && npm run build && CMS_URL=… npm start
cd examples/nuxt && npm install && npm run build && NUXT_CMS_URL=… npm start
```

Notes:

- Static builds (Astro `output: 'static'`, `nuxt generate`) never see crawler requests; use SSR, or report from
  the CDN / edge.
- Behind a proxy the client IP comes from `X-Forwarded-For` (first hop). Only trust it when your proxy sets it.
- JSON-LD goes into the page with `serializeJsonLd`, which escapes `<` so CMS content can't close the script tag.
  The `data-geo-jsonld` attribute lets the setup check tell GEO's script from the host site's own.
