import {
  externalValidators,
  inspectDocument,
  sourceFields,
  withRules,
  type Inspection,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Field, Payload, PayloadRequest } from 'payload'
import { converterFor, jsonLdSite, linkResolver, mapDoc, queryCollection, type LlmsOptions } from './llms.js'

export interface PayloadInspection extends Inspection {
  publicLinks?: { page?: string; markdown?: string; jsonLd?: string }
  validators?: Array<{ name: string; url: string }>
}

export interface InspectContext {
  llms: LlmsOptions
  collections: CollectionConfig[]
  /** Payload `serverURL`, for relative uploads and the public output links. */
  serverURL?: string
  /** API route, e.g. `/api`. */
  apiRoute: string
}

type Result = { status: number; body: PayloadInspection | { error: string } }

/** Names of the fields at the top level of a collection (rows, collapsibles and unnamed tabs flattened). */
export function topLevelFields(fields: Field[] | undefined): Field[] {
  return (fields ?? []).flatMap((f: any) => {
    if (f.type === 'row' || f.type === 'collapsible') return topLevelFields(f.fields)
    if (f.type === 'tabs') return (f.tabs ?? []).flatMap((t: any) => (t.name ? [{ ...t, type: 'group' }] : topLevelFields(t.fields)))
    return f.name ? [f] : []
  })
}

function relationTarget(field: any): string | null {
  if ((field?.type === 'upload' || field?.type === 'relationship') && typeof field.relationTo === 'string') return field.relationTo
  return null
}

/**
 * Form values hold relation and upload fields as ids. Resolve the ones the mapping reads (author, image)
 * with the editor's own access, so the preview shows the same names and URLs as the public output.
 */
async function resolveRelations(payload: Payload, req: PayloadRequest, config: CollectionConfig, llms: LlmsOptions, slug: string, values: Record<string, any>) {
  const source = llms.collections[slug]!
  const fields = sourceFields(source)
  const byName = new Map(topLevelFields(config.fields).map((f: any) => [f.name, f]))
  const out = { ...values }
  for (const path of [...fields.author, ...fields.image]) {
    const name = path.split('.')[0]!
    const field = byName.get(name)
    const target = relationTarget(field)
    if (!target || path.includes('.')) continue
    const value = out[name]
    const resolve = async (v: unknown) => {
      if (v == null || typeof v === 'object') return v
      try {
        return await payload.findByID({ collection: target as never, id: v as never, depth: 0, overrideAccess: false, user: req.user, req })
      } catch {
        return null
      }
    }
    out[name] = Array.isArray(value) ? await Promise.all(value.map(resolve)) : await resolve(value)
  }
  return out
}

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Form values hold relationships and uploads (also inside blocks and Lexical) as ids. Where the saved document has
 * the same id populated at the same place, use the populated value, so the preview converts uploads and related
 * documents like the public output does. Ids that were not saved yet stay ids (reported as unavailable).
 */
export function hydrate(value: unknown, stored: unknown, depth = 0): unknown {
  if (depth > 32) return value
  if ((typeof value === 'string' || typeof value === 'number') && isRecord(stored) && stored.id === value) return stored
  if (Array.isArray(value)) {
    const list = Array.isArray(stored) ? stored : []
    return value.map((item, i) => {
      const match = isRecord(item) && item.id != null ? list.find((s) => isRecord(s) && s.id === item.id) : list[i]
      return hydrate(item, match, depth + 1)
    })
  }
  if (isRecord(value)) {
    if (!isRecord(stored)) return value
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) out[k] = hydrate(v, stored[k], depth + 1)
    return out
  }
  return value
}

/**
 * Checks and previews for the document being edited. Admin only: the caller must be logged in and able to
 * read the collection. Nothing here is cached or reachable anonymously, and only collections configured in
 * `llms.collections` can be inspected (the client can't point it at anything else).
 */
export async function inspectPayloadDocument(req: PayloadRequest, ctx: InspectContext, body: unknown): Promise<Result> {
  if (!req.user) return { status: 401, body: { error: 'unauthorized' } }
  if (!isRecord(body) || typeof body.collection !== 'string') return { status: 400, body: { error: 'invalid body' } }
  const slug = body.collection
  const source = Object.prototype.hasOwnProperty.call(ctx.llms.collections, slug) ? ctx.llms.collections[slug] : undefined
  const config = ctx.collections.find((c) => c.slug === slug)
  if (!source || !config) return { status: 404, body: { error: 'collection is not configured for GEO' } }
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null
  const data = isRecord(body.data) ? body.data : {}
  const payload = req.payload
  const drafts = typeof config.versions === 'object' && !!config.versions?.drafts

  let stored: Record<string, any> = {}
  try {
    if (id !== null) {
      stored = (await payload.findByID({ collection: slug as never, id: id as never, draft: true, depth: source.depth ?? 1, overrideAccess: false, user: req.user, req })) as Record<string, any>
    } else {
      // No document yet: still require read access to the collection.
      await payload.find({ collection: slug as never, limit: 1, depth: 0, overrideAccess: false, user: req.user, req })
    }
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status === 403 || status === 401) return { status: 403, body: { error: 'forbidden' } }
    if (status === 404) return { status: 404, body: { error: 'not found' } }
    throw error
  }

  const version = body.version === 'published' ? 'published' : 'current'
  let base = stored
  if (version === 'published') {
    if (id === null) return { status: 404, body: { error: 'no published version' } }
    try {
      base = (await payload.findByID({ collection: slug as never, id: id as never, draft: false, depth: source.depth ?? 1, overrideAccess: false, user: req.user, req })) as Record<string, any>
    } catch {
      return { status: 404, body: { error: 'no published version' } }
    }
    if (drafts && base._status !== 'published') return { status: 404, body: { error: 'no published version' } }
  }
  const values = await resolveRelations(payload, req, config, ctx.llms, slug, version === 'published' ? base : hydrate({ ...stored, ...data }, stored) as Record<string, any>)

  // Where the saved document stands, judged anonymously like the public routes.
  let published: boolean | null = id === null ? null : !drafts
  let publicDoc: Record<string, any> | undefined
  if (id !== null) {
    if (drafts) {
      const found = await payload.find({
        collection: slug as never,
        where: { and: [{ id: { equals: id } }, { _status: { equals: 'published' } }] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        draft: false,
      })
      published = found.docs.length > 0
    }
    publicDoc = (await queryCollection(payload, slug, config, source, { id: { equals: id } }))[0]
  }
  const publicMapped = publicDoc ? mapDoc(publicDoc, slug, source, ctx.llms, ctx.serverURL) : null
  const publicVisible = id === null ? null : !!publicMapped
  const publicReason = !publicVisible && id !== null ? (published === false ? 'not published' : publicDoc ? 'no frontend URL' : 'anonymous visitors can’t read it (collection read access)') : undefined

  const knownFields = [...topLevelFields(config.fields).map((f: any) => f.name as string), 'id', 'createdAt', 'updatedAt', ...(drafts ? ['_status'] : [])]
  const state = { saved: id !== null, published, publicVisible, publicReason }
  const builtin = inspectDocument(values, {
    name: slug,
    siteURL: ctx.llms.siteURL,
    source,
    converter: converterFor(ctx.llms, source),
    linkFor: linkResolver(ctx.llms),
    mediaURL: ctx.llms.mediaURL ?? ctx.serverURL,
    site: jsonLdSite(ctx.llms),
    sourcesField: source.sourcesField,
    knownFields,
    thresholds: ctx.llms.checks,
    state,
  })
  const inspection = await withRules(builtin, ctx.llms.rules, { values, state, collection: slug }, { timeoutMs: ctx.llms.rulesTimeoutMs })

  const result: PayloadInspection = { ...inspection }
  if (publicMapped) {
    const path = new URL(publicMapped.url).pathname
    const api = `${ctx.serverURL ?? ''}${ctx.apiRoute}`
    result.publicLinks = {
      page: publicMapped.url,
      markdown: `${api}/geo/markdown?path=${encodeURIComponent(path)}`,
      jsonLd: source.jsonLd === false ? undefined : `${api}/geo/jsonld?path=${encodeURIComponent(path)}`,
    }
    result.validators = externalValidators(publicMapped.url)
  }
  return { status: 200, body: result }
}
