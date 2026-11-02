import type { CheckThresholds, LlmsSourceConfig } from '@garus-ltd/geo-core'

export interface StrapiLlmsSource extends LlmsSourceConfig {
  /** Extra Document Service filters, e.g. `{ noindex: { $ne: true } }`. */
  filters?: Record<string, unknown>
  /** Max documents from this content type. Default 500. */
  limit?: number
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
  /** Thresholds of the editor panel's length suggestions. */
  checks?: CheckThresholds
  /** Show the read-only GEO panel in the content manager's edit view of the listed content types. Default true. */
  editorPanel?: boolean
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
  /** Serve `/api/geo/llms.txt` and `/api/geo/llms-full.txt`. */
  llms: StrapiLlmsConfig | null
}

export default {
  default: (): GeoStrapiConfig => ({ secret: '', verifyIPs: true, storeSpoofed: true, enabled: true, llms: null }),
  validator(config: Partial<GeoStrapiConfig>) {
    if (config.secret !== undefined && typeof config.secret !== 'string') {
      throw new Error('[geo] `secret` must be a string')
    }
    if (config.llms) {
      if (typeof config.llms.siteURL !== 'string' || !config.llms.siteURL) throw new Error('[geo] `llms.siteURL` is required')
      if (typeof config.llms.contentTypes !== 'object') throw new Error('[geo] `llms.contentTypes` is required')
      const age = config.llms.cacheMaxAge
      if (age !== undefined && !(Number.isInteger(age) && age >= 0)) throw new Error('[geo] `llms.cacheMaxAge` must be a whole number of seconds')
      for (const [uid, source] of Object.entries(config.llms.contentTypes)) {
        if (source?.isPublic !== undefined && typeof source.isPublic !== 'function') throw new Error(`[geo] \`isPublic\` of ${uid} must be a function`)
      }
    }
  },
}
