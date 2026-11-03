# Extension APIs

Everything here is a public export of `@garus-ltd/geo-core` (or an option of the CMS plugins). An example package
that uses only these exports lives in [`examples/extension`](../examples/extension) and is tested with the rest
of the repo.

Extensions are your code and run with your CMS's trust. The plugin isolates their failures (a throw, a timeout or
an invalid result becomes a reported error), but it does not sandbox them.

| What | API | Where it is used |
| --- | --- | --- |
| Crawler definitions | `defineBots([...], { base, replace })` | CMS `bots` option and frontend `withGeo({ bots })` / `geoFetchHandler({ bots })` |
| Editor checks | `defineRules([...])` | `llms.rules`, run after the built-in checks (`rulesTimeoutMs`, default 2000 ms) |
| Field resolution | `fields`, `seo`, `contentFields` on a source; `FieldResolver` functions | All public outputs and the editor panel |
| Content converters | `ContentConverterOptions` | Markdown, llms-full.txt, editor preview |
| JSON-LD | `jsonLd.type` (presets), `jsonLd.fields`, `jsonLd.extend(doc)` | JSON-LD endpoint, editor preview |
| Change events | `invalidation.onChange(event)`, signed HTTP targets, `revalidationHandler` | After every public change |

## Bots

```ts
import { defineBots } from '@garus-ltd/geo-core'

export const bots = defineBots([
  { id: 'acme-research', name: 'AcmeResearchBot', platform: 'Acme', purpose: 'search', uaToken: 'AcmeResearchBot',
    ipRanges: ['203.0.113.0/24'] },
])
```

Validation: ids `a-z0-9._-`, purpose `training | search | user`, a user-agent token of at least 4 characters that
is not a generic word (`bot`, `crawler`, `mozilla`, …), not a substring of an existing token, no duplicates. With
`ipRanges` or `verify(ip)`, hits are verified like the built-in bots; `verify` errors and timeouts count as
unverifiable, never verified. Use the same list in the CMS and in the frontend.

## Rules

```ts
import { defineRules } from '@garus-ltd/geo-core'

export const rules = defineRules([
  {
    id: 'ACME-TLDR',
    params: { maxWords: 60 },
    check: ({ markdown, params }) => {
      const first = markdown.split(/\n{2,}/)[0] ?? ''
      return first.split(/\s+/).length <= params.maxWords
        ? { status: 'pass', message: 'Short summary.' }
        : { status: 'warning', message: 'Summary too long.', suggestion: `Keep it under ${params.maxWords} words.` }
    },
  },
])
```

Ids look like `ACME-NO-LOREM`; the `GEO-`, `LD-`, `CFG-`, `ACT-` and `EV-` prefixes and built-in ids are
reserved. A rule gets the current (unsaved) values, the mapped document, the Markdown body, the field sources,
the publish state and an `AbortSignal`. Rules run only in the editor panel, never on public routes.

## Field resolution

Order: explicit `fields.<property>` / `<property>Field` → the `seo` map (e.g. `PAYLOAD_SEO_PLUGIN`) → the
defaults (`title`, `description`, `image`, …). A spec is a path (`meta.title`), a function, or a list tried in
order. The editor panel shows which field each value came from.

## JSON-LD

See [jsonld-presets.md](jsonld-presets.md). `extend(doc)` adds properties to the main node; it must return
facts that are true for the page.

## Change events

```ts
invalidation: {
  targets: [{ name: 'frontend', url: 'https://example.com/api/geo-revalidate', secret: process.env.GEO_REVALIDATE_SECRET }],
  onChange: async (event) => cdn.purge(event.urls), // in-process, optional
}
```

`event`: `{ id, type: publish | update | unpublish | delete | access | config, source, documentId, occurredAt,
paths, urls, tags, previousPath?, path? }`. See [cache.md](cache.md).
