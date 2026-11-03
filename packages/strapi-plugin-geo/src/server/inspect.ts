import {
  externalValidators,
  inspectDocument,
  mapLlmsDocument,
  withRules,
  type Inspection,
} from '@garus-ltd/geo-core'
import { publicAccess } from './access'
import { jsonLdSite, mappingOptions, populateOf } from './content'
import type { StrapiLlmsConfig } from './config'
import type { StrapiLike } from './types'

export interface StrapiInspection extends Inspection {
  publicLinks?: { page?: string; markdown?: string; jsonLd?: string }
  validators?: Array<{ name: string; url: string }>
}

type Result = { status: number; body: StrapiInspection | { error: string } }

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

type Attribute = { type?: string; target?: string; relation?: string }

const ids = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .map((item: any) => (item && typeof item === 'object' ? (item.documentId ?? item.id) : item))
    .filter((v) => v != null)
    .map(String)

/**
 * The edit form holds relations as `{ connect, disconnect }` changes against the saved document. Apply them
 * to the saved relation so the preview shows the same names as the public output will after saving.
 */
async function applyRelationChanges(strapi: StrapiLike, uid: string, stored: Record<string, any>, data: Record<string, any>) {
  const attributes = (strapi.contentType?.(uid)?.attributes ?? {}) as Record<string, Attribute>
  const values: Record<string, any> = { ...stored, ...data }
  for (const [name, attr] of Object.entries(attributes)) {
    const change = data[name]
    if (attr.type !== 'relation' || !isRecord(change) || !('connect' in change || 'disconnect' in change)) continue
    const many = /Many$/.test(attr.relation ?? '')
    const current = stored[name] == null ? [] : Array.isArray(stored[name]) ? stored[name] : [stored[name]]
    const removed = new Set(ids(change.disconnect))
    let next = current.filter((item: any) => !removed.has(String(item?.documentId)) && !removed.has(String(item?.id)))
    const added: Record<string, any>[] = []
    for (const id of ids(change.connect)) {
      if (!attr.target) continue
      const doc = await strapi.documents(attr.target).findOne?.({ documentId: id })
      if (doc) added.push(doc)
    }
    next = many ? [...next, ...added] : added.length ? [added.at(-1)!] : next
    values[name] = many ? next : (next[0] ?? null)
  }
  return values
}

function userCanRead(ctx: { state?: { userAbility?: { can(action: string, subject?: string): boolean } } }, uid: string): boolean {
  const ability = ctx.state?.userAbility
  if (!ability) return false
  return ability.can('plugin::content-manager.explorer.read', uid)
}

/**
 * Checks and previews of the entry being edited. Admin only (route policy plus content-manager read
 * permission for the content type), never cached, and only for content types configured in `llms.contentTypes`.
 */
export async function inspectStrapiEntry(
  strapi: StrapiLike,
  llms: StrapiLlmsConfig,
  ctx: { state?: { userAbility?: { can(action: string, subject?: string): boolean } } },
  body: unknown,
): Promise<Result> {
  if (!isRecord(body) || typeof body.model !== 'string') return { status: 400, body: { error: 'invalid body' } }
  const uid = body.model
  const source = Object.prototype.hasOwnProperty.call(llms.contentTypes, uid) ? llms.contentTypes[uid] : undefined
  if (!source) return { status: 404, body: { error: 'content type is not configured for GEO' } }
  if (!userCanRead(ctx, uid)) return { status: 403, body: { error: 'forbidden' } }
  const documentId = typeof body.documentId === 'string' && body.documentId ? body.documentId : null
  const data = isRecord(body.data) ? body.data : {}
  const draftAndPublish = strapi.contentType?.(uid)?.options?.draftAndPublish !== false

  const docs = strapi.documents(uid)
  let stored: Record<string, any> = {}
  if (documentId) {
    stored = (await docs.findOne?.({ documentId, status: 'draft', populate: populateOf(strapi, uid, source) })) ?? {}
    if (!Object.keys(stored).length) return { status: 404, body: { error: 'not found' } }
  }
  const live = documentId && draftAndPublish ? await docs.findOne?.({ documentId, status: 'published', populate: populateOf(strapi, uid, source) }) : documentId ? stored : null
  const version = body.version === 'published' ? 'published' : 'current'
  if (version === 'published' && !live) return { status: 404, body: { error: 'no published version' } }
  const access = await publicAccess(strapi, llms)
  const values =
    version === 'published' ? { ...live } : await applyRelationChanges(strapi, uid, stored, data)
  // The draft version has no publishedAt; the public output uses the published version's date.
  if (version === 'current' && live?.publishedAt && !values.publishedAt) values.publishedAt = live.publishedAt
  // Preview what the public will get: the same sanitizer drops private fields and relations the Public role can't read.
  const previewValues = access.allowed.has(uid) ? await access.sanitize(uid, values) : values

  let published: boolean | null = documentId ? !draftAndPublish : null
  let publicVisible: boolean | null = documentId ? false : null
  let publicReason: string | undefined
  let publicURL: string | null = null
  if (documentId) {
    if (draftAndPublish) published = !!live
    if (!live) publicReason = 'not published'
    else if (!access.allowed.has(uid)) publicReason = 'the Public role can’t read this content type (or its route has policies without `isPublic`)'
    else {
      const visible = await access.filter(uid, source, live)
      if (!visible) publicReason = '`isPublic` hides it'
      else {
        const doc = mapLlmsDocument(visible, mappingOptions(strapi, llms, uid, source)).document
        publicVisible = !!doc
        publicURL = doc?.url ?? null
        if (!doc) publicReason = 'no frontend URL'
      }
    }
  }

  const attributes = Object.keys(strapi.contentType?.(uid)?.attributes ?? {})
  const state = { saved: !!documentId, published, publicVisible, publicReason }
  const builtin = inspectDocument(previewValues, {
    ...mappingOptions(strapi, llms, uid, source),
    site: jsonLdSite(llms),
    sourcesField: source.sourcesField,
    knownFields: [...attributes, 'id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt'],
    thresholds: llms.checks,
    state,
  })
  const inspection = await withRules(builtin, llms.rules, { values: previewValues, state, collection: uid }, { timeoutMs: llms.rulesTimeoutMs })

  const result: StrapiInspection = { ...inspection }
  if (publicURL) {
    const path = new URL(publicURL).pathname
    const api = `${strapi.config?.get<string>('server.url', '') ?? ''}${strapi.config?.get<string>('api.rest.prefix', '/api') ?? '/api'}`
    result.publicLinks = {
      page: publicURL,
      markdown: `${api}/geo/markdown?path=${encodeURIComponent(path)}`,
      jsonLd: source.jsonLd === false ? undefined : `${api}/geo/jsonld?path=${encodeURIComponent(path)}`,
    }
    result.validators = externalValidators(publicURL)
  }
  return { status: 200, body: result }
}
