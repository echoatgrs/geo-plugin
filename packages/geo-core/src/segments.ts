/**
 * Segmented llms.txt / llms-full.txt for large sites.
 *
 * Off by default: small sites keep the single files. With segments on, `/llms.txt` becomes an index that links
 * to one file per source and part (`/llms/<source>-<n>.txt`, full text in `/llms/<source>-<n>-full.txt`), plus
 * the featured documents. This is how this plugin organizes large sites; llmstxt.org does not define segments and
 * assistants are not known to follow them all.
 *
 * Consistency: every source is read in a stable order (default: oldest first, then id), part n is entries
 * `(n-1)·size + 1 … n·size` of that order. Updates don't move entries between parts; a publish appends to the
 * last part; an unpublish or delete shifts later entries back by one. Each file says when it was generated, so a
 * reader that needs one snapshot fetches the parts within the cache lifetime. Parts are read with one query each,
 * never the whole collection at once.
 */
import { buildLlmsFullTxt, llmsSectionLines, type LlmsDocument, type LlmsSite } from './llms.js'

export interface SegmentOptions {
  /** Turn segments on. Default false (single llms.txt / llms-full.txt, as before). */
  enabled?: boolean
  /** Entries per llms.txt part. Default 500. */
  size?: number
  /** Documents per llms-full part. Default 50. */
  fullSize?: number
  /** Byte limit of an llms-full part; the rest of the part is listed as not included. Default 2 MB. */
  maxBytes?: number
  /**
   * Public base URL of the part files, as the frontend serves them. Default `<siteURL>/llms`.
   * The frontend route (llmsSegmentRoute) must serve `<base>/<file>`.
   */
  baseURL?: string
}

export interface SegmentSource {
  /** Stable key used in part file names: the collection slug or content type plural name. */
  key: string
  /** Section heading. */
  section: string
  /** Number of entries the source has (public, published; before per-entry checks). */
  count(): Promise<number>
  /** Entries `offset … offset + limit - 1` in the stable order, as public documents. */
  page(offset: number, limit: number): Promise<LlmsDocument[]>
  /** Featured documents to list in the index, if the source has any. */
  featured?(): Promise<LlmsDocument[]>
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function segmentKey(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return key || 'pages'
}

export function resolvedSegments(options: SegmentOptions | undefined, siteURL: string) {
  return {
    enabled: options?.enabled === true,
    size: Math.max(1, Math.min(options?.size ?? 500, 5000)),
    fullSize: Math.max(1, Math.min(options?.fullSize ?? 50, 1000)),
    maxBytes: Math.max(10_000, options?.maxBytes ?? 2_000_000),
    baseURL: (options?.baseURL ?? `${siteURL.replace(/\/+$/, '')}/llms`).replace(/\/+$/, ''),
  }
}

/** Parses a part file name: `posts-2.txt` → `{ key: 'posts', part: 2, full: false }`. Null when invalid. */
export function parseSegmentFile(file: string): { key: string; part: number; full: boolean } | null {
  const m = /^([a-z0-9][a-z0-9_-]{0,63}?)-(\d{1,6})(-full)?\.txt$/.exec(file)
  if (!m || !KEY.test(m[1]!)) return null
  const part = Number(m[2])
  return part >= 1 ? { key: m[1]!, part, full: !!m[3] } : null
}

export function segmentFile(key: string, part: number, full: boolean): string {
  return `${key}-${part}${full ? '-full' : ''}.txt`
}

function headerLines(site: LlmsSite): string[] {
  const lines = [`# ${site.name.replace(/\s+/g, ' ').trim()}`, '']
  if (site.description) lines.push(`> ${site.description.replace(/\s+/g, ' ').trim()}`, '')
  if (site.details) lines.push(site.details.trim(), '')
  return lines
}

/** The `/llms.txt` index of a segmented site: featured documents, then the parts of every source. */
export async function buildSegmentIndex(
  site: LlmsSite,
  sources: SegmentSource[],
  options: SegmentOptions | undefined,
  siteURL: string,
  extra: { markdownLinks?: boolean; full?: boolean; generatedAt?: string } = {},
): Promise<string> {
  const o = resolvedSegments(options, siteURL)
  const lines = headerLines(site)
  lines.push(
    `This site is large, so this ${extra.full ? 'llms-full.txt' : 'llms.txt'} links to parts. Generated ${extra.generatedAt ?? new Date().toISOString()}.`,
    'Parts are this site’s own organization; llmstxt.org does not define them.',
    '',
  )
  if (!extra.full) {
    const featured = (await Promise.all(sources.map((s) => s.featured?.() ?? Promise.resolve([])))).flat()
    if (featured.length) {
      lines.push(...llmsSectionLines(featured.map((d) => ({ ...d, section: 'Featured', optional: false })), { markdownLinks: extra.markdownLinks }))
    }
  }
  for (const source of sources) {
    const total = await source.count()
    const per = extra.full ? o.fullSize : o.size
    const parts = Math.ceil(total / per)
    lines.push(`## ${source.section}`, '')
    if (!parts) lines.push('_No public entries._')
    for (let n = 1; n <= parts; n++) {
      const from = (n - 1) * per + 1
      const to = Math.min(n * per, total)
      lines.push(`- [${source.section}, part ${n} (entries ${from}–${to})](${o.baseURL}/${segmentFile(source.key, n, !!extra.full)})`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** One part file, or null when the part doesn't exist (404). */
export async function buildSegment(
  site: LlmsSite,
  source: SegmentSource,
  part: number,
  full: boolean,
  options: SegmentOptions | undefined,
  siteURL: string,
  extra: { markdownLinks?: boolean; generatedAt?: string } = {},
): Promise<string | null> {
  const o = resolvedSegments(options, siteURL)
  const per = full ? o.fullSize : o.size
  const total = await source.count()
  const parts = Math.ceil(total / per)
  if (part < 1 || part > parts) return null
  const docs = await source.page((part - 1) * per, per)
  const title: LlmsSite = { ...site, name: `${site.name} — ${source.section}, part ${part} of ${parts}` }
  const nav = [
    `Entries ${(part - 1) * per + 1}–${Math.min(part * per, total)} of ${total}. Generated ${extra.generatedAt ?? new Date().toISOString()}.`,
    part > 1 ? `Previous: ${o.baseURL}/${segmentFile(source.key, part - 1, full)}` : '',
    part < parts ? `Next: ${o.baseURL}/${segmentFile(source.key, part + 1, full)}` : '',
  ].filter(Boolean)
  if (full) return buildLlmsFullTxt({ ...title, details: [site.details, ...nav].filter(Boolean).join('\n') }, docs, { maxBytes: o.maxBytes })
  return [...headerLines({ ...title, details: [site.details, ...nav].filter(Boolean).join('\n') }), ...llmsSectionLines(docs.map((d) => ({ ...d, section: source.section, optional: false })), { markdownLinks: extra.markdownLinks })]
    .join('\n')
    .trimEnd() + '\n'
}
