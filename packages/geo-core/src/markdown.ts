/**
 * Converts CMS rich text to Markdown without pulling in the CMS's own serializers:
 * - Payload Lexical JSON (`{ root: { children } }`)
 * - Strapi 5 Blocks (`[{ type: 'paragraph', children }]`)
 * - Plain strings (Strapi classic rich text is already Markdown) pass through.
 * Unknown nodes fall back to their text content, so nothing is silently dropped.
 */

type Node = Record<string, any>

const LEXICAL_BOLD = 1
const LEXICAL_ITALIC = 2
const LEXICAL_STRIKE = 4
const LEXICAL_CODE = 16

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

// ---------- Payload Lexical ----------

function lexicalInline(nodes: Node[] = []): string {
  return nodes.map(lexicalInlineNode).join('')
}

function lexicalInlineNode(node: Node): string {
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
      const url = node.fields?.url ?? node.url ?? ''
      return url ? `[${lexicalInline(node.children)}](${url})` : lexicalInline(node.children)
    }
    default:
      return Array.isArray(node.children) ? lexicalInline(node.children) : String(node.text ?? '')
  }
}

function lexicalList(node: Node, depth: number): string {
  const ordered = node.listType === 'number'
  let n = Number(node.start ?? 1)
  return (node.children ?? [])
    .map((item: Node) => {
      const nested = (item.children ?? []).filter((c: Node) => c.type === 'list')
      const inline = (item.children ?? []).filter((c: Node) => c.type !== 'list')
      const marker = node.listType === 'check' ? `- [${item.checked ? 'x' : ' '}] ` : ordered ? `${n++}. ` : '- '
      const pad = '  '.repeat(depth)
      const line = pad + marker + lexicalInline(inline)
      return [line, ...nested.map((l: Node) => lexicalList(l, depth + 1))].join('\n')
    })
    .join('\n')
}

function lexicalBlock(node: Node): string {
  switch (node.type) {
    case 'heading': {
      const level = Number(String(node.tag ?? 'h2').replace('h', '')) || 2
      return `${'#'.repeat(level)} ${lexicalInline(node.children)}`
    }
    case 'paragraph':
      return lexicalInline(node.children)
    case 'quote':
      return '> ' + indent(lexicalInline(node.children), '> ')
    case 'list':
      return lexicalList(node, 0)
    case 'code':
      return '```' + (node.language ?? '') + '\n' + lexicalInline(node.children).replace(/ {2}\n/g, '\n') + '\n```'
    case 'horizontalrule':
      return '---'
    case 'upload': {
      const doc = typeof node.value === 'object' && node.value ? node.value : {}
      return doc.url ? `![${doc.alt ?? ''}](${doc.url})` : ''
    }
    default:
      return Array.isArray(node.children) ? lexicalInline(node.children) : ''
  }
}

export function lexicalToMarkdown(state: { root?: { children?: Node[] } } | null | undefined): string {
  return joinBlocks((state?.root?.children ?? []).map(lexicalBlock))
}

// ---------- Strapi Blocks ----------

function blocksInline(nodes: Node[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === 'link') return `[${blocksInline(node.children)}](${node.url ?? ''})`
      if (node.type !== 'text') return blocksInline(node.children)
      let text = String(node.text ?? '')
      if (node.code) return `\`${text}\``
      if (node.bold) text = wrap(text, '**')
      if (node.italic) text = wrap(text, '_')
      if (node.strikethrough) text = wrap(text, '~~')
      return text
    })
    .join('')
}

function blocksList(node: Node, depth: number): string {
  let n = 1
  return (node.children ?? [])
    .map((item: Node) => {
      if (item.type === 'list') return blocksList(item, depth + 1)
      const marker = node.format === 'ordered' ? `${n++}. ` : '- '
      return '  '.repeat(depth) + marker + blocksInline(item.children)
    })
    .join('\n')
}

function blocksBlock(node: Node): string {
  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(Number(node.level) || 2)} ${blocksInline(node.children)}`
    case 'paragraph':
      return blocksInline(node.children)
    case 'quote':
      return '> ' + indent(blocksInline(node.children), '> ')
    case 'list':
      return blocksList(node, 0)
    case 'code':
      return '```' + (node.language ?? '') + '\n' + blocksInline(node.children) + '\n```'
    case 'image':
      return node.image?.url ? `![${node.image.alternativeText ?? ''}](${node.image.url})` : ''
    default:
      return blocksInline(node.children)
  }
}

export function strapiBlocksToMarkdown(blocks: Node[] | null | undefined): string {
  return joinBlocks((blocks ?? []).map(blocksBlock))
}

/** Picks the right converter from the shape of the value. */
export function richTextToMarkdown(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return strapiBlocksToMarkdown(value as Node[])
  if (typeof value === 'object' && 'root' in (value as object)) return lexicalToMarkdown(value as { root: { children: Node[] } })
  return ''
}
