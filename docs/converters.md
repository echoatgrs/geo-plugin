# Complex content: blocks, components and rich text

Markdown (`/x.md`, `Accept: text/markdown`), llms-full.txt and the editor preview all use one converter, so they
always agree. It reads:

| CMS | Content |
| --- | --- |
| Payload | Lexical rich text (paragraphs, headings, lists, quotes, code, links, tables, uploads, relationships, internal links), Lexical `block` / `inlineBlock` nodes, `blocks` fields |
| Strapi | Blocks rich text, Markdown strings, components, repeatable components, dynamic zones |

## Built-in block converters

Payload website template: `content`, `mediaBlock`, `banner`, `code`, `cta`, `archive` (left out: it's a query, not
content), `formBlock` (left out). Strapi blog template: `shared.rich-text`, `shared.quote`, `shared.media`,
`shared.slider`, `shared.seo` (left out). Generic: containers with `columns` / `items` / `blocks`, `faq`, `table`,
`quote`, `slider`.

Anything else is left out and reported in the editor panel (GEO-CONVERSION) with its type and field path. Nothing
is guessed: an unknown block never becomes "best effort" text.

## Your own converters

```ts
import type { ContentConverterOptions } from '@garus-ltd/geo-core'
import { markdownTable } from '@garus-ltd/geo-core'

export const converters: ContentConverterOptions = {
  blocks: {
    // Payload blockType or Strapi component UID (`acme.pricing-table`) or just its name (`pricing-table`).
    pricingTable(block, ctx) {
      if (!block.plans?.length) return null
      return markdownTable(['Plan', 'Price'], block.plans.map((p) => [p.name, p.price]))
    },
    secretWidget: false, // leave out quietly
  },
  nodes: {
    // A custom Lexical / Blocks node type.
    mention: (node) => `@${node.handle}`,
  },
  unknown: 'warn', // or 'skip'
}
```

Pass it as `llms.converters` (all sources) or per source as `converters` (merged over the global ones). Converters
are validated at startup (names must be strings, values functions or `false`).

`ctx` gives you `convert(value, path)` for nested content, `inline(children, path)` for rich text children,
`relation(value, path)` for populated relations (null when it is only an id, not public, or a cycle),
`linkFor(doc)` for the public URL of a related document, `media(value, path)` for absolute media URLs, and
`warn(code, message)`.

## Safety

- Converters get only the document as the public routes loaded it. Payload reads with `overrideAccess: false`,
  Strapi with the Public role and its output sanitizer, so private relations and fields are never there.
- Converters have no database access. A converter that throws leaves out its block and reports
  `converter-error` with the message (no stack).
- Limits stop runaway content: depth 16, 20 000 nodes, 1 MB of Markdown, 200 relations per document (`limits`).
  Hitting one reports `depth-limit` / `node-limit` / `output-limit` and marks the output truncated.
- Relation cycles (A → B → A) are cut and reported as `cycle`.

## Strapi populate

Strapi needs `populate` to return components and relations. The plugin builds it from the schema: media,
components and dynamic zones up to `populateDepth` (default 5), relations one level, never admin users,
`users-permissions` users or other plugin types. Override per content type with `populate`.
