# @headless-geo/next

Frontend SDK for [Headless GEO](https://github.com/echoatgrs/geo-plugin). Your CMS never sees requests to your frontend, so this reports AI crawler visits (GPTBot, ClaudeBot, ChatGPT-User...) to it, and serves your CMS-generated llms.txt on your own domain.

```ts
// proxy.ts (Next 16) or middleware.ts (Next 15)
import { withGeo } from '@headless-geo/next'

export const proxy = withGeo({ endpoint: process.env.GEO_INGEST_URL!, secret: process.env.GEO_SECRET })
```

```ts
// app/llms.txt/route.ts
import { llmsRoute } from '@headless-geo/next'

export const GET = llmsRoute({ source: `${process.env.CMS_URL}/api/geo/llms.txt` })
```

Uses only Fetch APIs, so `trackAICrawler(request, ctx, options)` also works in Cloudflare Workers.
