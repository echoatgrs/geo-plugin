/**
 * Deterministic GEO checks for one document, shared by the Payload and Strapi editor panels.
 *
 * These are editing suggestions based on the plugin's own output rules. They are not search engine
 * requirements, they don't predict whether an AI will cite the page, and "pass" only means the
 * plugin's rule passed.
 */
import { buildJsonLd, serializeJsonLd, type JsonLd, type JsonLdSite } from './jsonld.js'
import { documentMarkdown, getField, mapLlmsDocument, sourceFields, type LlmsDocument, type LlmsMappingOptions, type LlmsMappingSources } from './llms.js'

export type CheckStatus = 'pass' | 'warning' | 'error' | 'notApplicable'

export interface CheckResult {
  /** Stable id, e.g. `GEO-TITLE`. */
  ruleId: string
  status: CheckStatus
  message: string
  /** Document field the result is about, when there is one. */
  fieldPath?: string
  suggestion: string
}

export interface CheckThresholds {
  /** Shorter descriptions get a suggestion. Default 50 characters. */
  descriptionMin?: number
  /** Longer descriptions get a suggestion. Default 300 characters. */
  descriptionMax?: number
  /** Longer titles are cut in JSON-LD `headline`. Default 110 characters. */
  titleMax?: number
  /** Bodies with at least this many characters get the subheading suggestion. Default 1500. */
  headingsAfter?: number
}

/** What the adapter knows about where the document stands. `null` means it can't tell yet. */
export interface DocumentState {
  /** False for a document that was never saved. */
  saved: boolean
  /** Has a published version (draft & publish), or `true` for collections without drafts. `null`: unknown. */
  published: boolean | null
  /** The published version is readable by anonymous visitors through the public outputs. `null`: unknown. */
  publicVisible: boolean | null
  /** Why the document isn't public, shown to the editor. */
  publicReason?: string
}

export interface InspectOptions extends LlmsMappingOptions {
  site: JsonLdSite
  /** Field holding the sources / references of the document, only checked when set. */
  sourcesField?: string
  /** Field paths that exist in the collection / content type, to catch mapping typos. Top-level names are enough. */
  knownFields?: string[]
  thresholds?: CheckThresholds
  state: DocumentState
}

/** Where a value in the output came from. */
export interface FieldDiagnostic {
  property: 'url' | 'title' | 'description' | 'content' | 'author' | 'image' | 'datePublished' | 'dateModified' | 'faq'
  /** Field path the value was read from, or null when none was found. */
  field: string | null
  /** The value in the output, shortened. */
  value: string | null
  /** What the output uses instead when the field is empty. */
  fallback?: string
}

export interface Inspection {
  checks: CheckResult[]
  /** The document as the public outputs would map it, null when it has no URL. */
  document: LlmsDocument | null
  markdown: string | null
  jsonLd: JsonLd | null
  /** `jsonLd` serialized for a `<script>` tag, exactly as the frontend helper does. */
  jsonLdScript: string | null
  validation: CheckResult[]
  diagnostics: FieldDiagnostic[]
}

const r = (ruleId: string, status: CheckStatus, message: string, suggestion: string, fieldPath?: string): CheckResult =>
  fieldPath ? { ruleId, status, message, fieldPath, suggestion } : { ruleId, status, message, suggestion }

function short(value: string | null | undefined, max = 120): string | null {
  if (value == null) return null
  const v = value.replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function isHttpURL(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function hasValue(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

function fieldRule(options: InspectOptions): CheckResult {
  const { source, knownFields } = options
  const candidates: Array<[string, string | undefined]> = [
    ['titleField', source.titleField],
    ['descriptionField', source.descriptionField],
    ['contentField', source.contentField],
    ['authorField', source.authorField],
    ['imageField', source.imageField],
    ['publishedField', source.publishedField],
    ['faqField', source.faqField],
    ['sourcesField', options.sourcesField],
  ]
  const configured = candidates.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  if (!knownFields) {
    return r('GEO-FIELDS', 'notApplicable', 'Field list unavailable, mapping not checked.', 'Nothing to do.')
  }
  const known = new Set(knownFields)
  const broken = configured.filter(([, path]) => !known.has(path) && !known.has(path.split('.')[0]!))
  if (broken.length) {
    const [option, path] = broken[0]!
    return r(
      'GEO-FIELDS',
      'error',
      `Configured ${broken.map(([o, p]) => `\`${o}: '${p}'\``).join(', ')} ${broken.length > 1 ? 'do' : 'does'} not exist in this collection.`,
      `Fix \`${option}\` in the GEO plugin config to an existing field.`,
      path,
    )
  }
  return r('GEO-FIELDS', 'pass', configured.length ? 'Configured field paths exist.' : 'Using default field names.', 'Nothing to do.')
}

/**
 * Runs the checks on a document's current values (saved or not) and builds the same Markdown and JSON-LD
 * the public routes would serve for it.
 */
export function inspectDocument(doc: Record<string, any>, options: InspectOptions): Inspection {
  const t = { descriptionMin: 50, descriptionMax: 300, titleMax: 110, headingsAfter: 1500, ...options.thresholds }
  const fields = sourceFields(options.source)
  const mapping = mapLlmsDocument(doc, options)
  const { document, sources } = mapping
  const checks: CheckResult[] = []
  const { state } = options

  // Title
  if (!sources.title) checks.push(r('GEO-TITLE', 'error', 'Title is empty.', 'Add a title: it is the heading in llms.txt, Markdown and JSON-LD.', fields.title[0]))
  else if (document && document.title.length > t.titleMax)
    checks.push(r('GEO-TITLE', 'warning', `Title is ${document.title.length} characters; JSON-LD headline is cut at ${t.titleMax}.`, 'Consider a shorter title (editing suggestion).', sources.title))
  else checks.push(r('GEO-TITLE', 'pass', 'Title is set.', 'Nothing to do.', sources.title))

  // Description
  const desc = document?.description ?? (sources.description ? String(getField(doc, sources.description)) : null)
  if (!desc) checks.push(r('GEO-DESCRIPTION', 'warning', 'Description / summary is empty.', `Add a short summary in \`${fields.description[0]}\`. llms.txt shows it next to the link.`, fields.description[0]))
  else if (desc.length < t.descriptionMin)
    checks.push(r('GEO-DESCRIPTION', 'warning', `Description is ${desc.length} characters.`, `A summary of about ${t.descriptionMin}–${t.descriptionMax} characters usually says more (editing suggestion, not a requirement).`, sources.description ?? undefined))
  else if (desc.length > t.descriptionMax)
    checks.push(r('GEO-DESCRIPTION', 'warning', `Description is ${desc.length} characters.`, `Consider trimming it to about ${t.descriptionMax} characters (editing suggestion).`, sources.description ?? undefined))
  else checks.push(r('GEO-DESCRIPTION', 'pass', 'Description is set.', 'Nothing to do.', sources.description ?? undefined))

  // Body
  const raw = mapping.rawContent
  const markdownBody = options.markdown(raw)
  if (!hasValue(raw)) checks.push(r('GEO-BODY', 'error', 'Body is empty.', `Write the content in \`${fields.content[0]}\`. llms-full.txt and the Markdown page are empty without it.`, fields.content[0]))
  else if (!markdownBody.trim())
    checks.push(r('GEO-BODY', 'error', 'Body has content but converts to empty Markdown.', 'Use Lexical, Strapi Blocks or Markdown text, or set `contentField` to the rich text field.', sources.content ?? undefined))
  else checks.push(r('GEO-BODY', 'pass', `Body converts to ${markdownBody.length} characters of Markdown.`, 'Nothing to do.', sources.content ?? undefined))

  // Subheadings (suggestion only)
  if (!markdownBody.trim()) checks.push(r('GEO-HEADINGS', 'notApplicable', 'No body to check.', 'Nothing to do.'))
  else if (markdownBody.length >= t.headingsAfter && !/^#{2,6}\s/m.test(markdownBody))
    checks.push(r('GEO-HEADINGS', 'warning', 'Long body without subheadings.', 'Subheadings make sections easier to quote (editing suggestion, not a publishing requirement).', sources.content ?? undefined))
  else checks.push(r('GEO-HEADINGS', 'pass', /^#{2,6}\s/m.test(markdownBody) ? 'Body has subheadings.' : 'Body is short; subheadings optional.', 'Nothing to do.', sources.content ?? undefined))

  // Author
  if (document?.authors?.length) checks.push(r('GEO-AUTHOR', 'pass', `Author: ${document.authors.join(', ')}.`, 'Nothing to do.', sources.author ?? undefined))
  else if (sources.author)
    checks.push(r('GEO-AUTHOR', 'warning', `\`${sources.author}\` is set but has no readable name.`, 'Use a string, `{ name }`, or a relation with `name`. JSON-LD falls back to the site organization.', sources.author))
  else checks.push(r('GEO-AUTHOR', 'warning', 'No author. JSON-LD uses the site organization as author.', `Fill \`${fields.author[0]}\` or set \`authorField\`.`, fields.author[0]))

  // Dates
  const pubRaw = sources.published ? getField(doc, sources.published) : undefined
  const published = parseDate(document?.publishedAt)
  const updated = parseDate(document?.updatedAt)
  if (document?.publishedAt && !published)
    checks.push(r('GEO-DATES', 'error', `Publish date "${String(pubRaw)}" is not a valid date.`, 'Use an ISO date.', sources.published ?? undefined))
  else if (!published)
    checks.push(r('GEO-DATES', state.saved ? 'warning' : 'notApplicable', state.saved ? 'No publish date: datePublished is left out.' : 'Not saved yet: dates are set on save / publish.', state.saved ? `Publish the document or set \`publishedField\` (looked at: ${fields.published.join(', ')}).` : 'Nothing to do yet.', fields.published[0]))
  else if (published.getTime() > Date.now() + 24 * 3600_000)
    checks.push(r('GEO-DATES', 'warning', `Publish date ${published.toISOString().slice(0, 10)} is in the future.`, 'Check the date field.', sources.published ?? undefined))
  else if (updated && updated.getTime() < published.getTime() - 1000)
    checks.push(r('GEO-DATES', 'pass', 'Updated date is before the publish date; dateModified uses the publish date.', 'Nothing to do.', sources.published ?? undefined))
  else checks.push(r('GEO-DATES', 'pass', `Published ${published.toISOString().slice(0, 10)}${sources.published === 'createdAt' ? ' (from createdAt, as fallback)' : ''}.`, 'Nothing to do.', sources.published ?? undefined))

  // Image
  const imageField = getField(doc, fields.image[0]!)
  if (!document?.image && !sources.image && hasValue(imageField))
    checks.push(r('GEO-IMAGE', 'error', `\`${fields.image[0]}\` is set but has no URL.`, 'Save the upload, or use a field with `url`.', fields.image[0]))
  else if (!document?.image) checks.push(r('GEO-IMAGE', 'warning', 'No main image.', `Add an image in \`${fields.image[0]}\` or set \`imageField\`.`, fields.image[0]))
  else if (!isHttpURL(document.image) || /\/\/localhost[:/]|\/\/127\.0\.0\.1/.test(document.image) && !/\/\/localhost[:/]|\/\/127\.0\.0\.1/.test(options.siteURL))
    checks.push(r('GEO-IMAGE', 'error', `Image URL ${document.image} is not reachable from the public site.`, 'Set `mediaURL` (or the CMS server URL) so relative upload paths become public URLs.', sources.image ?? undefined))
  else checks.push(r('GEO-IMAGE', 'pass', 'Image has an absolute URL.', 'Nothing to do.', sources.image ?? undefined))

  // FAQ
  if (!options.source.faqField) checks.push(r('GEO-FAQ', 'notApplicable', 'No FAQ field configured.', 'Set `faqField` to output FAQPage JSON-LD.'))
  else if (!mapping.rawFaq?.length) checks.push(r('GEO-FAQ', 'notApplicable', 'FAQ is empty.', 'Optional: add questions and answers.', options.source.faqField))
  else {
    const dropped = mapping.rawFaq.length - (document?.faq?.length ?? 0)
    checks.push(
      dropped > 0
        ? r('GEO-FAQ', 'warning', `${dropped} of ${mapping.rawFaq.length} FAQ items have an empty question or answer and are left out.`, 'Fill or remove the empty items.', options.source.faqField)
        : r('GEO-FAQ', 'pass', `${mapping.rawFaq.length} FAQ items.`, 'Nothing to do.', options.source.faqField),
    )
  }

  // Field mapping
  checks.push(fieldRule(options))

  // Sources / references, only when the project maps a field for them.
  if (!options.sourcesField) checks.push(r('GEO-SOURCES', 'notApplicable', 'Not configured: no sources field mapped.', 'Optional: set `sourcesField` to check that references are filled. The plugin never judges whether claims are true.'))
  else if (!hasValue(getField(doc, options.sourcesField)))
    checks.push(r('GEO-SOURCES', 'warning', 'Sources field is empty.', 'Add the references this article relies on.', options.sourcesField))
  else checks.push(r('GEO-SOURCES', 'pass', 'Sources are filled.', 'Nothing to do (content is not fact-checked).', options.sourcesField))

  // URL
  if (mapping.urlError) checks.push(r('GEO-URL', 'error', `url() threw: ${mapping.urlError}`, 'Fix the `url` function in the GEO plugin config.'))
  else if (!document) checks.push(r('GEO-URL', state.saved ? 'error' : 'warning', 'No frontend URL: the document is left out of every output.', options.source.url ? 'Fill the fields `url()` uses (usually the slug).' : 'Add a `slug`, or set `url` in the GEO plugin config.', 'slug'))
  else if (/\/(undefined|null)(\/|$|[?#])/.test(document.url))
    checks.push(r('GEO-URL', state.saved ? 'error' : 'warning', `Frontend URL ${document.url} contains "undefined" or "null".`, 'Fill the fields `url()` uses (usually the slug).', 'slug'))
  else if (!isHttpURL(document.url)) checks.push(r('GEO-URL', 'error', `Frontend URL ${document.url} is not a valid http(s) URL.`, 'Check `siteURL` and `url()`.'))
  else checks.push(r('GEO-URL', 'pass', `Frontend URL: ${document.url}`, 'Nothing to do.'))

  // Status and public visibility
  if (!state.saved) checks.push(r('GEO-STATUS', 'notApplicable', 'Not saved yet: publish status can’t be judged.', 'Save the document.'))
  else if (state.published === false) checks.push(r('GEO-STATUS', 'warning', 'Not published: public outputs skip it.', 'Publish when ready.'))
  else if (state.published === null) checks.push(r('GEO-STATUS', 'notApplicable', 'Publish status unknown.', 'Nothing to do.'))
  else checks.push(r('GEO-STATUS', 'pass', 'Published.', 'Nothing to do.'))

  if (!state.saved || state.publicVisible === null)
    checks.push(r('GEO-PUBLIC', 'notApplicable', state.saved ? 'Anonymous visibility unknown.' : 'Not saved yet: anonymous visibility can’t be judged.', 'Nothing to do yet.'))
  else if (!state.publicVisible) checks.push(r('GEO-PUBLIC', 'warning', `Not in the public outputs${state.publicReason ? `: ${state.publicReason}` : '.'}`, 'Publish it and make sure anonymous visitors may read it.'))
  else checks.push(r('GEO-PUBLIC', 'pass', 'Anonymous visitors get it in llms.txt, Markdown and JSON-LD.', 'Nothing to do.'))

  const jsonLd = document ? buildJsonLd(options.site, document) : null
  const jsonLdScript = jsonLd ? serializeJsonLd(jsonLd) : null
  return {
    checks,
    document,
    markdown: document ? documentMarkdown(document) : null,
    jsonLd,
    jsonLdScript,
    validation: validateJsonLd(jsonLd, document, options.source.jsonLd === false),
    diagnostics: diagnose(document, sources, options),
  }
}

function diagnose(document: LlmsDocument | null, sources: LlmsMappingSources, options: InspectOptions): FieldDiagnostic[] {
  const d = document
  return [
    { property: 'url', field: sources.url === 'slug' ? 'slug' : sources.url, value: d?.url ?? null, fallback: d ? undefined : 'left out of every output' },
    { property: 'title', field: sources.title, value: short(d?.title), fallback: sources.title ? undefined : 'the URL path' },
    { property: 'description', field: sources.description, value: short(d?.description), fallback: sources.description ? undefined : 'none' },
    { property: 'content', field: sources.content, value: d?.markdown ? `${d.markdown.length} characters of Markdown` : null, fallback: sources.content ? undefined : 'none' },
    { property: 'author', field: sources.author, value: d?.authors?.length ? d.authors.join(', ') : null, fallback: d?.authors?.length ? undefined : `organization "${options.site.name}"` },
    { property: 'image', field: sources.image, value: d?.image ?? null, fallback: d?.image ? undefined : 'none' },
    { property: 'datePublished', field: sources.published, value: d?.publishedAt ?? null, fallback: sources.published ? undefined : 'left out' },
    { property: 'dateModified', field: sources.updated, value: d?.updatedAt ?? null, fallback: sources.updated ? undefined : 'datePublished, when set' },
    { property: 'faq', field: sources.faq, value: d?.faq?.length ? `${d.faq.length} items` : null, fallback: sources.faq ? undefined : 'no FAQPage' },
  ].map((x) => (x.fallback === undefined ? { property: x.property, field: x.field, value: x.value } : x)) as FieldDiagnostic[]
}

const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'Report'])

/**
 * Checks the JSON-LD against the plugin's own rules: parseable, required and recommended properties,
 * date order, absolute URLs, the FAQPage belonging to the same page, and safe `<script>` serialization.
 * Passing means the plugin's rules pass, not Google rich result eligibility or full schema.org validation.
 */
export function validateJsonLd(jsonLd: JsonLd | null, document: LlmsDocument | null, disabled = false): CheckResult[] {
  if (disabled) return [r('LD-ENABLED', 'notApplicable', 'JSON-LD is turned off for this collection.', 'Nothing to do.')]
  if (!jsonLd || !document) return [r('LD-ENABLED', 'error', 'No JSON-LD: the document has no frontend URL.', 'Fix the URL first.')]
  const out: CheckResult[] = []
  const script = serializeJsonLd(jsonLd)
  let parsed: any
  try {
    parsed = JSON.parse(script)
    out.push(r('LD-PARSE', 'pass', 'Serialized JSON-LD parses back to the same data.', 'Nothing to do.'))
  } catch (error) {
    out.push(r('LD-PARSE', 'error', `Serialized JSON-LD does not parse: ${(error as Error).message}`, 'Report this as a plugin bug.'))
    return out
  }
  out.push(
    /<\/script|<!--/i.test(script) || script.includes('<')
      ? r('LD-SCRIPT', 'error', 'Serialized JSON-LD contains `<`, which could close the script tag.', 'Use serializeJsonLd / jsonLdScriptProps in the frontend.')
      : r('LD-SCRIPT', 'pass', 'Safe to embed in <script type="application/ld+json"> (`<` is escaped).', 'Nothing to do.'),
  )
  const graph: any[] = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]
  const main = graph[0] ?? {}
  const isArticle = ARTICLE_TYPES.has(main['@type'])
  const required = isArticle ? ['@type', 'headline', 'url'] : ['@type', 'name', 'url']
  const missing = required.filter((k) => !hasValue(main[k]))
  out.push(
    missing.length
      ? r('LD-REQUIRED', 'error', `Main node is missing ${missing.join(', ')}.`, 'Fill the title and URL.')
      : r('LD-REQUIRED', 'pass', `${main['@type']} has ${required.slice(1).join(' and ')}.`, 'Nothing to do.'),
  )
  if (isArticle) {
    const recommended = ['image', 'datePublished', 'author', 'publisher', 'description'].filter((k) => !hasValue(main[k]))
    out.push(
      recommended.length
        ? r('LD-RECOMMENDED', 'warning', `Recommended properties missing: ${recommended.join(', ')}.`, 'See the field diagnostics for which document fields feed them.')
        : r('LD-RECOMMENDED', 'pass', 'Recommended article properties are present.', 'Nothing to do.'),
    )
  }
  const pub = parseDate(main.datePublished)
  const mod = parseDate(main.dateModified)
  if ((main.datePublished && !pub) || (main.dateModified && !mod)) out.push(r('LD-DATES', 'error', 'datePublished or dateModified is not a valid date.', 'Check the date fields.'))
  else if (pub && mod && mod.getTime() < pub.getTime()) out.push(r('LD-DATES', 'error', 'dateModified is before datePublished.', 'Check the date fields.'))
  else out.push(r('LD-DATES', pub ? 'pass' : 'notApplicable', pub ? 'Dates are valid and in order.' : 'No dates yet.', 'Nothing to do.'))

  const urls: Array<[string, unknown]> = [['url', main.url], ['@id', main['@id']]]
  if (Array.isArray(main.image)) main.image.forEach((u: unknown, i: number) => urls.push([`image[${i}]`, u]))
  if (main.publisher?.logo?.url) urls.push(['publisher.logo', main.publisher.logo.url])
  const badURL = urls.find(([, u]) => typeof u !== 'string' || !isHttpURL(u.split('#')[0]))
  out.push(
    badURL
      ? r('LD-URLS', 'error', `${badURL[0]} is not an absolute http(s) URL: ${String(badURL[1])}`, 'Check `siteURL`, `mediaURL` and `logo`.')
      : r('LD-URLS', 'pass', 'URLs and image URLs are absolute.', 'Nothing to do.'),
  )

  const faq = graph.find((n) => n['@type'] === 'FAQPage')
  if (!faq) out.push(r('LD-FAQ', 'notApplicable', 'No FAQPage.', 'Nothing to do.'))
  else {
    const pageURL = String(main.url ?? '')
    const items: any[] = Array.isArray(faq.mainEntity) ? faq.mainEntity : []
    const broken = items.filter((q) => !hasValue(q?.name) || !hasValue(q?.acceptedAnswer?.text))
    if (!String(faq['@id'] ?? '').startsWith(`${pageURL}#`)) out.push(r('LD-FAQ', 'error', 'FAQPage @id does not belong to this page.', 'Report this as a plugin bug.'))
    else if (!items.length || broken.length) out.push(r('LD-FAQ', 'error', `${broken.length || 'All'} FAQ questions lack a name or answer.`, 'Fill the FAQ items.'))
    else out.push(r('LD-FAQ', 'pass', `FAQPage with ${items.length} questions, on the same page as the ${main['@type']}.`, 'Nothing to do.'))
  }
  return out
}

/** External validators. Only offer them for a public URL: never upload unpublished content. */
export function externalValidators(publicURL: string): Array<{ name: string; url: string }> {
  const u = encodeURIComponent(publicURL)
  return [
    { name: 'Schema.org validator', url: `https://validator.schema.org/#url=${u}` },
    { name: 'Google Rich Results Test', url: `https://search.google.com/test/rich-results?url=${u}` },
  ]
}
