import {
  createContentConverter,
  defineRules,
  documentURL,
  mergeConverterOptions,
  buildJsonLd,
  included,
  omitJsonLdTypes,
  segmentKey,
  buildLlmsFullTxt,
  buildLlmsTxt,
  documentMarkdown,
  findDocumentByPath,
  lastSegment,
  toLlmsDocument,
  type CheckThresholds,
  type ContentConverter,
  type ContentConverterOptions,
  type GeoRule,
  type JsonLd,
  type JsonLdSite,
  type SegmentOptions,
  type SegmentSource,
  type OrganizationConfig,
  type LlmsDocument,
  type LlmsSourceConfig,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Field, Payload, Where } from 'payload'

export interface PayloadLlmsSource extends LlmsSourceConfig {
  /** Extra filter, e.g. `{ noindex: { not_equals: true } }`. */
  where?: Where
  /** Max documents from this collection. Default 500. With `segments` on, all public documents are listed. */
  limit?: number
  /** Order of the list, e.g. `'-publishedAt'` or `['title']`. Default `-updatedAt` (`createdAt` with segments); `id` is always added last. */
  sort?: string | string[]
  /**
   * How deep Payload populates relationships and uploads (also inside blocks and Lexical). Default 1.
   * Population runs with the anonymous visitor's access, so related documents the public can't read stay ids.
   */
  depth?: number
  /** Block / node converters for this collection, merged over `llms.converters`. */
  converters?: ContentConverterOptions
}

export interface LlmsOptions {
  /** Public URL of the frontend, e.g. `https://example.com`. */
  siteURL: string
  /** Site name for the `# heading`. Default: the admin meta title, else `siteURL`. */
  name?: string
  description?: string
  details?: string
  /** Collections to list, keyed by slug. */
  collections: Record<string, PayloadLlmsSource>
  /** Logo for the JSON-LD publisher, absolute or a path on the site. */
  logo?: string
  /**
   * The site organization as a JSON-LD node with a stable `@id`, used as publisher (and author fallback) of every
   * article. Without it the publisher is an inline Organization named after the site, as before.
   */
  organization?: OrganizationConfig
  /**
   * JSON-LD types the host site already outputs itself (e.g. `['Article', 'Organization']` when an SEO plugin
   * renders them). The frontend gets the graph without them with `fetchJsonLd({ omit: 'host' })`; the endpoint
   * without `omit` still returns everything. Used by the setup check for duplicate nodes.
   */
  hostManaged?: string[]
  /** Content language for JSON-LD, e.g. `en`. */
  language?: string
  /** Base for relative upload URLs. Default: Payload `serverURL`, else `siteURL`. */
  mediaURL?: string
  /** Link llms.txt entries to the `.md` version of each page. Turn on once the frontend serves them. Default false. */
  markdownLinks?: boolean
  /**
   * Seconds browsers and CDNs may cache llms.txt, Markdown and JSON-LD (`Cache-Control: public`). Default 300.
   * The plugin itself caches nothing; a CDN may keep serving an unpublished page for up to this long. `0` sends `no-store`.
   */
  cacheMaxAge?: number
  /** Thresholds of the editor panel's length suggestions. */
  checks?: CheckThresholds
  /** Seconds a 404 of the public outputs may be cached. Default: `cacheMaxAge` capped at 60. */
  notFoundMaxAge?: number
  /** Byte limit of the single llms-full.txt; documents beyond it are listed as not included. Default 5 MB. */
  fullMaxBytes?: number
  /** Split llms.txt / llms-full.txt into parts for large sites. Off by default. */
  segments?: SegmentOptions
  /** Other hosts of the same site (e.g. `www.example.com`), counted with `siteURL`'s host in per-page visits. */
  hosts?: string[]
  /**
   * Converters for your own blocks and Lexical nodes, used by Markdown, llms-full.txt and the editor preview alike.
   * Built-in ones cover the Payload website template blocks; see the README for the list.
   */
  converters?: ContentConverterOptions
  /** Custom editor panel checks, run after the built-in ones. Validated at startup (see `defineRules`). */
  rules?: GeoRule<any>[]
  /** Time limit per async custom rule. Default 2000 ms. */
  rulesTimeoutMs?: number
}

const converterCache = new WeakMap<object, { global: unknown; converter: ContentConverter }>()

/** The converter of a collection: built-ins, then `llms.converters`, then the collection's own. Cached. */
export function converterFor(options: LlmsOptions, source: PayloadLlmsSource): ContentConverter {
  const cached = converterCache.get(source)
  if (cached && cached.global === options.converters) return cached.converter
  const converter = createContentConverter(mergeConverterOptions(options.converters, source.converters))
  converterCache.set(source, { global: options.converters, converter })
  return converter
}

/** Validates the llms options once at startup: rules and converters fail fast with a clear message. */
export function validateLlmsOptions(options: LlmsOptions) {
  if (options.rules) defineRules(options.rules)
  for (const source of Object.values(options.collections)) converterFor(options, source)
}

/** Links between documents: a related document of a configured collection gets its public URL. */
export function linkResolver(options: LlmsOptions) {
  return (doc: Record<string, any>, relationTo?: string) => {
    const source = relationTo && Object.prototype.hasOwnProperty.call(options.collections, relationTo) ? options.collections[relationTo] : undefined
    return source ? documentURL(doc, relationTo!, source, options.siteURL) : null
  }
}

/** Whether a collection has a top-level `slug` field (rows, collapsibles and unnamed tabs count as top level). */
export function hasField(fields: Field[] | undefined, name: string): boolean {
  return (fields ?? []).some((f: any) => {
    if (f.name === name) return true
    if ((f.type === 'row' || f.type === 'collapsible') && hasField(f.fields, name)) return true
    if (f.type === 'tabs') return (f.tabs ?? []).some((t: any) => !t.name && hasField(t.fields, name))
    return false
  })
}

/** Documents read per query when listing a collection; also the page size of cross-page reads. */
export const READ_BATCH = 100

function sortOf(source: PayloadLlmsSource, segmented: boolean): string[] {
  const own = source.sort == null ? [] : Array.isArray(source.sort) ? source.sort : [source.sort]
  const base = own.length ? own : segmented ? ['createdAt'] : ['-updatedAt']
  // `id` last, so documents with the same date always come in the same order.
  return base.some((s) => s.replace(/^-/, '') === 'id') ? base : [...base, 'id']
}

function filtersOf(config: CollectionConfig, source: PayloadLlmsSource, extra?: Where): Where | undefined {
  const filters: Where[] = []
  if (source.where) filters.push(source.where)
  if (typeof config.versions === 'object' && config.versions.drafts) filters.push({ _status: { equals: 'published' } })
  if (extra) filters.push(extra)
  return filters.length ? { and: filters } : undefined
}

function forbidden(error: unknown): boolean {
  // Payload throws Forbidden when the public can't read the collection at all: list nothing from it.
  return (error as { status?: number })?.status === 403
}

/** One page of the collection, anonymously (only what the public may read), in a stable order. */
export async function queryCollection(
  payload: Payload,
  slug: string,
  config: CollectionConfig,
  source: PayloadLlmsSource,
  extra?: Where,
  page: { page?: number; limit?: number; segmented?: boolean } = {},
): Promise<Record<string, any>[]> {
  try {
    const result = await payload.find({
      collection: slug as never,
      where: filtersOf(config, source, extra),
      limit: page.limit ?? source.limit ?? 500,
      page: page.page,
      depth: source.depth ?? 1,
      // Anonymous read: only content the public can already see is served.
      overrideAccess: false,
      sort: sortOf(source, !!page.segmented) as never,
    })
    return result.docs as Record<string, any>[]
  } catch (error) {
    if (forbidden(error)) return []
    throw error
  }
}

/** Public, published documents of a collection (anonymous count; per-document checks come after). */
export async function countCollection(payload: Payload, slug: string, config: CollectionConfig, source: PayloadLlmsSource): Promise<number> {
  try {
    const result = await payload.count({ collection: slug as never, where: filtersOf(config, source), overrideAccess: false })
    return result.totalDocs
  } catch (error) {
    if (forbidden(error)) return 0
    throw error
  }
}

export function mapDoc(doc: Record<string, any>, slug: string, source: PayloadLlmsSource, options: LlmsOptions, mediaURL?: string) {
  return toLlmsDocument(doc, {
    name: slug,
    siteURL: options.siteURL,
    source,
    converter: converterFor(options, source),
    linkFor: linkResolver(options),
    mediaURL: options.mediaURL ?? mediaURL,
  })
}

function sources(payload: Payload, options: LlmsOptions, collections: CollectionConfig[]) {
  return Object.entries(options.collections).flatMap(([slug, source]) => {
    const config = collections.find((c) => c.slug === slug)
    if (!config) {
      payload.logger.warn(`[geo] llms collection "${slug}" does not exist`)
      return []
    }
    return [{ slug, source, config }]
  })
}

export interface LlmsListing {
  docs: LlmsDocument[]
  /** Visible notes per section when a `limit` cut the list. */
  notes: Record<string, string>
}

/**
 * Every listed document, read page by page (READ_BATCH per query) up to each collection's `limit`, filtered by
 * `include`, without duplicate URLs. llms.txt, llms-full.txt and the dashboard coverage use this list.
 */
export async function loadLlmsListing(payload: Payload, options: LlmsOptions, collections: CollectionConfig[], mediaURL?: string): Promise<LlmsListing> {
  const docs: LlmsDocument[] = []
  const notes: Record<string, string> = {}
  const seen = new Set<string>()
  for (const { slug, source, config } of sources(payload, options, collections)) {
    const limit = source.limit ?? 500
    let read = 0
    for (let page = 1; read < limit; page++) {
      const batch = await queryCollection(payload, slug, config, source, undefined, { page, limit: Math.min(READ_BATCH, limit) })
      for (const doc of batch.slice(0, limit - read)) {
        const mapped = mapDoc(doc, slug, source, options, mediaURL)
        if (!mapped || !included(doc, source) || seen.has(mapped.url)) continue
        seen.add(mapped.url)
        docs.push(mapped)
      }
      read += batch.length
      if (batch.length < Math.min(READ_BATCH, limit)) break
    }
    if (read >= limit) {
      const total = await countCollection(payload, slug, config, source)
      if (total > limit) notes[source.section ?? slug] = `Lists ${limit} of ${total} entries (limit ${limit}). Raise \`limit\` or turn on \`segments\` to list all.`
    }
  }
  return { docs, notes }
}

export async function loadLlmsDocuments(
  payload: Payload,
  options: LlmsOptions,
  collections: CollectionConfig[],
  mediaURL?: string,
): Promise<LlmsDocument[]> {
  return (await loadLlmsListing(payload, options, collections, mediaURL)).docs
}

/** Segment sources: one per collection, read one part at a time. */
export function segmentSources(payload: Payload, options: LlmsOptions, collections: CollectionConfig[], mediaURL?: string): SegmentSource[] {
  return sources(payload, options, collections).map(({ slug, source, config }) => ({
    key: segmentKey(slug),
    section: source.section ?? slug,
    count: () => countCollection(payload, slug, config, source),
    async page(offset, limit) {
      // Parts are aligned to their size, so offset / limit is a whole page number.
      const docs = await queryCollection(payload, slug, config, source, undefined, { page: Math.floor(offset / limit) + 1, limit, segmented: true })
      return docs.flatMap((d) => {
        const mapped = mapDoc(d, slug, source, options, mediaURL)
        return mapped && included(d, source) ? [mapped] : []
      })
    },
    async featured() {
      if (!source.featured || typeof source.featured !== 'string') return []
      const docs = await queryCollection(payload, slug, config, source, { [source.featured]: { equals: true } }, { limit: 50 })
      return docs.flatMap((d) => {
        const mapped = mapDoc(d, slug, source, options, mediaURL)
        return mapped && included(d, source) ? [mapped] : []
      })
    },
  }))
}

/**
 * The published, publicly readable document served at a frontend path.
 * Collections with a `slug` field are queried by the path's last segment; others are scanned.
 */
export async function loadDocumentByPath(
  payload: Payload,
  options: LlmsOptions,
  collections: CollectionConfig[],
  path: string,
  mediaURL?: string,
): Promise<LlmsDocument | undefined> {
  const slugValue = lastSegment(path)
  for (const { slug, source, config } of sources(payload, options, collections)) {
    const bySlug = hasField(config.fields, 'slug')
    if (bySlug && !slugValue) continue
    const docs = await queryCollection(payload, slug, config, source, bySlug ? { slug: { equals: slugValue } } : undefined)
    const mapped = docs.map((d) => mapDoc(d, slug, source, options, mediaURL)).filter((d): d is LlmsDocument => !!d)
    const match = findDocumentByPath(mapped, path)
    if (match) return match
  }
  return undefined
}

export function llmsSite(options: LlmsOptions) {
  return { name: options.name ?? options.siteURL, description: options.description, details: options.details }
}

export function renderLlms(options: LlmsOptions, docs: LlmsDocument[], full: boolean, notes: Record<string, string> = {}): string {
  return full
    ? buildLlmsFullTxt(llmsSite(options), docs, { maxBytes: options.fullMaxBytes, notes: Object.entries(notes).map(([k, v]) => `${k}: ${v}`) })
    : buildLlmsTxt(llmsSite(options), docs, { markdownLinks: options.markdownLinks, sectionNotes: notes })
}

export function renderMarkdown(doc: LlmsDocument): string {
  return documentMarkdown(doc)
}

export function jsonLdSite(options: LlmsOptions): JsonLdSite {
  return { name: options.name ?? options.siteURL, url: options.siteURL, logo: options.logo, language: options.language, organization: options.organization }
}

export function renderJsonLd(options: LlmsOptions, doc: LlmsDocument, omit: string[] = []): JsonLd | null {
  const data = buildJsonLd(jsonLdSite(options), doc)
  return data && omit.length ? omitJsonLdTypes(data, omit) : data
}
