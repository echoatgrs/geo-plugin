/**
 * llms.txt as described at https://llmstxt.org:
 *
 *   # Site name
 *   > One-line summary
 *   ## Section
 *   - [Title](url): description
 */
import { defaultConverter, type ContentConverter, type ConversionWarning } from './convert.js'
import { PRESET_FIELDS, isPresetType, type AuthorEntity, type BreadcrumbItem } from './schema.js'

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
  /** Canonical URL from the SEO / GEO fields, when it is set. JSON-LD uses it for `url` and `@id`. */
  canonical?: string | null
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
  /** Values of a preset type's properties (Product, HowTo, …), as mapped from the document. */
  schemaData?: Record<string, unknown>
  /** Field each preset property was read from. */
  schemaFields?: Record<string, string>
  /** `minor` when prices are in minor units. */
  priceUnit?: 'major' | 'minor'
  /** BreadcrumbList items. */
  breadcrumb?: BreadcrumbItem[]
  /** Authors with profile data, when `jsonLd.author` is configured. */
  authorEntities?: AuthorEntity[]
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
  if (doc.canonical && doc.canonical !== doc.url) lines.push(`Canonical: ${doc.canonical}`)
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

/** Reads a value from a document. Return `undefined` / `null` / `''` when there is none. */
export type FieldResolver = ((doc: Record<string, any>) => unknown) & { label?: string }

/** A field path (`meta.title`), a resolver function, or several of them tried in order. */
export type FieldSpec = string | FieldResolver | ReadonlyArray<string | FieldResolver>

/** Document properties the mapping fills, each from configured fields, SEO fields or the defaults. */
export type MappedProperty = 'title' | 'description' | 'content' | 'image' | 'author' | 'published' | 'updated' | 'canonical'

/**
 * Field paths of an SEO plugin or component. They are a fallback: explicit GEO fields come first, the
 * defaults last. The plugin only reads them, it never writes SEO fields.
 */
export type SeoFieldMap = Partial<Record<'title' | 'description' | 'image' | 'canonical' | 'author' | 'published', string | FieldResolver>>

/** Payload's official SEO plugin (`@payloadcms/plugin-seo`) with its default `meta` group. */
export const PAYLOAD_SEO_PLUGIN: SeoFieldMap = Object.freeze({ title: 'meta.title', description: 'meta.description', image: 'meta.image' })

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
   * Several content fields converted in this order and joined, e.g. `['intro', 'layout']` for a page builder.
   * Takes precedence over `contentField`.
   */
  contentFields?: string[]
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
  /**
   * Field paths or resolvers per property, tried in order. Same priority as the `*Field` options (which they
   * override): explicit fields, then `seo`, then the defaults. Use a function for computed values.
   */
  fields?: Partial<Record<MappedProperty, FieldSpec>>
  /** SEO fields to fall back on, e.g. `PAYLOAD_SEO_PLUGIN` or your Strapi SEO component's paths. */
  seo?: SeoFieldMap
  /** JSON-LD for each document. `false` turns it off. */
  jsonLd?: false | JsonLdSourceConfig
  /** Field holding the document's sources / references. Only the editor panel uses it, to check it is filled. */
  sourcesField?: string
}

export interface JsonLdSourceConfig {
  /**
   * schema.org type of the main node. Default `Article`. Article types: `BlogPosting`, `NewsArticle`, `TechArticle`, …;
   * `WebPage`; or a preset with its own field mapping and checks: `Product`, `HowTo`, `LocalBusiness`, `Person`,
   * `Organization` (see `fields`).
   */
  type?: string
  /** Extra properties merged into the main node, e.g. `(doc) => ({ keywords: doc.tags })`. */
  extend?: (doc: Record<string, any>) => Record<string, unknown> | null | undefined
  /**
   * Field mapping of a preset type: preset property → field path / resolver (see PRESET_FIELDS for the keys),
   * e.g. `{ price: 'price.amount', priceCurrency: 'price.currency', availability: 'stock' }`.
   * Unmapped properties use the preset's default field names; nothing is guessed from the body.
   */
  fields?: Record<string, FieldSpec>
  /** `minor`: prices are integer minor units (cents) and are divided exactly. Default `major` ("19.90"). */
  priceUnit?: 'major' | 'minor'
  /**
   * BreadcrumbList. `true`: home, `parents`, then the page. Or return the items yourself. Never inferred from the
   * URL alone, since a path segment isn't necessarily a page.
   */
  breadcrumb?: boolean | { homeName?: string; parents?: BreadcrumbItem[]; items?: (doc: Record<string, any>) => BreadcrumbItem[] | null | undefined }
  /**
   * Authors as Person nodes with stable `@id`s, linked from the article. Paths are read inside each author value;
   * `url` may also be a function of the author. Without it authors stay inline names as before.
   */
  author?: { url?: string | ((author: Record<string, any>) => string | null | undefined); image?: string; jobTitle?: string; sameAs?: string }
}

export function getField(doc: Record<string, any>, field: string): unknown {
  return field.split('.').reduce<any>((value, key) => {
    if (value == null) return undefined
    // Strapi 4 style `{ data: { attributes } }` wrappers on the way.
    if (typeof value === 'object' && !Array.isArray(value) && !(key in value) && value.data?.attributes) value = value.data.attributes
    return value[key]
  }, doc)
}

export type FieldOrigin = 'config' | 'seo' | 'default'

interface Candidate {
  label: string
  origin: FieldOrigin
  read: (doc: Record<string, any>) => unknown
}

function specList(spec: FieldSpec | undefined): Array<string | FieldResolver> {
  if (spec == null) return []
  return typeof spec === 'string' || typeof spec === 'function' ? [spec] : [...spec]
}

function candidate(entry: string | FieldResolver, origin: FieldOrigin): Candidate {
  if (typeof entry === 'string') return { label: entry, origin, read: (doc) => getField(doc, entry) }
  return { label: `${entry.label ?? (entry.name || 'resolver')}()`, origin, read: entry }
}

const DEFAULTS: Record<MappedProperty, string[]> = {
  title: ['title'],
  description: ['description', 'excerpt', 'summary', 'meta.description'],
  content: ['content', 'body'],
  image: ['image', 'heroImage', 'coverImage', 'cover', 'featuredImage', 'meta.image'],
  author: ['author', 'authors'],
  published: ['publishedAt', 'publishedDate', 'createdAt'],
  updated: ['updatedAt'],
  canonical: [],
}

const LEGACY: Partial<Record<MappedProperty, keyof LlmsSourceConfig>> = {
  title: 'titleField',
  description: 'descriptionField',
  content: 'contentField',
  image: 'imageField',
  author: 'authorField',
  published: 'publishedField',
}

/**
 * Where each property is read from, in order: explicit fields (`fields.x`, else the `xField` option), then the
 * `seo` map, then the built-in defaults when nothing explicit is configured. `title` always ends with `name`.
 */
export function fieldCandidates(source: LlmsSourceConfig): Record<MappedProperty, Candidate[]> {
  const out = {} as Record<MappedProperty, Candidate[]>
  for (const prop of Object.keys(DEFAULTS) as MappedProperty[]) {
    const legacyKey = LEGACY[prop]
    const legacy = legacyKey ? (source[legacyKey] as string | undefined) : undefined
    const explicit = specList(source.fields?.[prop] ?? legacy).map((e) => candidate(e, 'config'))
    const seoEntry = prop === 'content' || prop === 'updated' ? undefined : source.seo?.[prop as keyof SeoFieldMap]
    const seo = seoEntry ? [candidate(seoEntry, 'seo')] : []
    const defaults = explicit.length ? [] : DEFAULTS[prop].map((e) => candidate(e, 'default'))
    const list = [...explicit, ...seo, ...defaults]
    if (prop === 'title' && !list.some((c) => c.label === 'name')) list.push(candidate('name', 'default'))
    out[prop] = list
  }
  return out
}

/** Field paths the mapping looks at for each property, in order (resolver functions show as `name()`). */
export function sourceFields(source: LlmsSourceConfig) {
  const c = fieldCandidates(source)
  const labels = (p: MappedProperty) => c[p].map((x) => x.label)
  return {
    title: labels('title'),
    description: labels('description'),
    content: source.contentFields?.length ? [...source.contentFields] : labels('content'),
    image: labels('image'),
    author: labels('author'),
    published: labels('published'),
    updated: labels('updated'),
    canonical: labels('canonical'),
    faq: source.faqField ? [source.faqField] : [],
  }
}

function present(v: unknown): boolean {
  return v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
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

/** Display name of an author value (string or object). */
export function authorName(item: unknown): string {
  const a = unwrap(item)
  if (typeof a === 'string') return oneLine(a)
  if (a && typeof a === 'object') {
    const n = a.name ?? a.fullName ?? a.title ?? a.username ?? [a.firstName ?? a.firstname, a.lastName ?? a.lastname].filter(Boolean).join(' ')
    return typeof n === 'string' ? oneLine(n) : ''
  }
  return ''
}

function authorList(value: unknown): unknown[] {
  const v = unwrap(value)
  return (Array.isArray(v) ? v : [v]).map(unwrap).filter((a) => authorName(a))
}

/** URL schemes other than http(s): never output as links or images. */
const UNSAFE_SCHEME = /^(?!https?:)[a-z][a-z0-9+.-]*:/i

export function imageURL(value: unknown): string | undefined {
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

export interface LlmsMappingOptions {
  name: string
  siteURL: string
  source: LlmsSourceConfig
  /** Rich text to Markdown. Ignored when `converter` is set. Default: the built-in converter. */
  markdown?: (value: unknown) => string
  /** Content converter (built-in plus registered block converters). Its warnings are reported by the mapping. */
  converter?: ContentConverter
  /** Public URL of a related document, for links to it inside the content. */
  linkFor?: (doc: Record<string, any>, relationTo?: string) => string | null
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
  canonical: string | null
  faq: string | null
  /** Whether each found value came from the GEO config, the SEO fields or a default field. */
  origins: Partial<Record<MappedProperty, FieldOrigin>>
}

export interface LlmsMapping {
  document: LlmsDocument | null
  sources: LlmsMappingSources
  /** Frontend path or URL before it is joined with `siteURL`. */
  path: string | null
  /** Error thrown by the source's `url()` function. */
  urlError?: string
  /** Errors thrown by field resolver functions, by property. */
  fieldErrors?: Partial<Record<MappedProperty, string>>
  /** Raw rich text value found for the content, before conversion (a list with `contentFields`). */
  rawContent: unknown
  /** Raw FAQ items before empty ones are dropped. */
  rawFaq: unknown[] | null
  /** The converted content, also when the document has no URL (the editor preview still shows it). */
  markdown: string
  /** Warnings of the content converter (unknown blocks, limits, unavailable relations). */
  conversion: { warnings: ConversionWarning[]; truncated: boolean }
}

/**
 * Maps a CMS document like {@link toLlmsDocument}, and also reports which field each value came from.
 * Used by the editor checks and previews, so they explain exactly what the public output does.
 */
export function mapLlmsDocument(doc: Record<string, any>, options: LlmsMappingOptions, strict = false): LlmsMapping {
  const { source } = options
  const candidates = fieldCandidates(source)
  const fieldErrors: Partial<Record<MappedProperty, string>> = {}
  const origins: Partial<Record<MappedProperty, FieldOrigin>> = {}
  const pick = (prop: MappedProperty, accept: (v: unknown) => boolean = present): { value: unknown; field: string | null } => {
    for (const c of candidates[prop]) {
      let v: unknown
      try {
        v = c.read(doc)
      } catch (error) {
        if (strict) throw error
        fieldErrors[prop] = error instanceof Error ? error.message : String(error)
        continue
      }
      if (accept(v)) {
        origins[prop] = c.origin
        return { value: v, field: c.label }
      }
    }
    return { value: undefined, field: null }
  }
  const isText = (v: unknown) => typeof v === 'string' && v.trim() !== ''

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

  const converter = options.converter
  const warnings: ConversionWarning[] = []
  let truncated = false
  const toMarkdown = (value: unknown, at: string): string => {
    if (converter) {
      const result = converter.convert(value, { mediaURL: options.mediaURL, path: at, linkFor: options.linkFor })
      warnings.push(...result.warnings)
      truncated ||= result.truncated
      return result.markdown
    }
    return (options.markdown ?? defaultConverter.toMarkdown)(value)
  }

  const title = pick('title', isText)
  const description = pick('description', isText)
  let content: { value: unknown; field: string | null }
  let markdown: string
  if (source.contentFields?.length) {
    const found = source.contentFields.filter((f) => getField(doc, f) != null)
    content = { value: found.map((f) => getField(doc, f)), field: found.length ? found.join(', ') : null }
    if (found.length) origins.content = 'config'
    markdown = found.map((f) => toMarkdown(getField(doc, f), f)).filter((m) => m.trim()).join('\n\n')
  } else {
    content = pick('content', (v) => v != null)
    markdown = content.field ? toMarkdown(content.value, content.field) : toMarkdown(undefined, '')
  }
  const image = pick('image', (v) => !!imageURL(v))
  const imageValue = imageURL(image.value)
  const author = pick('author')
  const published = pick('published', (v) => present(v))
  const updated = pick('updated', (v) => !!dateString(v))
  const canonical = pick('canonical', isText)
  const faqValue = source.faqField ? unwrap(getField(doc, source.faqField)) : undefined
  const rawFaq = Array.isArray(faqValue) ? faqValue : null
  const faq = rawFaq
    ? rawFaq
        .map((item: any, i) => ({ question: oneLine(String(item?.question ?? '')), answer: toMarkdown(item?.answer, `${source.faqField}[${i}].answer`).trim() }))
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
    updated: updated.field,
    canonical: canonical.field,
    faq: rawFaq ? source.faqField! : null,
    origins,
  }
  const base = {
    sources,
    path,
    urlError,
    ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}),
    rawContent: content.value,
    rawFaq,
    markdown,
    conversion: { warnings, truncated },
  }
  if (!path) return { ...base, document: null }
  let extra: Record<string, unknown> | undefined
  try {
    extra = jsonLd?.extend?.(doc) ?? undefined
  } catch (error) {
    if (strict) throw error
    extra = undefined
  }
  const url = joinURL(options.siteURL, path)
  const canonicalURL = typeof canonical.value === 'string' ? joinURL(options.siteURL, canonical.value.trim()) : null
  const media = (v: unknown) => {
    const u = imageURL(v)
    return u && !UNSAFE_SCHEME.test(u) ? joinURL(options.mediaURL ?? options.siteURL, u) : undefined
  }
  const plainText = (v: unknown, at: string) => {
    if (v == null || typeof v === 'string' || typeof v === 'number') return v
    if (typeof v === 'object' && !Array.isArray(v) && typeof (v as any).name === 'string' && !(v as any).root) return (v as any).name
    return toMarkdown(v, at).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`#>]/g, '').replace(/\s+/g, ' ').trim() || null
  }
  let schemaData: Record<string, unknown> | undefined
  let schemaFields: Record<string, string> | undefined
  if (jsonLd && isPresetType(jsonLd.type)) {
    schemaData = {}
    schemaFields = {}
    for (const [prop, def] of Object.entries(PRESET_FIELDS[jsonLd.type])) {
      const spec = jsonLd.fields?.[prop]
      const list = spec != null ? specList(spec) : (def.defaults ?? [])
      let value: unknown
      for (const entry of list) {
        const c = candidate(entry, spec != null ? 'config' : 'default')
        try {
          value = c.read(doc)
        } catch (error) {
          if (strict) throw error
          value = undefined
        }
        if (present(value)) {
          schemaFields[prop] = c.label
          break
        }
      }
      if (!present(value)) continue
      if (def.kind === 'text') value = plainText(value, schemaFields[prop]!)
      else if (def.kind === 'image') value = media(value)
      else if (def.kind === 'images') value = (Array.isArray(value) ? value : [value]).map(media).filter(Boolean)
      else if (def.kind === 'list' && Array.isArray(value))
        value = value.map((item, i) => {
          if (!item || typeof item !== 'object') return item
          const out: Record<string, unknown> = { ...(item as object) }
          for (const k of ['text', 'body', 'description', 'content']) if (out[k] != null && typeof out[k] !== 'string') out[k] = plainText(out[k], `${schemaFields![prop]}[${i}].${k}`)
          if (out.image != null) out.image = media(out.image)
          return out
        })
      if (present(value)) schemaData[prop] = value
    }
    // Defaults from the document itself; the URL-path fallback title is never used as a name.
    if (schemaData.name === undefined && typeof title.value === 'string') schemaData.name = title.value
    if (schemaData.description === undefined && typeof description.value === 'string') schemaData.description = description.value
    const img = media(image.value)
    if (img) {
      if (jsonLd.type === 'Organization') schemaData.logo ??= img
      else schemaData.image ??= jsonLd.type === 'Person' ? img : [img]
    }
  }
  const pageURL = canonicalURL ?? url
  let breadcrumb: BreadcrumbItem[] | undefined
  if (jsonLd?.breadcrumb) {
    const cfg = jsonLd.breadcrumb === true ? {} : jsonLd.breadcrumb
    try {
      breadcrumb = cfg.items
        ? (cfg.items(doc) ?? undefined)
        : [{ name: cfg.homeName ?? 'Home', url: options.siteURL }, ...(cfg.parents ?? []), { name: typeof title.value === 'string' ? oneLine(title.value) : path, url: pageURL }]
    } catch (error) {
      if (strict) throw error
    }
  }
  let authorEntities: AuthorEntity[] | undefined
  if (jsonLd?.author) {
    const a = jsonLd.author
    authorEntities = authorList(author.value).map((item) => {
      const obj = item && typeof item === 'object' ? (item as Record<string, any>) : {}
      let profile: unknown
      try {
        profile = typeof a.url === 'function' ? a.url(obj) : a.url ? getField(obj, a.url) : undefined
      } catch {
        profile = undefined
      }
      const sameAs = a.sameAs ? getField(obj, a.sameAs) : undefined
      return {
        name: authorName(item),
        url: typeof profile === 'string' ? joinURL(options.siteURL, profile) : null,
        image: a.image ? (media(getField(obj, a.image)) ?? null) : null,
        jobTitle: a.jobTitle && typeof getField(obj, a.jobTitle) === 'string' ? (getField(obj, a.jobTitle) as string) : null,
        sameAs: (Array.isArray(sameAs) ? sameAs : sameAs ? [sameAs] : []).map((v: any) => (typeof v === 'string' ? v : v?.url)).filter((v): v is string => typeof v === 'string'),
      }
    })
  }
  return {
    ...base,
    document: {
      title: typeof title.value === 'string' ? title.value : path,
      url,
      ...(canonicalURL ? { canonical: canonicalURL } : {}),
      description: typeof description.value === 'string' ? description.value : null,
      section: source.section ?? options.name,
      markdown,
      updatedAt: dateString(updated.value),
      publishedAt: dateString(published.value),
      authors: authorList(author.value).map(authorName),
      image: imageValue && !UNSAFE_SCHEME.test(imageValue) ? joinURL(options.mediaURL ?? options.siteURL, imageValue) : null,
      faq,
      schemaType: source.jsonLd === false ? undefined : (jsonLd?.type ?? 'Article'),
      jsonLd: extra,
      ...(schemaData ? { schemaData, schemaFields, ...(jsonLd?.priceUnit ? { priceUnit: jsonLd.priceUnit } : {}) } : {}),
      ...(breadcrumb ? { breadcrumb } : {}),
      ...(authorEntities ? { authorEntities } : {}),
    },
  }
}

/** Public URL of a document of a configured source (for links between documents), or null. Never throws. */
export function documentURL(doc: Record<string, any>, name: string, source: LlmsSourceConfig, siteURL: string): string | null {
  try {
    const path = source.url ? source.url(doc) : typeof doc.slug === 'string' && doc.slug ? `/${name}/${doc.slug}` : null
    return path ? joinURL(siteURL, path) : null
  } catch {
    return null
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
