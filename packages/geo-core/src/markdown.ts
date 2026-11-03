/**
 * Rich text to Markdown with the built-in converters. Kept for compatibility; the converter in `convert.ts`
 * does the work and also handles blocks, components and dynamic zones, with warnings and limits.
 */
import { defaultConverter } from './convert.js'

type Node = Record<string, any>

export function lexicalToMarkdown(state: { root?: { children?: Node[] } } | null | undefined): string {
  return state?.root ? defaultConverter.toMarkdown(state) : ''
}

export function strapiBlocksToMarkdown(blocks: Node[] | null | undefined): string {
  return blocks?.length ? defaultConverter.toMarkdown(blocks) : ''
}

/** Picks the right converter from the shape of the value. */
export function richTextToMarkdown(value: unknown): string {
  return defaultConverter.toMarkdown(value)
}
