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
}

function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
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

export function buildLlmsTxt(site: LlmsSite, docs: LlmsDocument[]): string {
  const lines = header(site)
  for (const [section, items] of groupBySection(docs)) {
    lines.push(`## ${section}`, '')
    for (const doc of items) {
      const desc = oneLine(doc.description)
      lines.push(`- [${escapeLinkText(oneLine(doc.title))}](${doc.url})${desc ? `: ${desc}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Every document's full Markdown in one file, for assistants that read a single URL. */
export function buildLlmsFullTxt(site: LlmsSite, docs: LlmsDocument[]): string {
  const lines = header(site)
  for (const doc of docs) {
    lines.push('---', '', `# ${oneLine(doc.title)}`, '', `URL: ${doc.url}`)
    if (doc.updatedAt) lines.push(`Updated: ${doc.updatedAt.slice(0, 10)}`)
    lines.push('')
    if (doc.description) lines.push(`> ${oneLine(doc.description)}`, '')
    if (doc.markdown) lines.push(doc.markdown.trim(), '')
  }
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
}

export function getField(doc: Record<string, any>, field: string): unknown {
  return field.split('.').reduce<any>((value, key) => (value == null ? undefined : value[key]), doc)
}

function firstString(doc: Record<string, any>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = getField(doc, f)
    if (typeof v === 'string' && v.trim()) return v
  }
  return undefined
}

/**
 * Maps a CMS document to an llms document. Returns null when no URL can be determined,
 * since an entry without a URL is useless to an assistant.
 */
export function toLlmsDocument(
  doc: Record<string, any>,
  options: { name: string; siteURL: string; source: LlmsSourceConfig; markdown: (value: unknown) => string },
): LlmsDocument | null {
  const { source } = options
  const path = source.url ? source.url(doc) : typeof doc.slug === 'string' ? `/${options.name}/${doc.slug}` : null
  if (!path) return null
  const title = firstString(doc, [source.titleField ?? 'title', 'name']) ?? path
  const description = source.descriptionField
    ? firstString(doc, [source.descriptionField])
    : firstString(doc, ['description', 'excerpt', 'summary', 'meta.description'])
  const contentFields = source.contentField ? [source.contentField] : ['content', 'body']
  const content = contentFields.map((f) => getField(doc, f)).find((v) => v != null)
  return {
    title,
    url: joinURL(options.siteURL, path),
    description: description ?? null,
    section: source.section ?? options.name,
    markdown: options.markdown(content),
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
  }
}
