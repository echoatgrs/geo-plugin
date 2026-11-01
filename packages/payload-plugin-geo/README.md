# payload-plugin-geo

[Headless GEO](https://github.com/echoatgrs/geo-plugin) for Payload 3: see which AI crawlers read your site, serve llms.txt, per-page Markdown and JSON-LD, and get an AI visibility dashboard in the admin.

```sh
npm install payload-plugin-geo @garus-ltd/geo-next
```

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
        collections: { posts: { section: 'Blog', url: (doc) => `/blog/${doc.slug}` } },
      },
    }),
  ],
})
```

```ts
// middleware.ts (Next 15) or proxy.ts (Next 16), in the same app
import { withGeo } from '@garus-ltd/geo-next'

export const middleware = withGeo({ endpoint: '/api/geo/ingest', secret: process.env.GEO_SECRET })
```

Then run `payload generate:importmap`. Full docs: https://github.com/echoatgrs/geo-plugin
