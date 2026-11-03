# Publish, permissions and caches

The plugins cache nothing themselves: llms.txt, Markdown and JSON-LD are built from the CMS on every request, so the
next request after a publish, edit, unpublish, delete or permission change already reflects it. What can still
serve old content are caches outside the plugin: the frontend (Next.js data cache, Nuxt / Nitro storage, your own),
CDNs and browsers.

## Cache headers

| Response | `Cache-Control` |
| --- | --- |
| Public outputs (200) | `public, max-age=<cacheMaxAge>` (default 300; `0` → `no-store`) |
| Public 404 | `public, max-age=<notFoundMaxAge>` (default `cacheMaxAge` capped at 60), so a new publish shows up soon |
| Editor preview, admin routes, exports | `private, no-store` |

## Change notices (`invalidation`)

```ts
invalidation: {
  targets: [{ name: 'frontend', url: 'https://example.com/api/geo-revalidate', secret: process.env.GEO_REVALIDATE_SECRET, events: ['publish', 'update', 'unpublish', 'delete', 'access', 'config'] }],
  timeoutMs: 5000,   // per attempt, at most 30 000
  retries: 2,        // at most 5; backoff 1 s, 4 s, 16 s …
  allowPrivateNetwork: false, // true only for local development
  onChange: (event) => {},   // optional in-process listener
}
```

When anything public changes, the plugin sends a signed `POST` with the event:

| Change | Event |
| --- | --- |
| Draft published, or a new public entry | `publish` |
| Published entry edited (including a URL change: both URLs are in `paths`, with `previousPath` / `path`) | `update` |
| Unpublished | `unpublish` |
| Deleted | `delete` |
| Strapi Public role permission added / removed (one event per burst) | `access` |
| "Notify all targets now" in the dashboard (after a mapping change) | `config` |

A draft saved over a published entry changes nothing public and sends nothing. How it's detected: before and after
each write the plugin reads the entry's public state exactly like the public routes (anonymously), and compares.
Payload: collection hooks. Strapi: a Document Service middleware (create, update, publish, unpublish, discard
draft, delete).

`paths`: the page, its `.md`, the old URL on a rename, `/llms.txt`, `/llms-full.txt` (and `/llms/` with segments).
`urls`: the same, absolute, for CDN purge APIs. `tags`: `geo`, `geo:llms`, `geo:source:<source>`,
`geo:path:<path>` (and `geo:all` for site-wide events).

### Security

- Targets come from the CMS config only, never from a request. http(s) only, no credentials in the URL, secret of
  at least 16 characters, checked at startup.
- Private and loopback addresses are refused unless `allowPrivateNetwork`. Redirects are not followed.
- Signature header `x-geo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`; event id in
  `x-geo-event`. Receivers check the age (default ±5 minutes).
- 400 / 401 / 403 and redirects are not retried; timeouts and 5xx are.
- A notice never blocks or rolls back the save: it is sent in the background after the write.

### Delivery log and retry

Every delivery is recorded (Payload collection `geo-invalidations`, Strapi content type "Cache Notice"):
event, target, status, attempts, last error. The dashboard's **Data** tab lists them and retries a failed one with
the **same event id**, so a receiver that already handled it acknowledges it without acting twice.

## Receiving

```ts
// Next.js: app/api/geo-revalidate/route.ts
import { revalidatePath, revalidateTag } from 'next/cache'
import { revalidationHandler } from '@garus-ltd/geo-next'

export const POST = revalidationHandler({
  secret: process.env.GEO_REVALIDATE_SECRET!,
  onEvent(event) {
    for (const path of event.paths) revalidatePath(path)
    revalidateTag('geo')
  },
})
```

It answers 401 for a bad or old signature, 400 for a malformed event, 200 `{ duplicate: true }` for an event id it
already handled, and 500 when `onEvent` throws (the id is forgotten, so a retry runs it again). The id memory is
per process (`seen` option to share it).

Astro, Nuxt and plain Node receivers are in [frameworks.md](frameworks.md).

## Limits

Without a CDN integration in `onEvent` / `onChange`, a CDN may keep a page for up to its own TTL. Browsers keep
public responses for up to `cacheMaxAge`. Nothing here guarantees an instant purge everywhere.
