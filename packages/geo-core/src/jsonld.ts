import type { LlmsDocument } from './llms.js'
import { joinURL } from './llms.js'
import { normalizePath } from './stats.js'
import { authorNode, breadcrumbNode, buildPresetNode, isPresetType, organizationNode, type OrganizationConfig, type SchemaIssue } from './schema.js'

export interface JsonLdSite {
  name: string
  /** Public URL of the frontend. */
  url: string
  /** Logo URL (absolute, or a path on the site). Used for `publisher.logo`. */
  logo?: string
  /** BCP 47 language of the content, e.g. `en` or `zh-CN`. */
  language?: string
  /**
   * The site's organization as its own node with a stable `@id`, used as the publisher of every article (and by
   * other nodes). Without it the publisher stays an inline Organization with the site name, as before.
   */
  organization?: OrganizationConfig
}

export type JsonLd = Record<string, unknown>

const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'Report'])

function plain(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface JsonLdBuild {
  data: JsonLd | null
  /** Why nodes or properties were left out. Errors drop the node; warnings drop a property or are suggestions. */
  issues: SchemaIssue[]
}

/**
 * schema.org JSON-LD for one document and why anything was left out. The graph holds the main node (an article
 * type, WebPage, or a preset such as Product), FAQPage when the document has questions, BreadcrumbList, the site
 * Organization and author Persons when configured. Nodes refer to each other by stable `@id`.
 */
export function buildJsonLdDetailed(site: JsonLdSite, doc: LlmsDocument): JsonLdBuild {
  if (!doc.schemaType) return { data: null, issues: [] }
  const issues: SchemaIssue[] = []
  const pageURL = doc.canonical ?? doc.url
  const graph: JsonLd[] = []
  const extraNodes: JsonLd[] = []

  let org: JsonLd | null = null
  if (site.organization) {
    const built = organizationNode(site.organization, site.url)
    issues.push(...built.issues)
    org = built.node
  }

  let main: JsonLd | null = null
  if (isPresetType(doc.schemaType)) {
    const data: Record<string, unknown> = { ...doc.schemaData }
    const built = buildPresetNode(doc.schemaType, data, { url: pageURL, siteURL: site.url, fieldOf: doc.schemaFields, priceUnit: doc.priceUnit })
    issues.push(...built.issues)
    main = built.node
    if (main && doc.jsonLd) Object.assign(main, doc.jsonLd)
  } else {
    const isArticle = ARTICLE_TYPES.has(doc.schemaType)
    main = {
      '@type': doc.schemaType,
      '@id': `${pageURL}#${isArticle ? 'article' : 'webpage'}`,
      [isArticle ? 'headline' : 'name']: isArticle ? doc.title.slice(0, 110) : doc.title,
      url: pageURL,
    }
    if (doc.description) main.description = doc.description.replace(/\s+/g, ' ').trim()
    if (isArticle) main.mainEntityOfPage = { '@type': 'WebPage', '@id': pageURL }
    if (doc.image) main.image = [doc.image]
    if (doc.publishedAt) main.datePublished = doc.publishedAt
    // Strapi sets publishedAt on every publish, a few ms after updatedAt; dateModified must not precede it.
    const modified = [doc.updatedAt, doc.publishedAt].filter((d): d is string => !!d).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    if (modified) main.dateModified = modified
    const people = (doc.authorEntities ?? []).map((a) => authorNode(a, site.url))
    for (const p of people) issues.push(...p.issues)
    const personNodes = people.map((p) => p.node).filter((n): n is JsonLd => !!n)
    if (personNodes.length) {
      main.author = personNodes.map((n) => ({ '@id': n['@id'] }))
      extraNodes.push(...personNodes)
    } else if (doc.authors?.length) main.author = doc.authors.map((name) => ({ '@type': 'Person', name }))
    else if (isArticle) main.author = org ? { '@id': org['@id'] } : { '@type': 'Organization', name: site.name, url: site.url }
    if (isArticle) {
      if (org) main.publisher = { '@id': org['@id'] }
      else {
        const publisher: JsonLd = { '@type': 'Organization', name: site.name, url: site.url }
        if (site.logo) publisher.logo = { '@type': 'ImageObject', url: joinURL(site.url, site.logo) }
        main.publisher = publisher
      }
    } else main.isPartOf = { '@type': 'WebSite', name: site.name, url: site.url }
    if (site.language) main.inLanguage = site.language
    Object.assign(main, doc.jsonLd)
  }
  if (main) graph.push(main)

  if (doc.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${pageURL}#faq`,
      mainEntity: doc.faq.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: plain(item.answer) },
      })),
    })
  }
  if (doc.breadcrumb) {
    const built = breadcrumbNode(doc.breadcrumb, pageURL, site.url)
    issues.push(...built.issues)
    if (built.node) graph.push(built.node)
  }
  if (org && !graph.some((n) => n['@id'] === org!['@id'])) graph.push(org)
  for (const n of extraNodes) if (!graph.some((g) => g['@id'] === n['@id'])) graph.push(n)
  return { data: graph.length ? { '@context': 'https://schema.org', '@graph': graph } : null, issues }
}

/**
 * schema.org JSON-LD for one document: the main node (Article, BlogPosting, WebPage, Product, ...) plus FAQPage
 * when the document has questions. Returns null when JSON-LD is turned off for the document's source.
 */
export function buildJsonLd(site: JsonLdSite, doc: LlmsDocument): JsonLd | null {
  return buildJsonLdDetailed(site, doc).data
}

/** JSON for a `<script type="application/ld+json">` tag, with `<` escaped so content cannot close the tag. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/** The document whose URL has this path (query, hash, origin and trailing slash ignored). */
export function findDocumentByPath<T extends Pick<LlmsDocument, 'url'>>(docs: T[], path: string): T | undefined {
  const wanted = normalizePath(path)
  return docs.find((d) => normalizePath(d.url) === wanted)
}

/** Last path segment, decoded: the slug candidate for a lookup by path. */
export function lastSegment(path: string): string | null {
  const segment = normalizePath(path).split('/').pop()
  if (!segment) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
