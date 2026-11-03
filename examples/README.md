# Examples

| Example | What it shows |
| --- | --- |
| [astro-ssr](astro-ssr) | Astro 7.4.1 SSR (Node adapter): crawler reports, llms files and parts, Markdown, JSON-LD in the page, cache notice receiver |
| [nuxt](nuxt) | Nuxt 4.6.2: the same through a Nitro server middleware, JSON-LD with `useHead` |
| [node-http](node-http) | Plain `node:http` server with no framework |
| [extension](extension) | A GEO extension outside the plugin packages, using only public exports (bots, rule, converter, field resolver, JSON-LD, change listener) |

The examples depend on the published `@garus-ltd/geo-next`; they are not part of the npm workspaces. Each needs a
running Payload or Strapi with the GEO plugin (`CMS_URL`). See [docs/frameworks.md](../docs/frameworks.md).
