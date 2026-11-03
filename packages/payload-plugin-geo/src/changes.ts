import { lookup } from 'node:dns/promises'
import {
  contentChangeEvent,
  deliver,
  notifyChange,
  resolvedSegments,
  siteChangeEvent,
  type ContentChangeEvent,
  type DeliveryRecord,
  type InvalidationOptions,
  type LlmsDocument,
} from '@garus-ltd/geo-core'
import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionConfig, Endpoint, Payload, PayloadRequest } from 'payload'
import { mapDoc, queryCollection, type LlmsOptions } from './llms.js'

export const INVALIDATIONS_SLUG = 'geo-invalidations'
const noStore = { 'cache-control': 'private, no-store' }

/** Delivery log of cache invalidation notices: only added when `invalidation.targets` is set. */
export function invalidationsCollection(): CollectionConfig {
  return {
    slug: INVALIDATIONS_SLUG,
    labels: { singular: 'Cache Notice', plural: 'Cache Notices' },
    admin: {
      group: 'GEO',
      useAsTitle: 'eventType',
      defaultColumns: ['createdAt', 'eventType', 'source', 'target', 'status', 'attempts', 'lastError'],
      description: 'Cache invalidation notices sent to the configured targets after content changes. A failed notice never undoes the save; retry it from the GEO dashboard.',
    },
    access: { read: ({ req }) => Boolean(req.user), create: () => false, update: () => false, delete: ({ req }) => Boolean(req.user) },
    fields: [
      { name: 'eventId', type: 'text', required: true, index: true },
      { name: 'eventType', type: 'text', required: true },
      { name: 'source', type: 'text' },
      { name: 'target', type: 'text', required: true },
      { name: 'status', type: 'select', required: true, index: true, options: ['pending', 'succeeded', 'failed'] },
      { name: 'attempts', type: 'number' },
      { name: 'lastError', type: 'text' },
      { name: 'lastAttemptAt', type: 'date' },
      { name: 'event', type: 'json' },
    ],
  }
}

/** Frontend paths of the llms files, including segment index files. Part files are covered by the `geo:llms` tag. */
function llmsPaths(llms: LlmsOptions): string[] {
  const paths = ['/llms.txt', '/llms-full.txt']
  const seg = resolvedSegments(llms.segments, llms.siteURL)
  if (seg.enabled) {
    try {
      paths.push(`${new URL(seg.baseURL).pathname}/`)
    } catch {
      // keep the defaults
    }
  }
  return paths
}

export interface ChangeContext {
  llms: LlmsOptions
  collections: () => CollectionConfig[]
  invalidation: InvalidationOptions
  serverURL?: string
}

function store(payload: Payload) {
  return {
    async save(record: DeliveryRecord) {
      await payload.create({
        collection: INVALIDATIONS_SLUG as never,
        overrideAccess: true,
        data: { ...record, event: record.event as never } as never,
      })
    },
  }
}

const resolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address)

export function send(payload: Payload, event: ContentChangeEvent, ctx: ChangeContext) {
  // Background: the save has already happened and must not wait for, or fail with, the notice.
  setTimeout(() => {
    notifyChange(event, ctx.invalidation, { store: store(payload), resolve, log: (m) => payload.logger.warn(m) }).catch((error) =>
      payload.logger.warn(`[geo] invalidation failed: ${(error as Error)?.message ?? error}`),
    )
  }, 0)
}

/** Public state of a document right now, read anonymously like the public routes. */
async function publicState(payload: Payload, slug: string, ctx: ChangeContext, id: unknown): Promise<LlmsDocument | null> {
  const config = ctx.collections().find((c) => c.slug === slug)
  const source = ctx.llms.collections[slug]
  if (!config || !source || id == null) return null
  const [doc] = await queryCollection(payload, slug, config, source, { id: { equals: id as never } }, { limit: 1 })
  return doc ? mapDoc(doc, slug, source, ctx.llms, ctx.serverURL) : null
}

const BEFORE = '__geoPublicBefore'

type HookContext = Record<string, unknown>

/**
 * Hooks for a collection in `llms.collections`. Before a change or delete they read the document's public state
 * (anonymously, like the public routes); after it they read it again and send a notice to the configured targets
 * when anything public changed: publish, update, unpublish, delete, URL change. Hook errors are logged and never
 * fail the save; the notice itself is sent in the background.
 */
export function changeHooks(slug: string, ctx: ChangeContext): {
  beforeChange: CollectionBeforeChangeHook
  afterChange: CollectionAfterChangeHook
  beforeDelete: CollectionBeforeDeleteHook
  afterDelete: CollectionAfterDeleteHook
} {
  const warn = (req: PayloadRequest, error: unknown) => req.payload.logger.warn(`[geo] could not prepare a cache notice for ${slug}: ${(error as Error)?.message ?? error}`)
  const emit = (req: PayloadRequest, id: unknown, before: LlmsDocument | null, after: LlmsDocument | null, deleted = false) => {
    if (before && after && JSON.stringify(before) === JSON.stringify(after)) return
    const event = contentChangeEvent({ source: slug, documentId: id as string, before, after, deleted, siteURL: ctx.llms.siteURL, llmsPaths: llmsPaths(ctx.llms) })
    if (event) send(req.payload, event, ctx)
  }
  return {
    beforeChange: async ({ data, originalDoc, operation, req, context }) => {
      try {
        if (operation === 'update' && originalDoc?.id != null) (context as HookContext)[BEFORE] = await publicState(req.payload, slug, ctx, originalDoc.id)
      } catch (error) {
        warn(req, error)
      }
      return data
    },
    afterChange: async ({ doc, req, context }) => {
      try {
        const after = await publicState(req.payload, slug, ctx, doc?.id)
        const before = ((context as HookContext)[BEFORE] as LlmsDocument | null | undefined) ?? null
        emit(req, doc?.id, before, after)
      } catch (error) {
        warn(req, error)
      }
      return doc
    },
    beforeDelete: async ({ id, req, context }) => {
      try {
        ;(context as HookContext)[BEFORE] = await publicState(req.payload, slug, ctx, id)
      } catch (error) {
        warn(req, error)
      }
    },
    afterDelete: async ({ doc, id, req, context }) => {
      try {
        emit(req, id ?? doc?.id, ((context as HookContext)[BEFORE] as LlmsDocument | null | undefined) ?? null, null, true)
      } catch (error) {
        warn(req, error)
      }
      return doc
    },
  }
}

/** Admin endpoints: recent notices, retry one, and "notify everything" after a mapping or access change. */
export function invalidationEndpoints(ctx: ChangeContext): Endpoint[] {
  const needUser = (req: PayloadRequest) => (req.user ? null : Response.json({ error: 'unauthorized' }, { status: 401, headers: noStore }))
  return [
    {
      path: '/geo/invalidations',
      method: 'get',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const rows = await req.payload.find({ collection: INVALIDATIONS_SLUG as never, limit: 50, sort: '-createdAt', depth: 0, overrideAccess: false, user: req.user, req })
        return Response.json(
          {
            targets: ctx.invalidation.targets.map((t) => ({ name: t.name, events: t.events ?? 'all' })),
            deliveries: (rows.docs as Record<string, any>[]).map((d) => ({ id: d.id, createdAt: d.createdAt, eventId: d.eventId, eventType: d.eventType, source: d.source, target: d.target, status: d.status, attempts: d.attempts, lastError: d.lastError ?? null })),
          },
          { headers: noStore },
        )
      },
    },
    {
      path: '/geo/invalidations/retry',
      method: 'post',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const body = (await req.json?.().catch(() => null)) as { id?: string | number } | null
        if (body?.id == null) return Response.json({ error: 'id is required' }, { status: 400, headers: noStore })
        let row: Record<string, any>
        try {
          row = (await req.payload.findByID({ collection: INVALIDATIONS_SLUG as never, id: body.id as never, depth: 0, overrideAccess: false, user: req.user, req })) as Record<string, any>
        } catch {
          return Response.json({ error: 'not found' }, { status: 404, headers: noStore })
        }
        const target = ctx.invalidation.targets.find((t) => t.name === row.target)
        if (!target) return Response.json({ error: 'target is no longer configured' }, { status: 409, headers: noStore })
        // Same event id: receivers that already handled it acknowledge it without acting twice.
        const record = await deliver(row.event as ContentChangeEvent, target, ctx.invalidation, { store: store(req.payload), resolve, sleep: async () => {} }, Number(row.attempts ?? 0))
        return Response.json({ status: record.status, attempts: record.attempts, lastError: record.lastError ?? null }, { headers: noStore })
      },
    },
    {
      path: '/geo/invalidations/flush',
      method: 'post',
      handler: async (req) => {
        const denied = needUser(req)
        if (denied) return denied
        const event = siteChangeEvent('config', ctx.llms.siteURL, llmsPaths(ctx.llms))
        const records = await notifyChange(event, ctx.invalidation, { store: store(req.payload), resolve, sleep: async () => {} })
        return Response.json({ eventId: event.id, results: records.map((r) => ({ target: r.target, status: r.status, lastError: r.lastError ?? null })) }, { headers: noStore })
      },
    },
  ]
}
