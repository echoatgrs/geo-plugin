# @garus-ltd/geo-next

Frontend SDK for [Headless GEO](https://github.com/echoatgrs/geo-plugin). Your CMS never sees requests to your frontend, so this reports AI crawler visits (GPTBot, ClaudeBot, ChatGPT-User...) to it, and serves your CMS-generated llms.txt and per-page Markdown on your own domain.

```ts
// proxy.ts (Next 16) or middleware.ts (Next 15)
import { withGeo } from '@garus-ltd/geo-next'

export const proxy = withGeo({ endpoint: process.env.GEO_INGEST_URL!, secret: process.env.GEO_SECRET })
```

```ts
// app/llms.txt/route.ts
import { llmsRoute } from '@garus-ltd/geo-next'

export const GET = llmsRoute({ source: `${process.env.CMS_URL}/api/geo/llms.txt` })
```

Per-page Markdown and JSON-LD from the CMS:

```ts
// proxy.ts: serves /blog/post.md and Accept: text/markdown
export const proxy = withGeo({
  endpoint: process.env.GEO_INGEST_URL!,
  markdown: { source: `${process.env.CMS_URL}/api/geo/markdown` },
})
```

```tsx
// in a page
const jsonLd = await fetchJsonLd({ source: `${process.env.CMS_URL}/api/geo/jsonld`, path: `/blog/${slug}` })
return <>{jsonLd && <script {...jsonLdScriptProps(jsonLd)} />}</>
```

Uses only Fetch APIs, so `trackAICrawler(request, ctx, options)` also works in Cloudflare Workers.
