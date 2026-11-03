/**
 * Content conversion: CMS rich text, blocks and components to Markdown.
 *
 * One converter is used for the public Markdown page, llms-full.txt and the editor preview, so the three never
 * disagree. It understands:
 * - Payload Lexical JSON (`{ root: { children } }`), including `block` / `inlineBlock` nodes, uploads,
 *   relationships and tables,
 * - Payload blocks fields (`[{ blockType, ... }]`),
 * - Strapi 5 Blocks (`[{ type: 'paragraph', children }]`),
 * - Strapi components and dynamic zones (`{ __component, ... }`, `[{ __component, ... }]`),
 * - plain strings (Markdown, e.g. Strapi's classic rich text), passed through.
 *
 * It never walks arbitrary JSON keys looking for text: a block is converted only by a converter registered for
 * its type (built in or yours), and built-in converters read only the fields they document. Unknown blocks are
 * reported as structured warnings.
 *
 * Converters only see what the adapter loaded with the anonymous visitor's access. They get no database access,
 * so a converter cannot read content the public can't.
 */

type Node = Record<string, any>

export type ConversionWarningCode =
  | 'unknown-block'
  | 'unknown-node'
  | 'unsupported-value'
  | 'converter-error'
  | 'invalid-output'
  | 'relation-unavailable'
  | 'cycle'
  | 'depth-limit'
  | 'node-limit'
  | 'output-limit'

export interface ConversionWarning {
  code: ConversionWarningCode
  /** Block type, component UID or node type the warning is about. */
  type?: string
  /** Where in the document, e.g. `layout[2].columns[0].richText`. */
  path: string
  message: string
  /** How many times this warning (same code, type) occurred; only the first path is kept. */
  count: number
}

export interface ConversionLimits {
  /** Maximum nesting of blocks, components and rich text inside each other. Default 16. */
  maxDepth: number
  /** Maximum nodes, blocks and components visited per document. Default 20000. */
  maxNodes: number
  /** Maximum Markdown length in characters; longer output is cut with a visible marker. Default 1_000_000. */
  maxOutputChars: number
  /** Maximum related documents a converter may read per document (already loaded ones). Default 200. */
  maxRelations: number
}

export interface ConversionResult {
  markdown: string
  warnings: ConversionWarning[]
  /** True when a limit stopped the conversion or cut the output. */
  truncated: boolean
  /** Nodes, blocks and components visited. */
  nodes: number
}

/** What a converter gets besides the block itself. */
export interface ConvertContext {
  /** Location of the block in the document, for warnings. */
  path: string
  depth: number
  /** Converts nested content of any supported shape (rich text, blocks, a component, a string). */
  convert(value: unknown, childPath: string): string
  /** Converts rich text inline children (Lexical or Strapi Blocks) to inline Markdown. */
  inline(children: unknown, childPath: string): string
  /**
   * A related document as the adapter loaded it (populated with anonymous access), or null when it is only an id
   * (not loaded, or not readable by the public) or would close a reference cycle. Warns in both cases.
   */
  relation(value: unknown, childPath: string, relationTo?: string): Record<string, any> | null
  /** Public URL of a related document when its collection / content type is configured for GEO. */
  linkFor(doc: Record<string, any>, relationTo?: string): string | null
  /** URL and alt text of an upload / media value, URL made absolute with the media base. Null if not loaded. */
  media(value: unknown, childPath: string): { url: string; alt: string; caption?: string } | null
  /** Adds a warning shown in the editor panel. */
  warn(code: ConversionWarningCode, message: string, type?: string): void
}

/**
 * Converts one block / component / rich text node. Return Markdown, or `null` / `''` for nothing.
 * Throwing is safe: the block is left out and reported with its type and path (the message only, no stack).
 */
export type BlockConverter = (block: Node, ctx: ConvertContext) => string | null | undefined

export interface ContentConverterOptions {
  /**
   * Converters for Payload `blockType`s and Strapi component UIDs (`shared.quote`, or just `quote`), also used for
   * Lexical `block` / `inlineBlock` nodes. Yours take precedence over the built-in ones. `false` skips a type quietly.
   */
  blocks?: Record<string, BlockConverter | false>
  /** Converters for rich text node types (Lexical or Strapi Blocks), e.g. a custom Lexical node. `false` skips it. */
  nodes?: Record<string, BlockConverter | false>
  /**
   * Blocks without a converter: `warn` (default) leaves them out and reports them; `skip` leaves them out silently.
   * Rich text nodes without a converter always keep their text (and are reported with `warn`).
   */
  unknown?: 'warn' | 'skip'
  limits?: Partial<ConversionLimits>
}

export interface ConvertOptions {
  /** Base for relative media URLs (the CMS URL). */
  mediaURL?: string
  /** Field path of the value, used as the root of warning paths. */
  path?: string
  /** Public URL of a related document; adapters pass one built from the GEO source config. */
  linkFor?: (doc: Record<string, any>, relationTo?: string) => string | null
}

export interface ContentConverter {
  convert(value: unknown, options?: ConvertOptions): ConversionResult
  /** Markdown only, for `markdown: (value) => string` style callers. */
  toMarkdown(value: unknown, options?: ConvertOptions): string
  readonly options: Readonly<ContentConverterOptions>
}

const DEFAULT_LIMITS: ConversionLimits = { maxDepth: 16, maxNodes: 20_000, maxOutputChars: 1_000_000, maxRelations: 200 }

const LEXICAL_BOLD = 1
const LEXICAL_ITALIC = 2
const LEXICAL_STRIKE = 4
const LEXICAL_CODE = 16

class LimitReached extends Error {}

function wrap(text: string, marker: string): string {
  if (!text.trim()) return text
  // Keep surrounding whitespace outside the markers, or Markdown won't parse them.
  const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(text)!
  return `${lead}${marker}${core}${marker}${trail}`
}

function joinBlocks(blocks: string[]): string {
  return blocks.filter((b) => b.trim() !== '').join('\n\n')
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line, i) => (i === 0 ? line : prefix + line)).join('\n')
}

function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
}

function isRecord(v: unknown): v is Node {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function joinURL(base: string | undefined, url: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
}

/** Text for a table cell: one line, `|` escaped. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

export function markdownTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ''))
  const head = header.length ? pad(header) : pad([])
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n')
}

function fence(code: string, language = ''): string {
  // A fence longer than any backtick run in the code, so the code can't close it.
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length))
  const marker = '`'.repeat(longest + 1)
  return `${marker}${String(language).replace(/[^\w+#.-]/g, '')}\n${code.replace(/\n+$/, '')}\n${marker}`
}

/** Name of a block / component used to look up its converter: Payload `blockType` or Strapi `__component`. */
export function blockTypeOf(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.blockType === 'string') return value.blockType
  if (typeof value.__component === 'string') return value.__component
  return null
}

function firstText(block: Node, keys: string[]): unknown {
  for (const k of keys) if (block[k] != null && block[k] !== '') return block[k]
  return undefined
}

// ---------- Built-in block converters ----------
// Each reads only the fields listed here. Names follow the Payload website template and the Strapi 5 blog template.

const BODY_KEYS = ['richText', 'body', 'content', 'text', 'markdown']

const richTextBlock: BlockConverter = (b, ctx) => {
  const key = BODY_KEYS.find((k) => b[k] != null)
  return key ? ctx.convert(b[key], key) : ''
}

const codeBlock: BlockConverter = (b) => (typeof b.code === 'string' && b.code ? fence(b.code, b.language ?? '') : '')

const mediaBlock: BlockConverter = (b, ctx) => {
  const key = ['media', 'file', 'image'].find((k) => b[k] != null)
  if (!key) return ''
  const m = ctx.media(b[key], key)
  if (!m) return ''
  const caption = typeof b.caption === 'string' ? b.caption : b.caption != null ? ctx.convert(b.caption, 'caption') : m.caption
  return `![${m.alt.replace(/[[\]]/g, '')}](${m.url})${caption ? `\n\n${caption}` : ''}`
}

const galleryBlock: BlockConverter = (b, ctx) => {
  const key = ['files', 'images', 'media'].find((k) => Array.isArray(b[k]))
  if (!key) return ''
  return (b[key] as unknown[])
    .map((item, i) => ctx.media(item, `${key}[${i}]`))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => `![${m.alt.replace(/[[\]]/g, '')}](${m.url})`)
    .join('\n\n')
}

const quoteBlock: BlockConverter = (b, ctx) => {
  const bodyKey = ['body', 'quote', 'text', 'content'].find((k) => b[k] != null)
  const body = bodyKey ? ctx.convert(b[bodyKey], bodyKey) : ''
  const by = firstText(b, ['author', 'cite', 'title'])
  if (!body) return ''
  return quoteLines(body) + (typeof by === 'string' && by.trim() ? `\n>\n> — ${by.trim()}` : '')
}

const calloutBlock: BlockConverter = (b, ctx) => {
  const key = ['content', 'body', 'text', 'richText'].find((k) => b[k] != null)
  const body = key ? ctx.convert(b[key], key) : ''
  return body ? quoteLines(body) : ''
}

const faqBlock: BlockConverter = (b, ctx) => {
  const key = ['items', 'questions', 'faqs', 'faq'].find((k) => Array.isArray(b[k]))
  if (!key) return ''
  const title = typeof b.title === 'string' && b.title.trim() ? `## ${b.title.trim()}\n\n` : ''
  const items = (b[key] as Node[])
    .map((item, i) => {
      if (!isRecord(item)) return ''
      const q = typeof item.question === 'string' ? item.question.replace(/\s+/g, ' ').trim() : ''
      const a = item.answer != null ? ctx.convert(item.answer, `${key}[${i}].answer`) : ''
      return q && a ? `### ${q}\n\n${a}` : ''
    })
    .filter(Boolean)
  return items.length ? title + items.join('\n\n') : ''
}

const tableBlock: BlockConverter = (b, ctx) => {
  const rows = Array.isArray(b.rows) ? b.rows : []
  const cells = (r: unknown, i: number): string[] => {
    const list = Array.isArray(r) ? r : isRecord(r) && Array.isArray(r.cells) ? r.cells : []
    return list.map((c: unknown, j: number) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ctx.convert(c, `rows[${i}].cells[${j}]`)))
  }
  const header = Array.isArray(b.header) ? b.header.map(String) : Array.isArray(b.headers) ? b.headers.map(String) : []
  const body = rows.map(cells)
  if (!header.length && !body.length) return ''
  const caption = typeof b.caption === 'string' && b.caption.trim() ? `${b.caption.trim()}\n\n` : ''
  return caption + (header.length ? markdownTable(header, body) : markdownTable(body[0] ?? [], body.slice(1)))
}

const CHILD_KEYS = ['columns', 'blocks', 'items', 'sections', 'tabs', 'children', 'layout', 'content']

/** Layout containers: converts their child blocks (or child objects' body fields) in order. */
const containerBlock: BlockConverter = (b, ctx) => {
  const parts: string[] = []
  const heading = typeof b.heading === 'string' && b.heading.trim() ? `## ${b.heading.trim()}` : ''
  if (heading) parts.push(heading)
  for (const key of CHILD_KEYS) {
    const value = b[key]
    if (value == null) continue
    if (!Array.isArray(value)) {
      parts.push(ctx.convert(value, key))
      continue
    }
    value.forEach((child, i) => {
      const at = `${key}[${i}]`
      if (blockTypeOf(child) || !isRecord(child)) parts.push(ctx.convert(child, at))
      else {
        // A plain child object (e.g. a Payload column): its own heading, body field and nested blocks.
        if (typeof child.label === 'string' && child.label.trim() && key === 'tabs') parts.push(`### ${child.label.trim()}`)
        const bodyKey = BODY_KEYS.find((k) => child[k] != null)
        if (bodyKey) parts.push(ctx.convert(child[bodyKey], `${at}.${bodyKey}`))
        if (Array.isArray(child.blocks)) parts.push(ctx.convert(child.blocks, `${at}.blocks`))
      }
    })
  }
  return joinBlocks(parts)
}

const ctaBlock: BlockConverter = (b, ctx) => {
  const parts = [b.richText != null ? ctx.convert(b.richText, 'richText') : b.content != null ? ctx.convert(b.content, 'content') : '']
  const links = Array.isArray(b.links) ? b.links : []
  for (const item of links) {
    const link = isRecord(item?.link) ? item.link : item
    const url = typeof link?.url === 'string' ? link.url : isRecord(link?.reference?.value) ? ctx.linkFor(link.reference.value, link.reference.relationTo) : null
    if (url && typeof link?.label === 'string') parts.push(`[${link.label.replace(/[[\]]/g, '')}](${url})`)
  }
  return joinBlocks(parts)
}

/** Blocks that hold a form or a generated listing: only their intro text is content. */
const introOnly: BlockConverter = (b, ctx) => (b.introContent != null ? ctx.convert(b.introContent, 'introContent') : '')

export const BUILTIN_BLOCKS: Readonly<Record<string, BlockConverter>> = {
  // Payload website template
  content: (b, ctx) => (Array.isArray(b.columns) ? containerBlock(b, ctx) : richTextBlock(b, ctx)),
  mediaBlock,
  banner: calloutBlock,
  code: codeBlock,
  cta: ctaBlock,
  callToAction: ctaBlock,
  archive: introOnly,
  formBlock: introOnly,
  // Strapi 5 blog template components (matched by full UID or by the part after the dot)
  'rich-text': richTextBlock,
  richText: richTextBlock,
  text: richTextBlock,
  markdown: richTextBlock,
  paragraph: richTextBlock,
  media: mediaBlock,
  image: mediaBlock,
  slider: galleryBlock,
  gallery: galleryBlock,
  quote: quoteBlock,
  blockquote: quoteBlock,
  callout: calloutBlock,
  notice: calloutBlock,
  faq: faqBlock,
  table: tableBlock,
  // Layout containers
  columns: containerBlock,
  section: containerBlock,
  layout: containerBlock,
  container: containerBlock,
  group: containerBlock,
  row: containerBlock,
  grid: containerBlock,
  tabs: containerBlock,
  accordion: faqBlock,
}

// ---------- The converter ----------

interface RunState {
  warnings: Map<string, ConversionWarning>
  nodes: number
  relations: number
  stack: string[]
  truncated: boolean
  limits: ConversionLimits
  options: ConvertOptions
}

export function createContentConverter(options: ContentConverterOptions = {}): ContentConverter {
  const limits: ConversionLimits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const [k, v] of Object.entries(options.blocks ?? {})) {
    if (v !== false && typeof v !== 'function') throw new TypeError(`[geo] converter for block "${k}" must be a function or false`)
  }
  for (const [k, v] of Object.entries(options.nodes ?? {})) {
    if (v !== false && typeof v !== 'function') throw new TypeError(`[geo] converter for node "${k}" must be a function or false`)
  }
  const own = (map: Record<string, unknown> | undefined, key: string) => (map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined)

  function blockConverter(type: string): BlockConverter | false | undefined {
    const short = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : null
    for (const key of short ? [type, short] : [type]) {
      const mine = own(options.blocks, key) as BlockConverter | false | undefined
      if (mine !== undefined) return mine
    }
    for (const key of short ? [type, short] : [type]) {
      const builtin = own(BUILTIN_BLOCKS, key) as BlockConverter | undefined
      if (builtin) return builtin
    }
    return undefined
  }

  function run(value: unknown, convertOptions: ConvertOptions = {}): ConversionResult {
    const state: RunState = { warnings: new Map(), nodes: 0, relations: 0, stack: [], truncated: false, limits, options: convertOptions }
    const warn = (code: ConversionWarningCode, path: string, message: string, type?: string) => {
      const key = `${code}:${type ?? ''}`
      const existing = state.warnings.get(key)
      if (existing) existing.count++
      else state.warnings.set(key, { code, ...(type ? { type } : {}), path, message, count: 1 })
    }
    const tick = (path: string) => {
      if (++state.nodes > limits.maxNodes) {
        state.truncated = true
        warn('node-limit', path, `Stopped after ${limits.maxNodes} nodes; the rest of the content is left out.`)
        throw new LimitReached()
      }
    }
    const join = (base: string, child: string) => (!base ? child : !child ? base : child.startsWith('[') ? `${base}${child}` : `${base}.${child}`)

    const media = (v: unknown, path: string) => {
      let item: any = v
      if (isRecord(item) && 'data' in item && !('url' in item)) item = item.data?.attributes ?? item.data
      if (typeof item === 'string' && /^(https?:)?\/\//i.test(item)) return { url: item, alt: '' }
      if (!isRecord(item) || typeof item.url !== 'string' || !item.url) {
        if (item != null && item !== '') warn('relation-unavailable', path, 'Media is not loaded or not public, so it is left out.', 'media')
        return null
      }
      const alt = String(item.alt ?? item.alternativeText ?? item.caption ?? item.name ?? '').replace(/\s+/g, ' ').trim()
      const caption = typeof item.caption === 'string' && item.caption.trim() && item.caption !== alt ? item.caption.trim() : undefined
      return { url: joinURL(convertOptions.mediaURL, item.url), alt, ...(caption ? { caption } : {}) }
    }

    function makeContext(path: string, depth: number): ConvertContext {
      // Related documents this converter opened; nested conversions see them as ancestors (cycle detection).
      const acquired: string[] = []
      const nested = <T>(fn: () => T): T => {
        state.stack.push(...acquired)
        try {
          return fn()
        } finally {
          state.stack.length -= acquired.length
        }
      }
      return {
        path,
        depth,
        convert: (v, child) => nested(() => convertAny(v, join(path, child), depth + 1)),
        inline: (children, child) => nested(() => inlineAny(children, join(path, child), depth + 1)),
        relation(v, child, relationTo) {
          const at = join(path, child)
          let doc: any = v
          if (isRecord(doc) && 'value' in doc && 'relationTo' in doc && Object.keys(doc).length <= 3) {
            relationTo ??= doc.relationTo
            doc = doc.value
          }
          if (isRecord(doc) && 'data' in doc && !('id' in doc)) doc = doc.data?.attributes ? { id: doc.data.id, ...doc.data.attributes } : doc.data
          if (!isRecord(doc)) {
            if (doc != null) warn('relation-unavailable', at, 'Related document is not loaded or not public, so it is left out.', relationTo)
            return null
          }
          const id = doc.documentId ?? doc.id
          const key = `${relationTo ?? ''}:${id ?? ''}`
          if (id != null && (state.stack.includes(key) || acquired.includes(key))) {
            warn('cycle', at, `Reference cycle at ${relationTo ?? 'relation'} ${id}; not followed again.`, relationTo)
            return null
          }
          if (++state.relations > limits.maxRelations) {
            warn('node-limit', at, `More than ${limits.maxRelations} related documents; the rest are left out.`, relationTo)
            return null
          }
          if (id != null) acquired.push(key)
          return doc
        },
        linkFor: (doc, relationTo) => {
          try {
            return convertOptions.linkFor?.(doc, relationTo) ?? null
          } catch {
            return null
          }
        },
        media: (v, child) => media(v, join(path, child)),
        warn: (code, message, type) => warn(code, path, message, type),
      }
    }

    /** Runs a converter with error isolation and output validation. */
    function apply(fn: BlockConverter, node: Node, type: string, path: string, depth: number): string {
      try {
        const out = fn(node, makeContext(path, depth))
        if (out == null) return ''
        if (typeof out !== 'string') {
          warn('invalid-output', path, `Converter for "${type}" returned ${Array.isArray(out) ? 'an array' : typeof out}, not a string; left out.`, type)
          return ''
        }
        return out
      } catch (error) {
        if (error instanceof LimitReached) throw error
        const message = String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 200)
        warn('converter-error', path, `Converter for "${type}" failed: ${message}`, type)
        return ''
      }
    }

    function convertBlock(block: Node, path: string, depth: number): string {
      tick(path)
      const type = blockTypeOf(block)!
      const fn = blockConverter(type)
      if (fn === false) return ''
      if (!fn) {
        if (options.unknown !== 'skip') warn('unknown-block', path, `No converter for block "${type}"; it is left out of Markdown. Register one in \`converters.blocks\`.`, type)
        return ''
      }
      return apply(fn, block, type, path, depth)
    }

    function convertAny(value: unknown, path: string, depth: number): string {
      if (value == null || value === '') return ''
      if (depth > limits.maxDepth) {
        state.truncated = true
        warn('depth-limit', path, `Nested deeper than ${limits.maxDepth} levels; the deeper content is left out.`)
        return ''
      }
      if (typeof value === 'string') return value.trim()
      if (typeof value === 'number' || typeof value === 'boolean') return ''
      if (Array.isArray(value)) {
        if (value.length === 0) return ''
        if (value.every((v) => blockTypeOf(v))) return joinBlocks(value.map((b, i) => convertBlock(b, `${path}[${i}]`, depth)))
        if (value.every((v) => isRecord(v) && typeof v.type === 'string')) return joinBlocks(value.map((n, i) => strapiBlock(n, `${path}[${i}]`, depth)))
        warn('unsupported-value', path, 'Array is neither blocks, components nor rich text; left out.')
        return ''
      }
      if (isRecord(value)) {
        if (isRecord(value.root)) return joinBlocks((value.root.children ?? []).map((n: Node, i: number) => lexicalBlock(n, `${path}.root.children[${i}]`, depth)))
        if (blockTypeOf(value)) return convertBlock(value, path, depth)
        warn('unsupported-value', path, 'Object is neither rich text nor a block / component; left out.')
      }
      return ''
    }

    /** Inline children of either rich text format. */
    function inlineAny(children: unknown, path: string, depth: number): string {
      if (!Array.isArray(children)) return typeof children === 'string' ? children : ''
      const lexical = children.some((c) => isRecord(c) && typeof c.format === 'number' || c?.type === 'linebreak')
      return lexical ? lexicalInline(children, path, depth) : blocksInline(children, path, depth)
    }

    function customNode(node: Node, path: string, depth: number): string | null {
      const fn = own(options.nodes, String(node.type)) as BlockConverter | false | undefined
      if (fn === undefined) return null
      if (fn === false) return ''
      return apply(fn, node, String(node.type), path, depth)
    }

    // ----- Lexical -----

    function lexicalInline(nodes: Node[] = [], path: string, depth: number): string {
      return nodes.map((n, i) => lexicalInlineNode(n, `${path}[${i}]`, depth)).join('')
    }

    function lexicalInlineNode(node: Node, path: string, depth: number): string {
      tick(path)
      const custom = customNode(node, path, depth)
      if (custom !== null) return custom
      switch (node.type) {
        case 'text': {
          let text = String(node.text ?? '')
          const format = Number(node.format ?? 0)
          if (format & LEXICAL_CODE) return `\`${text}\``
          if (format & LEXICAL_BOLD) text = wrap(text, '**')
          if (format & LEXICAL_ITALIC) text = wrap(text, '_')
          if (format & LEXICAL_STRIKE) text = wrap(text, '~~')
          return text
        }
        case 'linebreak':
          return '  \n'
        case 'tab':
          return '\t'
        case 'link':
        case 'autolink': {
          const fields = node.fields ?? {}
          let url: string | null = fields.url ?? node.url ?? null
          if (!url && fields.linkType === 'internal' && fields.doc) {
            const doc = makeContext(path, depth).relation(fields.doc, 'fields.doc')
            url = doc ? makeContext(path, depth).linkFor(doc, fields.doc?.relationTo) : null
          }
          const label = lexicalInline(node.children, `${path}.children`, depth)
          return url ? `[${label}](${url})` : label
        }
        case 'inlineBlock': {
          const fields = isRecord(node.fields) ? node.fields : {}
          return blockTypeOf(fields) ? convertBlock(fields, `${path}.fields`, depth + 1).replace(/\n+/g, ' ') : ''
        }
        default:
          if (Array.isArray(node.children)) {
            if (node.type && !['code-highlight', 'mark'].includes(node.type) && options.unknown !== 'skip')
              warn('unknown-node', path, `Rich text node "${node.type}" has no converter; its text is kept.`, node.type)
            return lexicalInline(node.children, `${path}.children`, depth)
          }
          if (node.type === 'code-highlight') return String(node.text ?? '')
          if (typeof node.text === 'string') return node.text
          if (node.type && options.unknown !== 'skip') warn('unknown-node', path, `Rich text node "${node.type}" has no converter and no text; left out.`, node.type)
          return ''
      }
    }

    function lexicalList(node: Node, level: number, path: string, depth: number): string {
      const ordered = node.listType === 'number'
      let n = Number(node.start ?? 1)
      return (node.children ?? [])
        .map((item: Node, i: number) => {
          tick(`${path}.children[${i}]`)
          const nested = (item.children ?? []).filter((c: Node) => c.type === 'list')
          const inline = (item.children ?? []).filter((c: Node) => c.type !== 'list')
          const marker = node.listType === 'check' ? `- [${item.checked ? 'x' : ' '}] ` : ordered ? `${n++}. ` : '- '
          const pad = '  '.repeat(level)
          const line = pad + marker + lexicalInline(inline, `${path}.children[${i}].children`, depth)
          return [line, ...nested.map((l: Node) => lexicalList(l, level + 1, `${path}.children[${i}]`, depth))].join('\n')
        })
        .join('\n')
    }

    function lexicalTable(node: Node, path: string, depth: number): string {
      const rows: Node[] = (node.children ?? []).filter((r: Node) => r?.type === 'tablerow')
      const cells = rows.map((r, i) =>
        (r.children ?? []).map((c: Node, j: number) =>
          joinBlocks((c.children ?? []).map((p: Node, k: number) => lexicalBlock(p, `${path}.children[${i}].children[${j}].children[${k}]`, depth))),
        ),
      )
      if (!cells.length) return ''
      return markdownTable(cells[0]!, cells.slice(1))
    }

    function lexicalBlock(node: Node, path: string, depth: number): string {
      tick(path)
      const custom = customNode(node, path, depth)
      if (custom !== null) return custom
      switch (node.type) {
        case 'heading': {
          const level = Number(String(node.tag ?? 'h2').replace('h', '')) || 2
          return `${'#'.repeat(level)} ${lexicalInline(node.children, `${path}.children`, depth)}`
        }
        case 'paragraph':
          return lexicalInline(node.children, `${path}.children`, depth)
        case 'quote':
          return '> ' + indent(lexicalInline(node.children, `${path}.children`, depth), '> ')
        case 'list':
          return lexicalList(node, 0, path, depth)
        case 'code':
          return '```' + (node.language ?? '') + '\n' + lexicalInline(node.children, `${path}.children`, depth).replace(/ {2}\n/g, '\n') + '\n```'
        case 'horizontalrule':
          return '---'
        case 'upload': {
          const m = isRecord(node.value) ? media(node.value, path) : null
          if (!m && node.value != null && !isRecord(node.value)) warn('relation-unavailable', path, 'Upload is not loaded or not public, so it is left out.', 'upload')
          return m ? `![${m.alt.replace(/[[\]]/g, '')}](${m.url})` : ''
        }
        case 'relationship': {
          const ctx = makeContext(path, depth)
          const doc = ctx.relation(node.value, 'value', node.relationTo)
          if (!doc) return ''
          const title = String(doc.title ?? doc.name ?? '').replace(/\s+/g, ' ').trim()
          const url = ctx.linkFor(doc, node.relationTo)
          return title ? (url ? `[${title.replace(/[[\]]/g, '')}](${url})` : title) : ''
        }
        case 'block': {
          const fields = isRecord(node.fields) ? node.fields : {}
          return blockTypeOf(fields) ? convertBlock(fields, `${path}.fields`, depth + 1) : ''
        }
        case 'table':
          return lexicalTable(node, path, depth)
        default:
          if (Array.isArray(node.children)) {
            if (options.unknown !== 'skip') warn('unknown-node', path, `Rich text node "${node.type}" has no converter; its text is kept.`, node.type)
            return lexicalInline(node.children, `${path}.children`, depth)
          }
          if (node.type && options.unknown !== 'skip') warn('unknown-node', path, `Rich text node "${node.type}" has no converter and no text; left out.`, node.type)
          return ''
      }
    }

    // ----- Strapi Blocks -----

    function blocksInline(nodes: Node[] = [], path: string, depth: number): string {
      return nodes
        .map((node, i) => {
          const at = `${path}[${i}]`
          tick(at)
          const custom = customNode(node, at, depth)
          if (custom !== null) return custom
          if (node.type === 'link') return `[${blocksInline(node.children, `${at}.children`, depth)}](${node.url ?? ''})`
          if (node.type !== 'text') return blocksInline(node.children, `${at}.children`, depth)
          let text = String(node.text ?? '')
          if (node.code) return `\`${text}\``
          if (node.bold) text = wrap(text, '**')
          if (node.italic) text = wrap(text, '_')
          if (node.strikethrough) text = wrap(text, '~~')
          return text
        })
        .join('')
    }

    function blocksList(node: Node, level: number, path: string, depth: number): string {
      let n = 1
      return (node.children ?? [])
        .map((item: Node, i: number) => {
          tick(`${path}.children[${i}]`)
          if (item.type === 'list') return blocksList(item, level + 1, `${path}.children[${i}]`, depth)
          const marker = node.format === 'ordered' ? `${n++}. ` : '- '
          return '  '.repeat(level) + marker + blocksInline(item.children, `${path}.children[${i}].children`, depth)
        })
        .join('\n')
    }

    function strapiBlock(node: Node, path: string, depth: number): string {
      tick(path)
      const custom = customNode(node, path, depth)
      if (custom !== null) return custom
      switch (node.type) {
        case 'heading':
          return `${'#'.repeat(Number(node.level) || 2)} ${blocksInline(node.children, `${path}.children`, depth)}`
        case 'paragraph':
          return blocksInline(node.children, `${path}.children`, depth)
        case 'quote':
          return '> ' + indent(blocksInline(node.children, `${path}.children`, depth), '> ')
        case 'list':
          return blocksList(node, 0, path, depth)
        case 'code':
          return '```' + (node.language ?? '') + '\n' + blocksInline(node.children, `${path}.children`, depth) + '\n```'
        case 'image': {
          const m = node.image ? media(node.image, `${path}.image`) : null
          return m ? `![${m.alt.replace(/[[\]]/g, '')}](${m.url})` : ''
        }
        default:
          if (options.unknown !== 'skip') warn('unknown-node', path, `Blocks node "${node.type}" has no converter; its text is kept.`, node.type)
          return blocksInline(node.children, `${path}.children`, depth)
      }
    }

    let markdown = ''
    try {
      markdown = convertAny(value, convertOptions.path ?? '', 0)
    } catch (error) {
      if (!(error instanceof LimitReached)) throw error
    }
    if (markdown.length > limits.maxOutputChars) {
      state.truncated = true
      warn('output-limit', convertOptions.path ?? '', `Markdown is longer than ${limits.maxOutputChars} characters and was cut.`)
      // Don't cut inside a surrogate pair.
      let end = limits.maxOutputChars
      if (/[\uD800-\uDBFF]/.test(markdown[end - 1] ?? '')) end--
      markdown = `${markdown.slice(0, end).trimEnd()}\n\n[…content truncated by the GEO plugin's output limit]`
    }
    return { markdown, warnings: [...state.warnings.values()], truncated: state.truncated, nodes: state.nodes }
  }

  return {
    convert: run,
    toMarkdown: (value, o) => run(value, o).markdown,
    options,
  }
}

/** Merges converter options; later ones win per block / node type. */
export function mergeConverterOptions(...list: Array<ContentConverterOptions | undefined>): ContentConverterOptions {
  const out: ContentConverterOptions = {}
  for (const o of list) {
    if (!o) continue
    if (o.blocks) out.blocks = { ...out.blocks, ...o.blocks }
    if (o.nodes) out.nodes = { ...out.nodes, ...o.nodes }
    if (o.unknown) out.unknown = o.unknown
    if (o.limits) out.limits = { ...out.limits, ...o.limits }
  }
  return out
}

/** The converter with only the built-in converters, used when nothing is configured. */
export const defaultConverter: ContentConverter = createContentConverter()
