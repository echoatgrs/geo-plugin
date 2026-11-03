# Configuration reference (new options)

Options added by the expansion release. Payload: `geoPlugin({ … })`; Strapi: `config/plugins` → `geo.config`.
Existing options are documented in the [README](../README.md).

## Top level

| Option | Type | Default | |
| --- | --- | --- | --- |
| `bots` | `BotDefinition[]` | built-in list | from `defineBots`; use the same list in the frontend |
| `invalidation` | `InvalidationOptions` | off | [cache.md](cache.md) |
| `retention` | `RetentionOptions` | keep forever, no deletes | [maintenance.md](maintenance.md) |

## `llms`

| Option | Default | |
| --- | --- | --- |
| `converters` | built-ins | [converters.md](converters.md) |
| `rules`, `rulesTimeoutMs` | none, 2000 | [extensions.md](extensions.md) |
| `organization` | none | site publisher node with a stable `@id` |
| `hostManaged` | `[]` | JSON-LD types the host renders itself; `?omit=host` leaves them out |
| `segments` | off | `{ enabled, size: 500, fullSize: 50, maxBytes: 2e6, baseURL }`, [segments.md](segments.md) |
| `notFoundMaxAge` | `min(cacheMaxAge, 60)` | cache lifetime of public 404s |
| `fullMaxBytes` | 5 MB | byte cap of the single llms-full.txt |

## Per source (`llms.collections.<slug>` / `llms.contentTypes.<uid>`)

| Option | |
| --- | --- |
| `fields`, `seo`, `contentFields` | field resolution ([extensions.md](extensions.md)) |
| `converters` | merged over `llms.converters` |
| `include`, `group`, `featured`, `optional`, `sort`, `limit` | listing ([segments.md](segments.md)) |
| `jsonLd.type`, `jsonLd.fields`, `jsonLd.priceUnit`, `jsonLd.breadcrumb`, `jsonLd.author`, `jsonLd.extend` | [jsonld-presets.md](jsonld-presets.md) |
| Payload `depth` | relation depth of the anonymous read (default 1) |
| Strapi `populate`, `populateDepth` | default: from the schema, depth 5 |

## Frontend (`@garus-ltd/geo-next`)

| Export | |
| --- | --- |
| `llmsSegmentRoute({ source, maxAge })` | serves `/llms/<part>.txt` |
| `revalidationHandler({ secret, onEvent, toleranceSeconds, maxBodyBytes, seen })` | receives cache notices |
| `geoFetchHandler({ …withGeo options, llms: { source, fullSource, segments, maxAge } })` | Astro, Nuxt, Node, any Fetch framework |
| `fetchJsonLd({ omit })`, `jsonLdScriptTag(data)` | JSON-LD without the host's own types; plain HTML script tag |
