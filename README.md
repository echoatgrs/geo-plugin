# Headless GEO

Make headless sites visible to AI, and see in your CMS which AI crawlers read which pages.

It does three things:

1. **AI crawler logs.** It records visits from GPTBot, ClaudeBot,
PerplexityBot, ChatGPT-User and others, checks their IPs against the vendors' published ranges,
and separates three kinds of visits (table below).
2. **llms.txt and llms-full.txt**, generated from your published CMS content.
3. **An AI visibility dashboard** inside the Payload or Strapi admin: visits per platform, live user fetches,
   content coverage, and the list of pages no AI has crawled.

Visits fall into three kinds:

| Purpose | Bots | What it tells you |
| --- | --- | --- |
| `training` | GPTBot, ClaudeBot, CCBot, Bytespider... | Your content was collected for model training |
| `search` | OAI-SearchBot, Claude-SearchBot, PerplexityBot... | Your content is indexed by an AI search product |
| `user` | ChatGPT-User, Claude-User, Perplexity-User... | A real person asked an AI a question and it opened your page |

## Packages

| Package | What it is |
| --- | --- |
| [`@garus-ltd/geo-core`](packages/geo-core) | CMS-agnostic: bot list, IP verification, ingest, llms.txt builder, rich text to Markdown, stats |
| [`@garus-ltd/geo-dashboard`](packages/geo-dashboard) | Shared React dashboard, rendered by both CMS adapters |
| [`@garus-ltd/geo-next`](packages/geo-next) | Frontend SDK: proxy that reports AI crawler requests, and a route that serves llms.txt on your domain |
| [`payload-plugin-geo`](packages/payload-plugin-geo) | Payload 3 adapter: hits collection, ingest / stats / llms endpoints, dashboard on admin home and hits list |
| [`strapi-plugin-geo`](packages/strapi-plugin-geo) | Strapi 5 adapter: hits content type, ingest / stats / llms routes, "AI Visibility" admin page |

A headless CMS never sees the requests to your frontend, so the frontend reports them:

```
AI crawler ──▶ Next.js proxy (@garus-ltd/geo-next) ──waitUntil──▶ CMS /api/geo/ingest ──▶ your database
                 detects bot, does not block the page            re-checks UA, verifies IP
```

## Payload

```ts
// payload.config.ts
import { geoPlugin } from 'payload-plugin-geo'

export default buildConfig({
  plugins: [
    geoPlugin({
      secret: process.env.GEO_SECRET,
      llms: {
        siteURL: 'https://example.com',
        name: 'Acme',
        description: 'What Acme does, in one sentence.',
        collections: {
          posts: { section: 'Blog', url: (doc) => `/blog/${doc.slug}` },
          pages: { section: 'Pages', url: (doc) => `/${doc.slug}` },
        },
      },
    }),
  ],
})
```

The dashboard appears on the admin home (compact) and above the **GEO > AI Crawler Hits** list (full).
Run `payload generate:importmap` after installing so Payload finds the admin component.

```ts
// proxy.ts (Next 16) or middleware.ts (Next 15), in the same app
import { withGeo } from '@garus-ltd/geo-next'

export const proxy = withGeo({ endpoint: '/api/geo/ingest', secret: process.env.GEO_SECRET })
```

## Strapi

```js
// config/plugins.js
module.exports = ({ env }) => ({
  geo: {
    enabled: true,
    config: {
      secret: env('GEO_SECRET'),
      llms: {
        siteURL: 'https://example.com',
        name: 'Acme',
        contentTypes: {
          'api::article.article': { section: 'Blog', url: (doc) => `/blog/${doc.slug}` },
        },
      },
    },
  },
})
```

The dashboard is under **AI Visibility** in the admin menu.

```ts
// In your Next.js frontend: proxy.ts or middleware.ts
import { withGeo } from '@garus-ltd/geo-next'

export const proxy = withGeo({
  endpoint: 'https://cms.example.com/api/geo/ingest',
  secret: process.env.GEO_SECRET,
})
```

## llms.txt on your domain

The CMS serves `/api/geo/llms.txt` and `/api/geo/llms-full.txt`. Assistants look for `/llms.txt` on your site,
so add a route in the frontend:

```ts
// app/llms.txt/route.ts (and the same for app/llms-full.txt/route.ts)
import { llmsRoute } from '@garus-ltd/geo-next'

export const GET = llmsRoute({ source: `${process.env.CMS_URL}/api/geo/llms.txt` })
```

Only published, publicly readable content is listed. Each entry needs a URL: pass `url(doc)`, or documents
with a `slug` default to `/<collection>/<slug>`. Rich text (Payload Lexical, Strapi Blocks, or Markdown) is
converted to Markdown for llms-full.txt. Title, description and content fields are auto-detected
(`title`, `description` / `excerpt` / `summary`, `content` / `body`) and can be set with
`titleField`, `descriptionField` and `contentField`.

Already have middleware? Wrap it: `withGeo(options, yourMiddleware)`.
`@garus-ltd/geo-next` only uses Fetch APIs, so `trackAICrawler(request, ctx, options)` also works in a Cloudflare Worker.

## IP verification

Each hit is stored with `verification`:

- `verified`: IP is inside the vendor's published list (OpenAI, Perplexity)
- `spoofed`: vendor publishes a list and the IP is not in it, so the User-Agent is fake
- `unverifiable`: no published list (e.g. Anthropic), the list could not be fetched, or no IP

Lists are fetched by the CMS, cached for 24 hours, and a stale list is kept if a refresh fails.
Add your own ranges with `verifyIPs: { staticRanges: { claudebot: ['x.x.x.x/24'] } }` (Payload).

## Development

```sh
npm install
npm run build   # core first, then the rest
npm test
npm run typecheck
```

## Roadmap

1. ~~AI crawler logs~~
2. ~~`llms.txt`, `llms-full.txt`~~, Markdown version of each page (`/xxx.md`)
3. JSON-LD from config presets (Article, FAQ)
4. ~~Admin dashboard~~, per-document sidebar in the editor

## License

MIT

## Releasing

1. Bump `version` in each `packages/*/package.json` (and the internal `@garus-ltd/*` dependency versions).
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The Release workflow builds, tests and publishes every package not yet on npm. It needs an `NPM_TOKEN` repository secret.
