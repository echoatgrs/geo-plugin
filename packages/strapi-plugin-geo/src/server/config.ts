import { createContentConverter, defineRules, type BotDefinition, type CheckThresholds, type ContentConverterOptions, type GeoRule, type LlmsSourceConfig, type OrganizationConfig, type SegmentOptions, type InvalidationOptions, validateInvalidationOptions } from '@garus-ltd/geo-core'
import type { StrapiCitationConfig, StrapiReferralConfig } from './evidence'

export interface StrapiLlmsSource extends LlmsSourceConfig {
  /** Extra Document Service filters, e.g. `{ noindex: { $ne: true } }`. */
  filters?: Record<string, unknown>
  /** Max documents from this content type in llms.txt / llms-full.txt. Default 500. With `segments` on, all are listed in parts. */
  limit?: number
  /** Order of the list, e.g. `'publishedAt:desc'`. Default `updatedAt:desc` (`createdAt:asc` with segments); `id:asc` is always added last. */
  sort?: string | string[]
  /**
   * Document Service `populate` for this content type. Default: built from the schema (media, components and
   * dynamic zones at any depth up to `populateDepth`, relations one level). The output sanitizer still drops
   * whatever the Public role can't read.
   */
  populate?: unknown
  /** Component / dynamic zone nesting the default populate follows. Default 5. */
  populateDepth?: number
  /** Block / component converters for this content type, merged over `llms.converters`. */
  converters?: ContentConverterOptions
  /**
   * Per-entry public check, for rules the Public role can't express: custom route policies, members-only
   * flags, document-level permissions from another plugin. Runs after the Public role check and Strapi's
   * output sanitizer, on the sanitized entry. Return `true` to serve the entry; anything else, or a throw,
   * hides it. Required when the content type's `find` route has custom policies or middlewares, which
   * the plugin can't evaluate on its own.
   */
  isPublic?: (entry: Record<string, any>, context: { uid: string; strapi: unknown }) => boolean | Promise<boolean>
}

export interface StrapiLlmsConfig {
  /** Public URL of the frontend, e.g. `https://example.com`. */
  siteURL: string
  name?: string
  description?: string
  details?: string
  /** Content types to list, keyed by UID, e.g. `'api::article.article'`. */
  contentTypes: Record<string, StrapiLlmsSource>
  /** Logo for the JSON-LD publisher, absolute or a path on the site. */
  logo?: string
  /** The site organization as a JSON-LD node with a stable `@id`, used as publisher of every article. */
  organization?: OrganizationConfig
  /**
   * JSON-LD types the host site already outputs itself. `GET /api/geo/jsonld?omit=host` leaves them out; without
   * `omit` the endpoint still returns everything.
   */
  hostManaged?: string[]
  /** Content language for JSON-LD, e.g. `en`. */
  language?: string
  /** Base for relative media URLs such as `/uploads/a.png`, usually the Strapi URL. Default: Strapi `server.url`, else `siteURL`. */
  mediaURL?: string
  /** Link llms.txt entries to the `.md` version of each page. Turn on once the frontend serves them. Default false. */
  markdownLinks?: boolean
  /**
   * Only serve what an anonymous REST request could read: content types whose `find` the Public role is allowed, sanitized like the REST API, so
   * llms.txt, Markdown and JSON-LD never expose what the REST API would refuse. Default true.
   * Set false to serve every listed content type, e.g. when the site reads Strapi with an API token.
   */
  publicOnly?: boolean
  /**
   * Seconds browsers and CDNs may cache llms.txt, Markdown and JSON-LD (`Cache-Control: public`). Default 300.
   * The plugin itself caches nothing, so a CDN or browser may keep serving an unpublished entry for up to
   * this long. `0` sends `no-store`.
   */
  cacheMaxAge?: number
  /** Seconds a 404 of the public outputs may be cached. Default: `cacheMaxAge` capped at 60. */
  notFoundMaxAge?: number
  /** Byte limit of the single llms-full.txt; entries beyond it are listed as not included. Default 5 MB. */
  fullMaxBytes?: number
  /** Split llms.txt / llms-full.txt into parts for large sites (`/api/geo/llms/<name>-<n>.txt`). Off by default. */
  segments?: SegmentOptions
  /** Thresholds of the editor panel's length suggestions. */
  checks?: CheckThresholds
  /** Show the read-only GEO panel in the content manager's edit view of the listed content types. Default true. */
  editorPanel?: boolean
  /** Other hosts of the same site (e.g. `www.example.com`), counted with `siteURL`'s host in per-page visits. */
  hosts?: string[]
  /**
   * Converters for your components (by UID, e.g. `shared.hero`, or the part after the dot) and Blocks nodes, used
   * by Markdown, llms-full.txt and the editor preview alike. Built-in ones cover the Strapi blog template components.
   */
  converters?: ContentConverterOptions
  /** Custom editor panel checks, run after the built-in ones. Validated at startup (see `defineRules`). */
  rules?: GeoRule<any>[]
  /** Time limit per async custom rule. Default 2000 ms. */
  rulesTimeoutMs?: number
}

export interface GeoStrapiConfig {
  /** Shared secret the frontend proxy sends in `x-geo-secret`. */
  secret: string
  /** Check crawler IPs against vendor-published ranges. */
  verifyIPs: boolean
  /** Store hits whose IP does not match the claimed bot. */
  storeSpoofed: boolean
  /** Stop accepting hits without removing the content type. */
  enabled: boolean
  /** Bot list used to classify reported hits (e.g. from `defineBots`). Default: the built-in list. */
  bots?: readonly BotDefinition[]
  /** Serve `/api/geo/llms.txt` and `/api/geo/llms-full.txt`. */
  llms: StrapiLlmsConfig | null
  /** Setup status view: connectivity test limits. */
  diagnostics?: {
    /** Let the connectivity test request loopback / private addresses (local development only). Default false. */
    allowPrivateNetwork?: boolean
    /** Seconds to wait for the frontend proxy's report of the test request. Default 4. */
    probeWaitSeconds?: number
  }
  /** AI referral visits reported by withGeo({ referrals }). Off by default. */
  referrals?: StrapiReferralConfig
  /** Citation evidence entered by hand in the content manager. Off by default. */
  citations?: StrapiCitationConfig
  /**
   * Cache invalidation notices: after a publish, edit, unpublish, discard or delete in `llms.contentTypes`, or a
   * Public role permission change, POST a signed event to these targets (e.g. the frontend's revalidation route).
   * Delivery results are kept in the `Cache Notice` content type. Off unless targets are set.
   */
  invalidation?: InvalidationOptions
}

export default {
  default: (): GeoStrapiConfig => ({ secret: '', verifyIPs: true, storeSpoofed: true, enabled: true, llms: null }),
  validator(config: Partial<GeoStrapiConfig>) {
    validateInvalidationOptions(config.invalidation)
    if (config.secret !== undefined && typeof config.secret !== 'string') {
      throw new Error('[geo] `secret` must be a string')
    }
    if (config.llms) {
      if (typeof config.llms.siteURL !== 'string' || !config.llms.siteURL) throw new Error('[geo] `llms.siteURL` is required')
      if (typeof config.llms.contentTypes !== 'object') throw new Error('[geo] `llms.contentTypes` is required')
      const age = config.llms.cacheMaxAge
      if (age !== undefined && !(Number.isInteger(age) && age >= 0)) throw new Error('[geo] `llms.cacheMaxAge` must be a whole number of seconds')
      const nf = config.llms.notFoundMaxAge
      if (nf !== undefined && !(Number.isInteger(nf) && nf >= 0)) throw new Error('[geo] `llms.notFoundMaxAge` must be a whole number of seconds')
      for (const [uid, source] of Object.entries(config.llms.contentTypes)) {
        if (source?.isPublic !== undefined && typeof source.isPublic !== 'function') throw new Error(`[geo] \`isPublic\` of ${uid} must be a function`)
        createContentConverter({ ...config.llms.converters, ...source?.converters })
      }
      if (config.llms.rules) defineRules(config.llms.rules)
    }
  },
}
