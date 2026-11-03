import { PAYLOAD_SEO_PLUGIN } from '@garus-ltd/geo-core'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from 'payload'
import { geoPlugin } from './index.js'

const base = {
  collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'meta', type: 'group', fields: [] }], versions: { drafts: true } }],
  endpoints: [],
} as unknown as Config

function call(config: Config, path: string, docs: Record<string, any>[]) {
  const url = new URL(path, 'http://cms.test')
  const handler = config.endpoints!.find((e) => e.path === url.pathname.replace('/api', ''))!.handler
  const req = { url: url.href, headers: new Headers(), payload: { find: vi.fn(async () => ({ docs })), logger: { warn: vi.fn() } } }
  return handler(req as never)
}

const post = (meta: Record<string, unknown> | undefined, extra: object = {}) => ({ id: 1, title: 'Post title', slug: 'a', _status: 'published', excerpt: 'Excerpt', meta, ...extra })

describe('SEO plugin collaboration (Payload)', () => {
  const llms = (source: object = {}, more: object = {}) => ({ siteURL: 'https://site.test', name: 'Acme', collections: { posts: { url: (d: any) => `/blog/${d.slug}`, seo: PAYLOAD_SEO_PLUGIN, jsonLd: { type: 'BlogPosting' }, ...source } }, ...more })

  it('only GEO fields: unchanged output when no SEO values exist', async () => {
    const config = geoPlugin({ llms: llms({ seo: undefined }) })(base)
    const data = await (await call(config, '/api/geo/jsonld?path=/blog/a', [post(undefined)])).json()
    expect(data['@graph'][0]).toMatchObject({ headline: 'Post title', description: 'Excerpt', url: 'https://site.test/blog/a' })
  })

  it('only SEO fields: SEO title, description and image are the fallback before defaults', async () => {
    const config = geoPlugin({ llms: llms() })(base)
    const doc = post({ title: 'SEO title', description: 'SEO description', image: { url: '/m/seo.png' } }, { title: undefined, excerpt: undefined })
    const data = await (await call(config, '/api/geo/jsonld?path=/blog/a', [doc])).json()
    expect(data['@graph'][0]).toMatchObject({ headline: 'SEO title', description: 'SEO description', image: ['https://site.test/m/seo.png'] })
  })

  it('both: explicit GEO fields win, SEO fills the gaps, host data is not modified', async () => {
    const config = geoPlugin({ llms: llms({ fields: { title: 'title', description: 'excerpt' } }) })(base)
    const meta = Object.freeze({ title: 'SEO title', description: 'SEO description', image: Object.freeze({ url: '/m/seo.png' }) })
    const data = await (await call(config, '/api/geo/jsonld?path=/blog/a', [post(meta)])).json()
    expect(data['@graph'][0]).toMatchObject({ headline: 'Post title', description: 'Excerpt', image: ['https://site.test/m/seo.png'] })
  })

  it('missing SEO group and nested fields fall through to the defaults', async () => {
    const config = geoPlugin({ llms: llms({ seo: { ...PAYLOAD_SEO_PLUGIN, canonical: 'meta.advanced.canonical' } }) })(base)
    const data = await (await call(config, '/api/geo/jsonld?path=/blog/a', [post({ advanced: {} })])).json()
    expect(data['@graph'][0]).toMatchObject({ headline: 'Post title', url: 'https://site.test/blog/a' })
    const canonical = await (await call(config, '/api/geo/jsonld?path=/blog/a', [post({ advanced: { canonical: 'https://other.test/a' } })])).json()
    expect(canonical['@graph'][0]).toMatchObject({ url: 'https://other.test/a', '@id': 'https://other.test/a#article' })
  })

  it('hostManaged types are omitted only when the frontend asks for omit=host', async () => {
    const config = geoPlugin({ llms: llms({ faqField: 'faq' }, { hostManaged: ['BlogPosting'], organization: { name: 'Acme Inc.' } }) })(base)
    const doc = post(undefined, { faq: [{ question: 'Q?', answer: 'A' }] })
    const all = await (await call(config, '/api/geo/jsonld?path=/blog/a', [doc])).json()
    expect(all['@graph'].map((n: any) => n['@type'])).toEqual(['BlogPosting', 'FAQPage', 'Organization'])
    const page = await (await call(config, '/api/geo/jsonld?path=/blog/a&omit=host', [doc])).json()
    expect(page['@graph'].map((n: any) => n['@type'])).toEqual(['FAQPage', 'Organization'])
    const custom = await (await call(config, '/api/geo/jsonld?path=/blog/a&omit=FAQPage,<script>', [doc])).json()
    expect(custom['@graph'].map((n: any) => n['@type'])).toEqual(['BlogPosting', 'Organization'])
  })
})
