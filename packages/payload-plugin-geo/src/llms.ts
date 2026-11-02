import {
  buildJsonLd,
  buildLlmsFullTxt,
  buildLlmsTxt,
  documentMarkdown,
  findDocumentByPath,
  lastSegment,
  richTextToMarkdown,
  toLlmsDocument,
  type CheckThresholds,
  type JsonLd,
  type LlmsDocument,
  type LlmsSourceConfig,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Field, Payload, Where } from 'payload'

export interface PayloadLlmsSource extends LlmsSourceConfig {
  /** Extra filter, e.g. `{ noindex: { not_equals: true } }`. */
  where?: Where
  /** Max documents from this collection. Default 500. */
  limit?: number
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
  /** Other hosts of the same site (e.g. `www.example.com`), counted with `siteURL`'s host in per-page visits. */
  hosts?: string[]
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

export async function queryCollection(
  payload: Payload,
  slug: string,
  config: CollectionConfig,
  source: PayloadLlmsSource,
  extra?: Where,
): Promise<Record<string, any>[]> {
  const filters: Where[] = []
  if (source.where) filters.push(source.where)
  if (typeof config.versions === 'object' && config.versions.drafts) filters.push({ _status: { equals: 'published' } })
  if (extra) filters.push(extra)
  try {
    const result = await payload.find({
      collection: slug as never,
      where: filters.length ? { and: filters } : undefined,
      limit: source.limit ?? 500,
      depth: 1,
      // Anonymous read: only content the public can already see is served.
      overrideAccess: false,
      sort: '-updatedAt',
    })
    return result.docs as Record<string, any>[]
  } catch (error) {
    // Payload throws Forbidden when the public can't read the collection at all: list nothing from it.
    if ((error as { status?: number })?.status === 403) return []
    throw error
  }
}

export function mapDoc(doc: Record<string, any>, slug: string, source: PayloadLlmsSource, options: LlmsOptions, mediaURL?: string) {
  return toLlmsDocument(doc, {
    name: slug,
    siteURL: options.siteURL,
    source,
    markdown: richTextToMarkdown,
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

export async function loadLlmsDocuments(
  payload: Payload,
  options: LlmsOptions,
  collections: CollectionConfig[],
  mediaURL?: string,
): Promise<LlmsDocument[]> {
  const docs: LlmsDocument[] = []
  for (const { slug, source, config } of sources(payload, options, collections)) {
    for (const doc of await queryCollection(payload, slug, config, source)) {
      const mapped = mapDoc(doc, slug, source, options, mediaURL)
      if (mapped) docs.push(mapped)
    }
  }
  return docs
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

function site(options: LlmsOptions) {
  return { name: options.name ?? options.siteURL, description: options.description, details: options.details }
}

export function renderLlms(options: LlmsOptions, docs: LlmsDocument[], full: boolean): string {
  return full ? buildLlmsFullTxt(site(options), docs) : buildLlmsTxt(site(options), docs, { markdownLinks: options.markdownLinks })
}

export function renderMarkdown(doc: LlmsDocument): string {
  return documentMarkdown(doc)
}

export function renderJsonLd(options: LlmsOptions, doc: LlmsDocument): JsonLd | null {
  return buildJsonLd(
    { name: options.name ?? options.siteURL, url: options.siteURL, logo: options.logo, language: options.language },
    doc,
  )
}
