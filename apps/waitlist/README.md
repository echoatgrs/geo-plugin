# Waitlist page

Landing page for the hosted GEO / AI search visibility product built on the open-source plugin.
A standalone Next.js app; it is not part of the npm workspaces and is never published.

```sh
cd apps/waitlist
npm install
npm run dev      # http://localhost:3000
```

- Product name, domain and tagline: `site.config.ts` (placeholders for now).
- Copy: `app/page.tsx`.
- Sign-ups: the form posts to `/api/waitlist`, which forwards JSON
  `{ email, site, cms, role, source, createdAt }` to `WAITLIST_WEBHOOK_URL` (see `.env.example`).
  Without it, `next dev` appends to `.data/waitlist.jsonl` and production answers 503.
