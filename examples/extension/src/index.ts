/**
 * An example GEO extension, kept outside the plugin packages: every import is a public export of
 * `@garus-ltd/geo-core`. Use it as a template for your own package (bots, rules, converters, fields, JSON-LD,
 * change listener) and pass its parts to the Payload / Strapi plugin and to the frontend proxy.
 */
import {
  defineBots,
  defineRules,
  markdownTable,
  type ContentChangeEvent,
  type ContentConverterOptions,
  type FieldResolver,
  type LlmsSourceConfig,
} from '@garus-ltd/geo-core'

/** A crawler the built-in list doesn't know. Pass the same list to the CMS plugin and to withGeo / geoFetchHandler. */
export const acmeBots = defineBots([
  { id: 'acme-research', name: 'AcmeResearchBot', platform: 'Acme Research', purpose: 'search', uaToken: 'AcmeResearchBot' },
])

/** An editor panel check: posts should start with a short summary paragraph. */
export const acmeRules = defineRules([
  {
    id: 'ACME-TLDR',
    params: { maxWords: 60 },
    check({ markdown, params }) {
      const first = markdown.split(/\n{2,}/).find((p) => p.trim() && !p.startsWith('#'))
      if (!first) return { status: 'warning', message: 'No opening paragraph.', suggestion: 'Start with a one-paragraph summary.' }
      const words = first.trim().split(/\s+/).length
      return words <= params.maxWords
        ? { status: 'pass', message: `Opening paragraph has ${words} words.` }
        : { status: 'warning', message: `Opening paragraph has ${words} words.`, suggestion: `Keep the summary under ${params.maxWords} words.` }
    },
  },
])

/** Converter for a custom `pricingTable` block (Payload) / `acme.pricing-table` component (Strapi). */
export const acmeConverters: ContentConverterOptions = {
  blocks: {
    pricingTable(block, ctx) {
      const plans = Array.isArray(block.plans) ? block.plans : []
      if (!plans.length) {
        ctx.warn('unsupported-value', 'Pricing table without plans', 'pricingTable')
        return null
      }
      return markdownTable(['Plan', 'Price', 'Includes'], plans.map((p: Record<string, any>) => [String(p.name ?? ''), String(p.price ?? ''), ctx.inline(p.features ?? [], `${ctx.path}.features`)]))
    },
  },
}

/** Field resolution: the description comes from `summary`, then from the first 160 characters of `intro`. */
export const summaryField: FieldResolver = Object.assign(
  (doc: Record<string, any>) => (typeof doc.intro === 'string' && doc.intro.trim() ? doc.intro.trim().slice(0, 160) : null),
  { label: 'intro (first 160 characters)' },
)

/** A source preset for a `posts` collection that uses all of the above. */
export function acmePostsSource(overrides: Partial<LlmsSourceConfig> = {}): LlmsSourceConfig {
  return {
    section: 'Blog',
    url: (doc) => `/blog/${doc.slug}`,
    fields: { description: ['summary', summaryField] },
    jsonLd: {
      type: 'BlogPosting',
      // Extra JSON-LD properties of the main node; keep them true to the page.
      extend: (doc) => (doc.readingMinutes ? { timeRequired: `PT${Number(doc.readingMinutes)}M` } : null),
    },
    ...overrides,
  }
}

/** In-process change listener, e.g. to purge a CDN through its SDK. Pass as `invalidation.onChange`. */
export function acmeOnChange(purge: (urls: string[]) => Promise<void>) {
  return async (event: ContentChangeEvent) => {
    await purge(event.urls)
  }
}
