# Discovery and large sites

## Single files (default)

`/llms.txt` lists every public entry of each source (up to `limit`, default 500 per source), grouped by section.
Entries are read 100 per query, never the whole collection at once. When `limit` cuts a source, its section says
so ("Lists 500 of 1 234 entries …"), so a reader knows the list is partial.

Per source:

| Option | Effect |
| --- | --- |
| `section` | Heading the entries are listed under |
| `group(doc)` | Section per entry instead of one per source (e.g. by category) |
| `featured` | A boolean field name or `(doc) => boolean`: listed first in its section (and in the segment index) |
| `optional` | `true`, a field name or a function: listed under `## Optional` (llmstxt.org: may be skipped for short contexts) |
| `include(doc)` | Leave entries out of the lists only. Their Markdown and JSON-LD stay available |
| `where` (Payload) / `filters` (Strapi) | Leave entries out everywhere |
| `sort` | List order. Default newest update first; `id` is always added last so equal dates keep a stable order |
| `limit` | Max entries in the single files |

`llms-full.txt` stops at `fullMaxBytes` (default 5 MB) and says how many documents were left out.

## Segments (`segments: { enabled: true }`)

For large sites `/llms.txt` becomes an index that links to parts:

```
# Acme

This site is large, so this llms.txt links to parts. Generated 2026-11-03T10:00:00.000Z.
Parts are this site’s own organization; llmstxt.org does not define them.

## Featured
- [Pricing](https://example.com/pricing): …

## Blog
- [Blog, part 1 (entries 1–500)](https://example.com/llms/posts-1.txt)
- [Blog, part 2 (entries 501–1203)](https://example.com/llms/posts-2.txt)
```

`/llms-full.txt` becomes the same index of `…-<n>-full.txt` parts (`fullSize` documents each, default 50, each
part capped at `maxBytes`, default 2 MB).

| Option | Default |
| --- | --- |
| `size` | 500 entries per llms.txt part (at most 5000) |
| `fullSize` | 50 documents per llms-full part |
| `maxBytes` | 2 MB per llms-full part |
| `baseURL` | `<siteURL>/llms`: where the frontend serves the parts |

CMS routes: Payload `GET /api/geo/llms/:file`, Strapi `GET /api/geo/llms/:file`. Frontend: `llmsSegmentRoute`
(Next.js `app/llms/[file]/route.ts`) or `geoFetchHandler({ llms: { segments } })`. Only names like
`posts-2.txt` / `posts-2-full.txt` are accepted; anything else is a 404 without a CMS request.

### Consistency

Each source is read in a stable order (oldest first, then id). Part n holds entries `(n-1)·size + 1 … n·size`.
Edits don't move entries between parts; a new publish lands in the last part; an unpublish or delete moves later
entries back by one. Every part says when it was generated, so a reader that needs one snapshot should fetch the
parts within the cache lifetime (`cacheMaxAge`). The counts in the index are taken before per-entry checks
(Strapi `isPublic`, `include`), so a part can hold fewer entries than its range says, never more, and never an
entry the public can't read.

Segments are this plugin's own convention. llmstxt.org defines one file; there is no evidence that assistants
follow the part links, and nothing here promises indexing or citation.
