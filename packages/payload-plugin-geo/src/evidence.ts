import {
  AI_REFERRERS,
  CITATION_PLATFORMS,
  GEO_SECRET_HEADER,
  ReferralLimiter,
  citationKey,
  ingestReferrals,
  summarizeCitations,
  summarizeReferrals,
  windowStart,
  type CitationMonitorProvider,
  type CitationStatus,
  type ProbeRegistry,
  type ReferralEvent,
  type ReferrerRule,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Endpoint, PayloadRequest } from 'payload'
import { ValidationError } from 'payload'

export const AI_REFERRALS_SLUG = 'geo-ai-referrals'
export const CITATIONS_SLUG = 'geo-citations'
export const CITATION_SCREENSHOTS_SLUG = 'geo-citation-screenshots'

export interface ReferralOptions {
  /** Accept AI referral reports from the frontend proxy. Default false. Requires `secret`. */
  enabled?: boolean
  /** Referrer rules. Default: the built-in AI assistant list. */
  rules?: readonly ReferrerRule[]
  /** Store external referrals that match no rule as `unknown` (host only). Default false. */
  recordUnknown?: boolean
  /** Customize the generated collection. */
  collection?: Partial<CollectionConfig>
}

export interface CitationOptions {
  /** Add the citation evidence collection for entering evidence by hand. Default false. */
  enabled?: boolean
  /** Private screenshot uploads (readable by logged-in users only). Default true. */
  screenshots?: boolean
  /** Future automatic monitoring through an authorised API. None is built in. */
  providers?: CitationMonitorProvider[]
  collection?: Partial<CollectionConfig>
}

const loggedIn = ({ req }: { req: PayloadRequest }) => Boolean(req.user)
const noStore = { 'cache-control': 'private, no-store' }

function httpURL(value: unknown): true | string {
  if (value == null || value === '') return true
  try {
    const u = new URL(String(value))
    return u.protocol === 'http:' || u.protocol === 'https:' ? true : 'Must be an http(s) URL.'
  } catch {
    return 'Must be a full URL, e.g. https://example.com/page.'
  }
}

export function referralsCollection(overrides: Partial<CollectionConfig> = {}): CollectionConfig {
  return {
    slug: AI_REFERRALS_SLUG,
    labels: { singular: 'AI Referral Visit', plural: 'AI Referral Visits' },
    admin: {
      group: 'GEO',
      useAsTitle: 'path',
      defaultColumns: ['timestamp', 'platform', 'source', 'path', 'referrerHost'],
      description:
        'Browser visits whose Referer is a known AI assistant, reported by the @garus-ltd/geo-next proxy. Traffic evidence, not proof of every citation; the Referer can be forged. Only host and landing path are stored.',
    },
    access: { read: loggedIn, create: () => false, update: () => false, delete: loggedIn },
    timestamps: false,
    fields: [
      { name: 'timestamp', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'platform', type: 'text', required: true, index: true },
      {
        name: 'source',
        type: 'select',
        required: true,
        options: [
          { label: 'Referer header', value: 'referrer' },
          { label: 'utm_source only', value: 'utm' },
        ],
      },
      { name: 'referrerHost', type: 'text' },
      { name: 'path', type: 'text', required: true, index: true },
      { name: 'host', type: 'text' },
    ],
    ...overrides,
  }
}

export function citationScreenshotsCollection(): CollectionConfig {
  return {
    slug: CITATION_SCREENSHOTS_SLUG,
    labels: { singular: 'Citation Screenshot', plural: 'Citation Screenshots' },
    admin: { group: 'GEO', hidden: true },
    // Files are served through Payload's access-checked file route, so logged-in users only.
    access: { read: loggedIn, create: loggedIn, update: loggedIn, delete: loggedIn },
    upload: { mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], staticDir: CITATION_SCREENSHOTS_SLUG },
    fields: [],
  }
}

export function citationsCollection(options: { usersSlug: string; screenshots: boolean; overrides?: Partial<CollectionConfig> }): CollectionConfig {
  return {
    slug: CITATIONS_SLUG,
    labels: { singular: 'Citation Evidence', plural: 'Citation Evidence' },
    admin: {
      group: 'GEO',
      useAsTitle: 'question',
      defaultColumns: ['observedAt', 'platform', 'question', 'citedURL', 'status'],
      description:
        'Answers in which you saw a link to this site, recorded by hand. “Verified” means someone on your team checked the record, not that the platform confirmed it. This is not automatic citation monitoring.',
    },
    access: { read: loggedIn, create: loggedIn, update: loggedIn, delete: loggedIn },
    // Edit history: every change is kept as a version.
    versions: { maxPerDoc: 50 },
    fields: [
      { name: 'platform', type: 'select', required: true, options: CITATION_PLATFORMS.map((p) => ({ label: p, value: p })) },
      { name: 'question', type: 'textarea', required: true, admin: { description: 'The question asked in the test.' } },
      { name: 'observedAt', label: 'Observed at', type: 'date', required: true, defaultValue: () => new Date().toISOString(), admin: { date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'citedURL', label: 'Cited URL', type: 'text', required: true, validate: httpURL, admin: { description: 'The page of this site that the answer linked to.' } },
      {
        name: 'answerId',
        label: 'Answer ID',
        type: 'text',
        admin: { description: 'Share link id or another stable answer id. Used with platform and URL to catch duplicates; without it, duplicates are up to you.' },
      },
      { name: 'answerURL', label: 'Answer URL', type: 'text', validate: httpURL, admin: { description: 'Share link of the answer, if any. Not shown publicly.' } },
      ...(options.screenshots ? [{ name: 'screenshot', type: 'upload' as const, relationTo: CITATION_SCREENSHOTS_SLUG }] : []),
      {
        type: 'row',
        fields: [
          { name: 'language', type: 'text', admin: { width: '33%' } },
          { name: 'region', type: 'text', admin: { width: '33%' } },
          { name: 'conditions', type: 'text', admin: { width: '34%', description: 'Logged in, model, search on, …' } },
        ],
      },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'pending',
        options: [
          { label: 'Pending review', value: 'pending' },
          { label: 'Verified by a person', value: 'verified' },
          { label: 'Invalid / no longer cited', value: 'invalid' },
        ],
        admin: { position: 'sidebar' },
      },
      {
        name: 'recordedBy',
        label: 'Recorded by',
        type: 'relationship',
        relationTo: options.usersSlug,
        admin: { position: 'sidebar', readOnly: true },
        access: { update: () => false },
      },
      { name: 'notes', type: 'textarea' },
      { name: 'dedupeKey', type: 'text', index: true, admin: { hidden: true }, access: { update: () => false, create: () => false } },
    ],
    hooks: {
      beforeChange: [
        async ({ data, req, operation, originalDoc }) => {
          const merged = { ...originalDoc, ...data }
          if (operation === 'create' && req.user) data.recordedBy = req.user.id
          const key = citationKey({ platform: merged.platform, answerId: merged.answerId, citedURL: merged.citedURL })
          data.dedupeKey = key
          if (key) {
            const existing = await req.payload.find({
              collection: CITATIONS_SLUG as never,
              where: { and: [{ dedupeKey: { equals: key } }, ...(originalDoc?.id != null ? [{ id: { not_equals: originalDoc.id } }] : [])] },
              limit: 1,
              depth: 0,
              overrideAccess: true,
              req,
            })
            if (existing.docs.length) {
              throw new ValidationError({
                collection: CITATIONS_SLUG,
                errors: [{ path: 'answerId', message: 'Already recorded: same platform, answer id and cited URL.' }],
              })
            }
          }
          return data
        },
      ],
    },
    ...options.overrides,
  }
}

export interface EvidenceContext {
  referrals?: ReferralOptions
  citations?: CitationOptions
  secret?: string
  probes: ProbeRegistry
  adminRoute: string
}

const MAX_REFERRALS = 100_000

export function evidenceEndpoints(ctx: EvidenceContext): Endpoint[] {
  const limiter = new ReferralLimiter()
  const referralsOn = ctx.referrals?.enabled === true
  const citationsOn = ctx.citations?.enabled === true
  return [
    {
      path: '/geo/referrals',
      method: 'post',
      handler: async (req) => {
        let body: unknown
        try {
          body = await req.json?.()
        } catch {
          return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
        }
        if (!referralsOn) {
          for (const item of Array.isArray(body) ? body.slice(0, 50) : [body]) {
            const token = ctx.probes.match((item as { userAgent?: string })?.userAgent)
            if (token) ctx.probes.record(token, 'disabled')
          }
          return Response.json({ ok: false, error: 'disabled' }, { status: 503 })
        }
        const result = await ingestReferrals(body, req.headers.get(GEO_SECRET_HEADER), {
          secret: ctx.secret,
          rules: ctx.referrals?.rules ?? AI_REFERRERS,
          recordUnknown: ctx.referrals?.recordUnknown,
          limiter,
          probes: ctx.probes,
          store: {
            async save(event: ReferralEvent) {
              await req.payload.create({ collection: AI_REFERRALS_SLUG as never, data: event as never, overrideAccess: true, req })
            },
          },
        })
        return Response.json(result.body, { status: result.status })
      },
    },
    {
      path: '/geo/evidence',
      method: 'get',
      handler: async (req) => {
        if (!req.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore })
        const days = Math.min(Number(new URL(req.url ?? '', 'http://x').searchParams.get('days') ?? 30) || 30, 365)
        let referrals = null
        if (referralsOn) {
          const rows = await req.payload.find({
            collection: AI_REFERRALS_SLUG as never,
            where: { timestamp: { greater_than_equal: windowStart(days).toISOString() } },
            limit: MAX_REFERRALS,
            pagination: false,
            depth: 0,
            select: { timestamp: true, platform: true, source: true, path: true } as never,
            overrideAccess: true,
          })
          referrals = summarizeReferrals(rows.docs as unknown as ReferralEvent[], { days })
        }
        let citations = null
        if (citationsOn) {
          const rows = await req.payload.find({
            collection: CITATIONS_SLUG as never,
            limit: MAX_REFERRALS,
            pagination: false,
            depth: 0,
            select: { platform: true, status: true } as never,
            overrideAccess: false,
            user: req.user,
            req,
          })
          citations = summarizeCitations(rows.docs as unknown as Array<{ platform: string; status: CitationStatus }>, (ctx.citations?.providers ?? []).map((p) => p.name))
        }
        const admin = ctx.adminRoute
        return Response.json(
          {
            referrals,
            citations,
            referralsHref: referralsOn ? `${admin}/collections/${AI_REFERRALS_SLUG}` : undefined,
            citationsHref: citationsOn ? `${admin}/collections/${CITATIONS_SLUG}` : undefined,
            newCitationHref: citationsOn ? `${admin}/collections/${CITATIONS_SLUG}/create` : undefined,
          },
          { headers: noStore },
        )
      },
    },
  ]
}
