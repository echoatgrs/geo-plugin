import type { StrapiLlmsConfig, StrapiLlmsSource } from './config'
import type { StrapiLike } from './types'

/**
 * Decides what the anonymous public may see, the same way the Strapi REST API would:
 *
 * 1. The content type's core `find` route must exist and the Users & Permissions Public role must be
 *    allowed `<uid>.find` (llms.txt and the per-page lookup by slug both need to list entries).
 * 2. A `find` route with custom policies or route middlewares can't be evaluated for an anonymous
 *    request, so the content type is skipped unless its source has an `isPublic` check.
 * 3. Each entry goes through Strapi's own content API output sanitizer with the Public role's ability,
 *    which drops private fields and relations / media the Public role can't read.
 * 4. The source's `isPublic(entry)` check, when set, runs last for per-entry rules.
 *
 * Nothing is cached between requests, so publishing, unpublishing and permission changes apply at once.
 */
export interface PublicAccess {
  /** Content types whose entries may be served. */
  allowed: Set<string>
  /** Entry as the anonymous REST API would return it, or null when it must not be served. */
  filter(uid: string, source: StrapiLlmsSource, entry: Record<string, any>): Promise<Record<string, any> | null>
}

const PUBLIC_ROLE_UID = 'plugin::users-permissions.role'
const warned = new Set<string>()

export function warnOnce(strapi: StrapiLike, message: string) {
  if (warned.has(message)) return
  warned.add(message)
  strapi.log.warn(message)
}

/** For tests. */
export function resetWarnings() {
  warned.clear()
}

interface Ability {
  can(action: string): boolean
}

interface RouteLike {
  method?: string
  path?: string
  handler?: unknown
  config?: { policies?: unknown[]; middlewares?: unknown[]; auth?: unknown }
}

function routeList(router: unknown): RouteLike[] {
  if (Array.isArray(router)) return router as RouteLike[]
  if (router && typeof router === 'object' && Array.isArray((router as { routes?: unknown }).routes)) {
    const r = router as { type?: string; routes: RouteLike[] }
    return r.type === 'admin' ? [] : r.routes
  }
  return []
}

/** Content API routes whose handler is `<uid>.<action>`, from `strapi.apis` and `strapi.plugins`. */
export function findRoutes(strapi: StrapiLike, uid: string, action: string): RouteLike[] | null {
  const containers = [...Object.values(strapi.apis ?? {}), ...Object.values(strapi.plugins ?? {})]
  // A fake or partial Strapi without a route registry: we can't tell, report unknown.
  if (containers.length === 0) return null
  const handler = `${uid}.${action}`
  const found: RouteLike[] = []
  for (const container of containers) {
    const routes = (container as { routes?: unknown })?.routes
    const routers = Array.isArray(routes) ? [routes] : Object.values(routes ?? {})
    for (const router of routers) {
      for (const route of routeList(router)) if (route.handler === handler) found.push(route)
    }
  }
  return found
}

export type RouteCheck = 'public' | 'role' | 'missing' | 'custom' | 'unknown'

/** How the anonymous `find` route of a content type is guarded. */
export function checkFindRoute(strapi: StrapiLike, uid: string): RouteCheck {
  const routes = findRoutes(strapi, uid, 'find')
  if (routes === null) return 'unknown'
  if (routes.length === 0) return 'missing'
  const custom = routes.some((r) => (r.config?.policies?.length ?? 0) > 0 || (r.config?.middlewares?.length ?? 0) > 0)
  if (custom) return 'custom'
  return routes.every((r) => r.config?.auth === false) ? 'public' : 'role'
}

/** The Public role's content API ability, or null without Users & Permissions. */
async function publicAbility(strapi: StrapiLike): Promise<Ability | null> {
  if (!strapi.contentType?.(PUBLIC_ROLE_UID)) return null
  const service = (() => {
    try {
      return strapi.plugin('users-permissions').service?.('permission') as
        | { findPublicPermissions(): Promise<unknown[]>; toContentAPIPermission(p: unknown): unknown }
        | undefined
    } catch {
      return undefined
    }
  })()
  const engine = strapi.contentAPI?.permissions?.engine
  if (service?.findPublicPermissions && engine?.generateAbility) {
    const permissions = (await service.findPublicPermissions()).map((p) => service.toContentAPIPermission(p))
    return engine.generateAbility(permissions)
  }
  // Fallback for environments without the permission engine: read the role's actions directly.
  const role = await strapi.db?.query(PUBLIC_ROLE_UID).findOne({ where: { type: 'public' }, populate: ['permissions'] })
  if (!role) return null
  const actions = new Set<string>((role.permissions ?? []).map((p: { action?: string }) => p.action))
  return { can: (action) => actions.has(action) }
}

function sanitizer(strapi: StrapiLike, auth: unknown) {
  const output = strapi.contentAPI?.sanitize?.output
  return async (uid: string, entry: Record<string, any>) => {
    const schema = strapi.getModel?.(uid) ?? strapi.contentType?.(uid)
    if (!output || !schema) return entry
    return (await output(entry, schema, auth ? { auth } : {})) as Record<string, any>
  }
}

async function runIsPublic(strapi: StrapiLike, uid: string, source: StrapiLlmsSource, entry: Record<string, any>) {
  if (!source.isPublic) return true
  try {
    return (await source.isPublic(entry, { uid, strapi })) === true
  } catch (error) {
    warnOnce(strapi, `[geo] isPublic for ${uid} threw, so the entry is not served: ${(error as Error)?.message ?? error}`)
    return false
  }
}

export async function publicAccess(strapi: StrapiLike, llms: StrapiLlmsConfig): Promise<PublicAccess> {
  const uids = Object.keys(llms.contentTypes)

  if (llms.publicOnly === false) {
    // The site reads Strapi with its own token: serve every listed type, still dropping private fields.
    const sanitize = sanitizer(strapi, null)
    return {
      allowed: new Set(uids),
      async filter(uid, source, entry) {
        const clean = await sanitize(uid, entry)
        return (await runIsPublic(strapi, uid, source, clean)) ? clean : null
      },
    }
  }

  const ability = await publicAbility(strapi)
  if (!ability) {
    warnOnce(strapi, '[geo] No Users & Permissions Public role found, so llms.txt lists nothing. Set `llms.publicOnly: false` to serve the configured content types anyway.')
    return { allowed: new Set(), filter: async () => null }
  }

  const allowed = new Set<string>()
  for (const uid of uids) {
    const source = llms.contentTypes[uid]!
    const route = checkFindRoute(strapi, uid)
    if (route === 'missing') {
      warnOnce(strapi, `[geo] ${uid} is skipped: it has no REST \`find\` route, so anonymous visitors can't list it.`)
      continue
    }
    if (route === 'custom' && !source.isPublic) {
      warnOnce(strapi, `[geo] ${uid} is skipped: its \`find\` route has custom policies or middlewares the plugin can't evaluate. Add \`isPublic\` to its llms source to decide per entry.`)
      continue
    }
    if (route !== 'public' && !ability.can(`${uid}.find`)) {
      warnOnce(strapi, `[geo] ${uid} is skipped: the Public role can't \`find\` it. Allow find for Public, or set \`llms.publicOnly: false\`.`)
      continue
    }
    allowed.add(uid)
  }

  // Strapi's relation sanitizer asks the auth strategy whether a scope is allowed.
  const auth = {
    strategy: {
      name: 'users-permissions',
      verify(_auth: unknown, config: { scope?: string | string[] } = {}) {
        const scopes = config.scope === undefined ? [] : Array.isArray(config.scope) ? config.scope : [config.scope]
        if (!scopes.length || !scopes.every((s) => ability.can(s))) throw new Error('Forbidden')
      },
    },
    credentials: null,
    ability,
  }
  const sanitize = sanitizer(strapi, auth)
  return {
    allowed,
    async filter(uid, source, entry) {
      if (!allowed.has(uid)) return null
      const clean = await sanitize(uid, entry)
      return (await runIsPublic(strapi, uid, source, clean)) ? clean : null
    },
  }
}
