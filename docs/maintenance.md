# Local data: retention, cleanup and export

The plugins store crawler hits, AI referral visits (when enabled) and cache notice records (when invalidation is
on). Nothing is ever deleted unless you allow it.

```ts
retention: {
  hitsDays: 90,            // unset: keep forever
  referralsDays: 180,
  invalidationsDays: 30,
  allowDelete: false,      // default: preview only
  autoCleanup: false,      // daily cleanup by the days above; needs allowDelete
  batchSize: 500,          // rows per delete query, at most 5000
}
```

**Back up the database before turning on `allowDelete`.** The plugin cannot restore deleted rows.

## Cleanup

Dashboard → **Data**: each dataset shows its row count, oldest row, retention and how many rows are past it.
"Preview" counts what a cleanup would delete; "Delete N rows" appears only when `allowDelete` is on.

API (admins only, `private, no-store`):

- `POST /api/geo/data/cleanup` (Payload) / `POST /geo/data/cleanup` (Strapi admin API)
  `{ "dataset": "hits", "before": "2026-08-01T00:00:00Z", "confirm": false }`
  `confirm: false` (or missing) is a preview. `before` defaults to the retention cutoff and must be at least a day
  in the past.

A cleanup deletes in batches (oldest first), holds a per-dataset lock in the process and refuses to start while
another cleanup of the same dataset is running (job record younger than an hour). Every cleanup and export is
recorded as a job (Payload `geo-jobs`, Strapi "GEO Data Job"): who, when, cutoff, rows deleted, status, error.

Stats over a range that starts before the last cleanup show "History is incomplete" (`historyIncomplete`,
`deletedBefore` in the stats response), so a drop in visits isn't mistaken for a drop in crawling.

## Export

`GET /api/geo/data/export?dataset=hits&format=csv&from=2026-10-01&to=2026-11-01` (Payload; Strapi:
`/geo/data/export` on the admin API).

- `format`: `csv` (UTF-8 with BOM, CRLF) or `json` (one array).
- Streamed 1000 rows at a time, oldest first, so memory stays flat.
- Sensitive fields are left out by default: IPs, user agents, referrers (hits) and raw event bodies (cache
  notices). Add `sensitive=1` to include them, or pick `fields=timestamp,path,…`.
- CSV cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab, CR) get a leading
  `'`.
- Admins only; `Content-Disposition: attachment`, `private, no-store`.

## Indexes

Payload: `timestamp`, `botId`, `platform`, `purpose`, `path` on hits; `eventId` and `status` on cache notices;
`dataset`, `status`, `startedAt` on jobs. Strapi content types don't declare indexes; for large tables add one on
`geo_crawler_hits.timestamp` (and `geo_ai_referrals.timestamp`) in a migration, e.g.
`CREATE INDEX geo_crawler_hits_timestamp ON geo_crawler_hits (timestamp);`.
