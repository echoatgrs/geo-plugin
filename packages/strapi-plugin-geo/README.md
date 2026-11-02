# strapi-plugin-geo

[Headless GEO](https://github.com/echoatgrs/geo-plugin) for Strapi 5: see which AI crawlers read your frontend, serve llms.txt, per-page Markdown and JSON-LD from your content, and get an "AI Visibility" page in the admin.

```sh
npm install strapi-plugin-geo
```

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
        contentTypes: { 'api::article.article': { section: 'Blog', url: (doc) => `/blog/${doc.slug}` } },
      },
    },
  },
})
```

llms.txt, Markdown and JSON-LD only include content types the **Public** role can read (`find` or `findOne` under
Settings → Users & Permissions → Roles → Public), so they never expose what the REST API would refuse. If your
frontend reads Strapi with an API token instead, set `llms.publicOnly: false`.

Strapi can't see requests to your frontend, so add [`@garus-ltd/geo-next`](https://www.npmjs.com/package/@garus-ltd/geo-next) there:

```ts
import { withGeo } from '@garus-ltd/geo-next'

export const proxy = withGeo({ endpoint: 'https://cms.example.com/api/geo/ingest', secret: process.env.GEO_SECRET })
```

Full docs: https://github.com/echoatgrs/geo-plugin
