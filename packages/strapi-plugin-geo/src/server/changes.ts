import { lookup } from 'node:dns/promises'
import {
  invalidationActive,
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
import type { StrapiLlmsConfig } from './config'
import type { KoaContextLike, StrapiLike } from './types'

export const INVALIDATION_UID = 'plugin::geo.invalidation'
const PERMISSION_UID = 'plugin::users-permissions.permission'
/** Write actions of the Document Service that can change what the public sees. */
const WRITE_ACTIONS = new Set(['create', 'update', 'delete', 'publish', 'unpublish', 'discardDraft'])

export interface ChangeDeps {
  llms(): StrapiLlmsConfig | null
  invalidation(): InvalidationOptions | undefined
  /** Public state of one entry right now, read like the public routes (null: not public). */
  publicEntry(uid: string, documentId: string): Promise<LlmsDocument | null>
}

/** Frontend paths of the llms files, including the segment index. Part files are covered by the `geo:llms` tag. */
export function llmsPaths(llms: StrapiLlmsConfig): string[] {
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

function store(strapi: StrapiLike) {
  return {
    async save(record: DeliveryRecord) {
      await strapi.documents(INVALIDATION_UID).create({ data: { ...record } as Record<string, unknown> })
    },
  }
}

const resolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address)

export function send(strapi: StrapiLike, event: ContentChangeEvent, options: InvalidationOptions) {
  // Background: the save has already happened and must not wait for, or fail with, the notice.
  setTimeout(() => {
    notifyChange(event, options, { store: store(strapi), resolve, log: (m) => strapi.log.warn(m) }).catch((error) =>
      strapi.log.warn(`[geo] invalidation failed: ${(error as Error)?.message ?? error}`),
    )
  }, 0)
}

interface MiddlewareContext {
  uid: string
  action: string
  params: Record<string, any>
}

/**
 * Document Service middleware for the content types in `llms.contentTypes`. Around every write (create, update,
 * publish, unpublish, discard draft, delete) it reads the entry's public state before and after, anonymously like
 * the public routes, and sends a notice when anything public changed. Errors are logged and never fail the write.
 */
export function changeMiddleware(strapi: StrapiLike, deps: ChangeDeps) {
  return async (context: MiddlewareContext, next: () => Promise<unknown>) => {
    const llms = deps.llms()
    const options = deps.invalidation()
    if (!llms || !invalidationActive(options) || !WRITE_ACTIONS.has(context.action) || !llms.contentTypes[context.uid]) return next()
    const warn = (error: unknown) => strapi.log.warn(`[geo] could not prepare a cache notice for ${context.uid}: ${(error as Error)?.message ?? error}`)
    const id: string | undefined = context.params?.documentId
    let before: LlmsDocument | null = null
    try {
      if (id) before = await deps.publicEntry(context.uid, id)
    } catch (error) {
      warn(error)
    }
    const result = await next()
    try {
      const documentId = id ?? (result as { documentId?: string } | null)?.documentId
      const deleted = context.action === 'delete'
      const after = !deleted && documentId ? await deps.publicEntry(context.uid, documentId) : null
      if (before && after && JSON.stringify(before) === JSON.stringify(after)) return result
      const event = contentChangeEvent({ source: context.uid, documentId, before, after, deleted, siteURL: llms.siteURL, llmsPaths: llmsPaths(llms) })
      if (event) send(strapi, event, options)
    } catch (error) {
      warn(error)
    }
    return result
  }
}

/**
 * Users & Permissions changes (a Public role permission added or removed) change what every public route serves:
 * one site-wide `access` notice, sent once per burst of changes (saving a role writes many permissions).
 */
export function subscribePermissionChanges(strapi: StrapiLike & { db?: { lifecycles?: { subscribe(sub: Record<string, unknown>): unknown } } }, deps: ChangeDeps, debounceMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const changed = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const llms = deps.llms()
      const options = deps.invalidation()
      if (llms && invalidationActive(options)) send(strapi, siteChangeEvent('access', llms.siteURL, llmsPaths(llms)), options)
    }, debounceMs)
  }
  strapi.db?.lifecycles?.subscribe({ models: [PERMISSION_UID], afterCreate: changed, afterDelete: changed, afterUpdate: changed, afterCreateMany: changed, afterDeleteMany: changed, afterUpdateMany: changed })
  return changed
}

const NO_STORE = 'private, no-store'

/** Admin controllers: recent notices, retry one, "notify everything" after a mapping change. */
export function invalidationControllers(strapi: StrapiLike, deps: ChangeDeps) {
  const json = (ctx: KoaContextLike, status: number, body: unknown) => {
    ctx.set?.('Cache-Control', NO_STORE)
    ctx.status = status
    ctx.body = body
  }
  const configured = (ctx: KoaContextLike) => {
    const llms = deps.llms()
    const options = deps.invalidation()
    if (!llms || !invalidationActive(options)) {
      json(ctx, 404, { error: 'invalidation is not configured' })
      return null
    }
    return { llms, options }
  }
  return {
    async list(ctx: KoaContextLike) {
      const options = deps.invalidation()
      const rows = options?.targets?.length
        ? await strapi.documents(INVALIDATION_UID).findMany({ sort: ['createdAt:desc', 'id:desc'], limit: 50 })
        : []
      json(ctx, 200, {
        targets: (options?.targets ?? []).map((t) => ({ name: t.name, events: t.events ?? 'all' })),
        deliveries: rows.map((d) => ({ id: d.documentId, createdAt: d.createdAt, eventId: d.eventId, eventType: d.eventType, source: d.source, target: d.target, status: d.status, attempts: d.attempts, lastError: d.lastError ?? null })),
      })
    },
    async retry(ctx: KoaContextLike) {
      const cfg = configured(ctx)
      if (!cfg) return
      const id = (ctx.request.body as { id?: string } | undefined)?.id
      if (!id) return json(ctx, 400, { error: 'id is required' })
      const [row] = await strapi.documents(INVALIDATION_UID).findMany({ filters: { documentId: { $eq: id } }, limit: 1 })
      if (!row) return json(ctx, 404, { error: 'not found' })
      const target = cfg.options.targets.find((t) => t.name === row.target)
      if (!target) return json(ctx, 409, { error: 'target is no longer configured' })
      // Same event id: receivers that already handled it acknowledge it without acting twice.
      const record = await deliver(row.event as ContentChangeEvent, target, cfg.options, { store: store(strapi), resolve, sleep: async () => {} }, Number(row.attempts ?? 0))
      json(ctx, 200, { status: record.status, attempts: record.attempts, lastError: record.lastError ?? null })
    },
    async flush(ctx: KoaContextLike) {
      const cfg = configured(ctx)
      if (!cfg) return
      const event = siteChangeEvent('config', cfg.llms.siteURL, llmsPaths(cfg.llms))
      const records = await notifyChange(event, cfg.options, { store: store(strapi), resolve, sleep: async () => {} })
      json(ctx, 200, { eventId: event.id, results: records.map((r) => ({ target: r.target, status: r.status, lastError: r.lastError ?? null })) })
    },
  }
}
