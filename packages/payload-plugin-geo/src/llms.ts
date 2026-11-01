import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  richTextToMarkdown,
  toLlmsDocument,
  type LlmsDocument,
  type LlmsSourceConfig,
} from '@garus-ltd/geo-core'
import type { CollectionConfig, Payload, Where } from 'payload'

export interface PayloadLlmsSource extends LlmsSourceConfig {
  /** Extra filter, e.g. `{ noindex: { not_equals: true } }`. */
  where?: Where
  /** Max documents from this collection. Default 500. */
  limit?: number
}

export interface LlmsOptions {
  /** Public URL of the frontend, e.g. `https://example.com`. */
  siteURL: string
  /** Site name for the `# heading`. Default: the admin meta title, else `siteURL`. */
  name?: string
  description?: string
  details?: string
  /** Collections to list, keyed by slug. */
  collections: Record<string, PayloadLlmsSource>
}

export async function loadLlmsDocuments(
  payload: Payload,
  options: LlmsOptions,
  collections: CollectionConfig[],
): Promise<LlmsDocument[]> {
  const docs: LlmsDocument[] = []
  for (const [slug, source] of Object.entries(options.collections)) {
    const config = collections.find((c) => c.slug === slug)
    if (!config) {
      payload.logger.warn(`[geo] llms collection "${slug}" does not exist`)
      continue
    }
    const filters: Where[] = []
    if (source.where) filters.push(source.where)
    if (typeof config.versions === 'object' && config.versions.drafts) filters.push({ _status: { equals: 'published' } })
    const result = await payload.find({
      collection: slug as never,
      where: filters.length ? { and: filters } : undefined,
      limit: source.limit ?? 500,
      depth: 1,
      // Anonymous read: only content the public can already see ends up in llms.txt.
      overrideAccess: false,
      sort: '-updatedAt',
    })
    for (const doc of result.docs as Record<string, any>[]) {
      const mapped = toLlmsDocument(doc, { name: slug, siteURL: options.siteURL, source, markdown: richTextToMarkdown })
      if (mapped) docs.push(mapped)
    }
  }
  return docs
}

export function renderLlms(options: LlmsOptions, docs: LlmsDocument[], full: boolean): string {
  const site = { name: options.name ?? options.siteURL, description: options.description, details: options.details }
  return full ? buildLlmsFullTxt(site, docs) : buildLlmsTxt(site, docs)
}
