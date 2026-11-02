/**
 * llms.txt as described at https://llmstxt.org:
 *
 *   # Site name
 *   > One-line summary
 *   ## Section
 *   - [Title](url): description
 */

export interface LlmsSite {
  name: string
  description?: string
  /** Optional free text placed after the summary. */
  details?: string
}

export interface LlmsDocument {
  title: string
  /** Absolute URL of the page on the frontend. */
  url: string
  description?: string | null
  /** Section heading the document is listed under, e.g. `Blog`. */
  section?: string
  /** Full content as Markdown, used by llms-full.txt. */
  markdown?: string
  /** ISO date, shown in llms-full.txt when present. */
  updatedAt?: string | null
  /** ISO date the document was first published. */
  publishedAt?: string | null
  /** Author names. */
  authors?: string[]
  /** Absolute URL of the main image. */
  image?: string | null
  /** Question and answer pairs, rendered as FAQPage JSON-LD. */
  faq?: { question: string; answer: string }[]
  /** schema.org type for JSON-LD, e.g. `BlogPosting`. Default `Article`. */
  schemaType?: string
  /** Extra JSON-LD properties merged into the main node. */
  jsonLd?: Record<string, unknown>
}

function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

/** Title, metadata lines, summary and body of one document. Shared by llms-full.txt and per-page Markdown. */
export function documentMarkdown(doc: LlmsDocument): string {
  const lines = [`# ${oneLine(doc.title)}`, '', `URL: ${doc.url}`]
  if (doc.publishedAt) lines.push(`Published: ${doc.publishedAt.slice(0, 10)}`)
  if (doc.updatedAt) lines.push(`Updated: ${doc.updatedAt.slice(0, 10)}`)
  if (doc.authors?.length) lines.push(`Author: ${doc.authors.join(', ')}`)
  lines.push('')
  if (doc.description) lines.push(`> ${oneLine(doc.description)}`, '')
  if (doc.markdown) lines.push(doc.markdown.trim(), '')
  if (doc.faq?.length) {
    lines.push('## FAQ', '')
    for (const item of doc.faq) lines.push(`### ${oneLine(item.question)}`, '', item.answer.trim(), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

function header(site: LlmsSite): string[] {
  const lines = [`# ${oneLine(site.name)}`, '']
  if (site.description) lines.push(`> ${oneLine(site.description)}`, '')
  if (site.details) lines.push(site.details.trim(), '')
  return lines
}

function groupBySection(docs: LlmsDocument[]): Map<string, LlmsDocument[]> {
  const sections = new Map<string, LlmsDocument[]>()
  for (const doc of docs) {
    const key = doc.section || 'Pages'
    sections.set(key, [...(sections.get(key) ?? []), doc])
  }
  return sections
}

export interface LlmsTxtOptions {
  /** Link each entry to its Markdown version (`/blog/post.md`), as llmstxt.org suggests. Default false. */
  markdownLinks?: boolean
}

/** `https://site/blog/post` -> `https://site/blog/post.md`, and the site root -> `/index.md`. */
export function markdownURL(url: string): string {
  const [base, rest = ''] = url.split(/(?=[?#])/)
  const path = base!.replace(/\/+$/, '')
  const md = /^https?:\/\/[^/]+$/i.test(path) || path === '' ? `${path}/index.md` : `${path}.md`
  return md + rest
}

export function buildLlmsTxt(site: LlmsSite, docs: LlmsDocument[], options: LlmsTxtOptions = {}): string {
  const lines = header(site)
  for (const [section, items] of groupBySection(docs)) {
    lines.push(`## ${section}`, '')
    for (const doc of items) {
      const desc = oneLine(doc.description)
      const url = options.markdownLinks ? markdownURL(doc.url) : doc.url
      lines.push(`- [${escapeLinkText(oneLine(doc.title))}](${url})${desc ? `: ${desc}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Every document's full Markdown in one file, for assistants that read a single URL. */
export function buildLlmsFullTxt(site: LlmsSite, docs: LlmsDocument[]): string {
  const lines = header(site)
  for (const doc of docs) lines.push('---', '', documentMarkdown(doc))
  return lines.join('\n').trimEnd() + '\n'
}

/** Joins a site URL and a path without doubling or dropping slashes. */
export function joinURL(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// ---------- Shared document mapping ----------

export interface LlmsSourceConfig {
  /** Section heading in llms.txt. Defaults to the collection / content type name. */
  section?: string
  /** Field holding the title. Default `title`. */
  titleField?: string
  /** Field holding a short summary. Default: first of `description`, `excerpt`, `summary`. */
  descriptionField?: string
  /** Rich text or Markdown field used for llms-full.txt. Default: first of `content`, `body`. */
  contentField?: string
  /**
   * Frontend path or absolute URL of a document.
   * Default: `/<collection>/<slug>` when the document has a `slug`.
   */
  url?: (doc: Record<string, any>) => string | null | undefined
  /** Field holding the author: a string, `{ name }`, or a list of either. Default: first of `author`, `authors`. */
  authorField?: string
  /** Field holding the main image: a URL or an upload / media object with `url`. Default: first of `image`, `heroImage`, `coverImage`, `cover`, `featuredImage`, `meta.image`. */
  imageField?: string
  /** Field holding the first publish date. Default: first of `publishedAt`, `publishedDate`, `createdAt`. */
  publishedField?: string
  /** Field holding a list of `{ question, answer }`, rendered as FAQPage JSON-LD and a FAQ section in Markdown. */
  faqField?: string
  /** JSON-LD for each document. `false` turns it off. */
  jsonLd?: false | JsonLdSourceConfig
  /** Field holding the document's sources / references. Only the editor panel uses it, to check it is filled. */
  sourcesField?: string
}

export interface JsonLdSourceConfig {
  /** schema.org type of the main node. Default `Article`. Common: `BlogPosting`, `NewsArticle`, `TechArticle`, `WebPage`. */
  type?: string
  /** Extra properties merged into the main node, e.g. `(doc) => ({ keywords: doc.tags })`. */
  extend?: (doc: Record<string, any>) => Record<string, unknown> | null | undefined
}

export function getField(doc: Record<string, any>, field: string): unknown {
  return field.split('.').reduce<any>((value, key) => (value == null ? undefined : value[key]), doc)
}

/** First non-empty value among the field paths, and the path it came from. */
function firstEntry(doc: Record<string, any>, fields: string[]): { value: unknown; field: string | null } {
  for (const f of fields) {
    const v = getField(doc, f)
    if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) return { value: v, field: f }
  }
  return { value: undefined, field: null }
}

function firstValue(doc: Record<string, any>, fields: string[]): unknown {
  return firstEntry(doc, fields).value
}

/** Strapi 4 wraps relations as `{ data: { attributes } }`; unwrap them. */
function unwrap(value: any): any {
  if (value && typeof value === 'object' && 'data' in value && !Array.isArray(value)) {
    const data = value.data
    if (Array.isArray(data)) return data.map((d) => (d?.attributes ? { ...d.attributes } : d))
    return data?.attributes ?? data
  }
  return value
}

function names(value: unknown): string[] {
  const v = unwrap(value)
  const list = Array.isArray(v) ? v : [v]
  return list
    .map((a: any) => {
      const item = unwrap(a)
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return item.name ?? item.fullName ?? item.title ?? item.username ?? [item.firstName, item.lastName].filter(Boolean).join(' ')
      return ''
    })
    .map((n: unknown) => (typeof n === 'string' ? oneLine(n) : ''))
    .filter(Boolean)
}

function imageURL(value: unknown): string | undefined {
  let v = unwrap(value)
  if (Array.isArray(v)) v = unwrap(v[0])
  if (typeof v === 'string') return v || undefined
  if (v && typeof v === 'object' && typeof v.url === 'string') return v.url
  return undefined
}

function dateString(value: unknown): string | null {
  if (typeof value === 'string' && value) return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return null
}

function firstStringEntry(doc: Record<string, any>, fields: string[]): { value: string | undefined; field: string | null } {
  for (const f of fields) {
    const v = getField(doc, f)
    if (typeof v === 'string' && v.trim()) return { value: v, field: f }
  }
  return { value: undefined, field: null }
}

/** Field paths the mapping looks at for each property, in order. Configured fields replace the defaults. */
export function sourceFields(source: LlmsSourceConfig) {
  return {
    title: [source.titleField ?? 'title', 'name'],
    description: source.descriptionField ? [source.descriptionField] : ['description', 'excerpt', 'summary', 'meta.description'],
    content: source.contentField ? [source.contentField] : ['content', 'body'],
    image: source.imageField ? [source.imageField] : ['image', 'heroImage', 'coverImage', 'cover', 'featuredImage', 'meta.image'],
    author: source.authorField ? [source.authorField] : ['author', 'authors'],
    published: source.publishedField ? [source.publishedField] : ['publishedAt', 'publishedDate', 'createdAt'],
    updated: ['updatedAt'],
    faq: source.faqField ? [source.faqField] : [],
  }
}

export interface LlmsMappingOptions {
  name: string
  siteURL: string
  source: LlmsSourceConfig
  markdown: (value: unknown) => string
  /** Base for relative image URLs, e.g. the CMS URL. Default `siteURL`. */
  mediaURL?: string
}

/** Which field each property of a mapped document came from (`null`: none found, a fallback applies). */
export interface LlmsMappingSources {
  url: 'url()' | 'slug' | null
  title: string | null
  description: string | null
  content: string | null
  image: string | null
  author: string | null
  published: string | null
  updated: string | null
  faq: string | null
}

export interface LlmsMapping {
  document: LlmsDocument | null
  sources: LlmsMappingSources
  /** Frontend path or URL before it is joined with `siteURL`. */
  path: string | null
  /** Error thrown by the source's `url()` function. */
  urlError?: string
  /** Raw rich text value found for the content, before conversion. */
  rawContent: unknown
  /** Raw FAQ items before empty ones are dropped. */
  rawFaq: unknown[] | null
}

/**
 * Maps a CMS document like {@link toLlmsDocument}, and also reports which field each value came from.
 * Used by the editor checks and previews, so they explain exactly what the public output does.
 */
export function mapLlmsDocument(doc: Record<string, any>, options: LlmsMappingOptions, strict = false): LlmsMapping {
  const { source } = options
  const fields = sourceFields(source)
  let path: string | null = null
  let urlSource: LlmsMappingSources['url'] = null
  let urlError: string | undefined
  if (source.url) {
    try {
      path = source.url(doc) ?? null
      urlSource = 'url()'
    } catch (error) {
      if (strict) throw error
      urlError = error instanceof Error ? error.message : String(error)
    }
  } else if (typeof doc.slug === 'string' && doc.slug) {
    path = `/${options.name}/${doc.slug}`
    urlSource = 'slug'
  }
  const title = firstStringEntry(doc, fields.title)
  const description = firstStringEntry(doc, fields.description)
  const content = (() => {
    for (const f of fields.content) {
      const v = getField(doc, f)
      if (v != null) return { value: v, field: f }
    }
    return { value: undefined, field: null }
  })()
  const image = firstEntry(doc, fields.image)
  const imageValue = imageURL(image.value)
  const author = firstEntry(doc, fields.author)
  const published = firstEntry(doc, fields.published)
  const faqValue = source.faqField ? unwrap(getField(doc, source.faqField)) : undefined
  const rawFaq = Array.isArray(faqValue) ? faqValue : null
  const faq = rawFaq
    ? rawFaq
        .map((item: any) => ({ question: oneLine(String(item?.question ?? '')), answer: options.markdown(item?.answer).trim() }))
        .filter((item) => item.question && item.answer)
    : []
  const jsonLd = source.jsonLd === false ? undefined : source.jsonLd
  const sources: LlmsMappingSources = {
    url: path ? urlSource : null,
    title: title.field,
    description: description.field,
    content: content.field,
    image: imageValue ? image.field : null,
    author: author.field,
    published: dateString(published.value) ? published.field : null,
    updated: dateString(doc.updatedAt) ? 'updatedAt' : null,
    faq: rawFaq ? source.faqField! : null,
  }
  const base = { sources, path, urlError, rawContent: content.value, rawFaq }
  if (!path) return { ...base, document: null }
  let extra: Record<string, unknown> | undefined
  try {
    extra = jsonLd?.extend?.(doc) ?? undefined
  } catch (error) {
    if (strict) throw error
    extra = undefined
  }
  return {
    ...base,
    document: {
      title: title.value ?? path,
      url: joinURL(options.siteURL, path),
      description: description.value ?? null,
      section: source.section ?? options.name,
      markdown: options.markdown(content.value),
      updatedAt: dateString(doc.updatedAt),
      publishedAt: dateString(published.value),
      authors: names(author.value),
      image: imageValue ? joinURL(options.mediaURL ?? options.siteURL, imageValue) : null,
      faq,
      schemaType: source.jsonLd === false ? undefined : (jsonLd?.type ?? 'Article'),
      jsonLd: extra,
    },
  }
}

/**
 * Maps a CMS document to an llms document. Returns null when no URL can be determined,
 * since an entry without a URL is useless to an assistant.
 */
export function toLlmsDocument(doc: Record<string, any>, options: LlmsMappingOptions): LlmsDocument | null {
  // Strict: a throwing `url()` or `jsonLd.extend()` surfaces as an error on the public routes, as before.
  return mapLlmsDocument(doc, options, true).document
}

/** Frontend path of a `.md` request: `/blog/post.md` -> `/blog/post`, `/index.md` -> `/`. Null if not a `.md` path. */
export function markdownSourcePath(pathname: string): string | null {
  if (!/\.md$/i.test(pathname)) return null
  const path = pathname.replace(/\.md$/i, '')
  return path === '/index' || path === '' ? '/' : path
}
