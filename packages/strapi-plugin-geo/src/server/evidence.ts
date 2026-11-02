import {
  AI_REFERRERS,
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
import type { KoaContextLike, StrapiLike } from './types'

export const AI_REFERRAL_UID = 'plugin::geo.ai-referral'
export const CITATION_UID = 'plugin::geo.citation'
const MAX_ROWS = 100_000
const HISTORY_LIMIT = 100

export interface StrapiReferralConfig {
  /** Accept AI referral reports from the frontend proxy. Default false. Requires `secret`. */
  enabled?: boolean
  rules?: readonly ReferrerRule[]
  /** Store external referrals that match no rule as `unknown` (host only). Default false. */
  recordUnknown?: boolean
}

export interface StrapiCitationConfig {
  /** Show citation evidence counts in the dashboard. Default false. */
  enabled?: boolean
  /** Future automatic monitoring through an authorised API. None is built in. */
  providers?: CitationMonitorProvider[]
}

const limiter = new ReferralLimiter()

export async function ingestReferralReport(
  strapi: StrapiLike,
  ctx: KoaContextLike,
  cfg: { secret: string; referrals?: StrapiReferralConfig },
  probes: ProbeRegistry,
) {
  const body = ctx.request.body
  if (cfg.referrals?.enabled !== true) {
    for (const item of Array.isArray(body) ? body.slice(0, 50) : [body]) {
      const token = probes.match((item as { userAgent?: string })?.userAgent)
      if (token) probes.record(token, 'disabled')
    }
    ctx.status = 503
    ctx.body = { ok: false, error: 'disabled' }
    return
  }
  const result = await ingestReferrals(body, ctx.request.get(GEO_SECRET_HEADER) || null, {
    secret: cfg.secret || undefined,
    rules: cfg.referrals.rules ?? AI_REFERRERS,
    recordUnknown: cfg.referrals.recordUnknown,
    limiter,
    probes,
    store: {
      async save(event: ReferralEvent) {
        await strapi.documents(AI_REFERRAL_UID).create({ data: { ...event } })
      },
    },
  })
  ctx.status = result.status
  ctx.body = result.body
}

/** Admin only: AI referral visits and recorded citation evidence, kept apart. */
export async function evidenceReport(
  strapi: StrapiLike,
  ctx: KoaContextLike,
  cfg: { referrals?: StrapiReferralConfig; citations?: StrapiCitationConfig },
  adminPath: string,
) {
  ctx.set?.('Cache-Control', 'private, no-store')
  const days = Math.min(Number(ctx.query?.days ?? 30) || 30, 365)
  const can = (uid: string) => ctx.state?.userAbility?.can('plugin::content-manager.explorer.read', uid) ?? false
  let referrals = null
  const referralsOn = cfg.referrals?.enabled === true
  if (referralsOn) {
    const rows = await strapi.documents(AI_REFERRAL_UID).findMany({
      filters: { timestamp: { $gte: windowStart(days).toISOString() } },
      fields: ['timestamp', 'platform', 'source', 'path'],
      limit: MAX_ROWS,
    })
    referrals = summarizeReferrals(rows as unknown as ReferralEvent[], { days })
  }
  let citations = null
  const citationsOn = cfg.citations?.enabled === true && can(CITATION_UID)
  if (citationsOn) {
    const rows = await strapi.documents(CITATION_UID).findMany({ fields: ['platform', 'reviewStatus'], limit: MAX_ROWS })
    citations = summarizeCitations(
      rows.map((r) => ({ platform: String(r.platform).replace(/_/g, ' '), status: (r.reviewStatus ?? 'pending') as CitationStatus })),
      (cfg.citations?.providers ?? []).map((p) => p.name),
    )
  }
  const list = (uid: string) => `${adminPath}/content-manager/collection-types/${uid}`
  ctx.status = 200
  ctx.body = {
    referrals,
    citations,
    referralsHref: referralsOn && can(AI_REFERRAL_UID) ? list(AI_REFERRAL_UID) : undefined,
    citationsHref: citationsOn ? list(CITATION_UID) : undefined,
    newCitationHref: citationsOn ? `${list(CITATION_UID)}/create` : undefined,
  }
}

function httpURL(value: unknown): boolean {
  if (value == null || value === '') return true
  try {
    const u = new URL(String(value))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

interface DocumentMiddlewareContext {
  uid: string
  action: string
  params: { data?: Record<string, any>; documentId?: string }
}

/** Strapi's own ValidationError, so the content manager shows the message instead of a 500. */
function validationError(message: string, path: string): Error {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { errors } = require('@strapi/utils') as { errors: { ValidationError: new (m: string, d?: unknown) => Error } }
    return new errors.ValidationError(message, { errors: [{ path: [path], message, name: 'ValidationError' }] })
  } catch {
    return Object.assign(new Error(message), { name: 'ValidationError', status: 400 })
  }
}

/**
 * Document Service middleware for citation evidence: URL checks, duplicate check on platform + answer id +
 * cited URL, and an edit history the client can't rewrite.
 */
export function citationMiddleware(strapi: StrapiLike & { requestContext?: { get(): any } }) {
  return async (context: DocumentMiddlewareContext, next: () => Promise<unknown>) => {
    if (context.uid !== CITATION_UID || (context.action !== 'create' && context.action !== 'update')) return next()
    const data = context.params.data ?? (context.params.data = {})
    const existing = context.action === 'update' && context.params.documentId
      ? await strapi.documents(CITATION_UID).findOne?.({ documentId: context.params.documentId })
      : null
    const merged = { ...existing, ...data }
    for (const field of ['citedURL', 'answerURL'] as const) {
      if (!httpURL(merged[field])) throw validationError(`${field} must be a full http(s) URL.`, field)
    }
    const key = citationKey({ platform: merged.platform, answerId: merged.answerId, citedURL: merged.citedURL })
    data.dedupeKey = key
    if (key) {
      const dupes = await strapi.documents(CITATION_UID).findMany({
        filters: { dedupeKey: key, ...(context.params.documentId ? { documentId: { $ne: context.params.documentId } } : {}) },
        fields: ['id'],
        limit: 1,
      })
      if (dupes.length) throw validationError('Already recorded: same platform, answer id and cited URL.', 'answerId')
    }
    const user = strapi.requestContext?.get()?.state?.user
    const by = user ? [user.firstname, user.lastname].filter(Boolean).join(' ') || user.email || `user ${user.id}` : 'system'
    const internal = new Set(['history', 'dedupeKey', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'publishedAt', 'locale', 'id', 'documentId'])
    const changed = Object.keys(data).filter((k) => !internal.has(k) && (!existing || JSON.stringify(existing[k]) !== JSON.stringify(data[k])))
    const history = Array.isArray(existing?.history) ? existing!.history : []
    data.history = [...history, { at: new Date().toISOString(), by, action: context.action, fields: changed }].slice(-HISTORY_LIMIT)
    return next()
  }
}
