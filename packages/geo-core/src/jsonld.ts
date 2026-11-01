import type { LlmsDocument } from './llms.js'
import { joinURL } from './llms.js'
import { normalizePath } from './stats.js'

export interface JsonLdSite {
  name: string
  /** Public URL of the frontend. */
  url: string
  /** Logo URL (absolute, or a path on the site). Used for `publisher.logo`. */
  logo?: string
  /** BCP 47 language of the content, e.g. `en` or `zh-CN`. */
  language?: string
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

/**
 * schema.org JSON-LD for one document: the main node (Article, BlogPosting, WebPage, ...) plus FAQPage
 * when the document has questions. Returns null when JSON-LD is turned off for the document's source.
 */
export function buildJsonLd(site: JsonLdSite, doc: LlmsDocument): JsonLd | null {
  if (!doc.schemaType) return null
  const isArticle = ARTICLE_TYPES.has(doc.schemaType)
  const publisher: JsonLd = { '@type': 'Organization', name: site.name, url: site.url }
  if (site.logo) publisher.logo = { '@type': 'ImageObject', url: joinURL(site.url, site.logo) }

  const main: JsonLd = {
    '@type': doc.schemaType,
    '@id': `${doc.url}#${isArticle ? 'article' : 'webpage'}`,
    [isArticle ? 'headline' : 'name']: isArticle ? doc.title.slice(0, 110) : doc.title,
    url: doc.url,
  }
  if (doc.description) main.description = doc.description.replace(/\s+/g, ' ').trim()
  if (isArticle) main.mainEntityOfPage = { '@type': 'WebPage', '@id': doc.url }
  if (doc.image) main.image = [doc.image]
  if (doc.publishedAt) main.datePublished = doc.publishedAt
  // Strapi sets publishedAt on every publish, a few ms after updatedAt; dateModified must not precede it.
  const modified = [doc.updatedAt, doc.publishedAt].filter((d): d is string => !!d).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  if (modified) main.dateModified = modified
  if (doc.authors?.length) main.author = doc.authors.map((name) => ({ '@type': 'Person', name }))
  else if (isArticle) main.author = { '@type': 'Organization', name: site.name, url: site.url }
  if (isArticle) main.publisher = publisher
  else main.isPartOf = { '@type': 'WebSite', name: site.name, url: site.url }
  if (site.language) main.inLanguage = site.language
  Object.assign(main, doc.jsonLd)

  const graph: JsonLd[] = [main]
  if (doc.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${doc.url}#faq`,
      mainEntity: doc.faq.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: plain(item.answer) },
      })),
    })
  }
  return { '@context': 'https://schema.org', '@graph': graph }
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
