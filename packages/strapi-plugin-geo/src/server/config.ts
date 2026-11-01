import type { LlmsSourceConfig } from '@garus-ltd/geo-core'

export interface StrapiLlmsSource extends LlmsSourceConfig {
  /** Extra Document Service filters, e.g. `{ noindex: { $ne: true } }`. */
  filters?: Record<string, unknown>
  /** Max documents from this content type. Default 500. */
  limit?: number
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
    }
  },
}
