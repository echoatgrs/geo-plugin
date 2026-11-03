import { describe, expect, it } from 'vitest'
import { documentMarkdown, externalValidators, inspectDocument, richTextToMarkdown, serializeJsonLd, toLlmsDocument, type InspectOptions } from './index.js'

const site = { name: 'Acme', url: 'https://site.test' }
const blocks = (...texts: string[]) => texts.map((t) => ({ type: 'paragraph', children: [{ type: 'text', text: t }] }))
const base = (over: Partial<InspectOptions> = {}): InspectOptions => ({
  name: 'articles',
  siteURL: 'https://site.test',
  mediaURL: 'https://cms.test',
  source: { url: (d) => (d.slug ? `/blog/${d.slug}` : null), faqField: 'faq', jsonLd: { type: 'BlogPosting' } },
  markdown: richTextToMarkdown,
  site,
  state: { saved: true, published: true, publicVisible: true },
  ...over,
})
const byId = (checks: { ruleId: string }[], id: string) => checks.find((c) => c.ruleId === id) as any

const full = {
  title: '你好 GEO',
  slug: 'hello',
  description: 'A description that is long enough to pass the default fifty character check.',
  content: [{ type: 'heading', level: 2, children: [{ type: 'text', text: '小标题' }] }, ...blocks('正文 **x** </script><script>alert(1)</script>')],
  author: { name: '张三' },
  cover: { url: '/uploads/a.png' },
  publishedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  faq: [{ question: '这是什么？', answer: '一个测试' }],
}

describe('inspectDocument', () => {
  it('passes a complete document and builds the same output as the public routes', () => {
    const opts = base({ source: { ...base().source, imageField: 'cover' } })
    const res = inspectDocument(full, opts)
    const failing = res.checks.filter((c) => c.status === 'error' || c.status === 'warning')
    expect(failing).toEqual([])
    const publicDoc = toLlmsDocument(full, opts)!
    expect(res.markdown).toBe(documentMarkdown(publicDoc))
    expect(res.jsonLdScript).toBe(serializeJsonLd(res.jsonLd))
    expect(res.jsonLdScript).not.toContain('</script')
    expect(res.markdown).toContain('正文')
    expect(res.validation.every((v) => v.status === 'pass' || v.status === 'notApplicable')).toBe(true)
    expect(res.diagnostics.find((d) => d.property === 'image')).toEqual({ property: 'image', field: 'cover', value: 'https://cms.test/uploads/a.png', origin: 'config' })
    for (const c of res.checks) expect(Object.keys(c)).toEqual(expect.arrayContaining(['ruleId', 'status', 'message', 'suggestion']))
  })

  it('does not crash on an empty unsaved document and says what it cannot judge yet', () => {
    const res = inspectDocument({}, base({ state: { saved: false, published: null, publicVisible: null } }))
    expect(byId(res.checks, 'GEO-TITLE').status).toBe('error')
    expect(byId(res.checks, 'GEO-BODY').status).toBe('error')
    expect(byId(res.checks, 'GEO-URL').status).toBe('warning')
    expect(byId(res.checks, 'GEO-STATUS').status).toBe('notApplicable')
    expect(byId(res.checks, 'GEO-PUBLIC').status).toBe('notApplicable')
    expect(byId(res.checks, 'GEO-DATES').status).toBe('notApplicable')
    expect(res.markdown).toBeNull()
    expect(res.validation[0]).toMatchObject({ ruleId: 'LD-ENABLED', status: 'error' })
  })

  it('reports fallbacks, empty FAQ items, bad dates and broken field paths', () => {
    const res = inspectDocument(
      { title: 'T', slug: 't', content: 'Markdown body', publishedAt: 'not a date', faq: [{ question: 'Q', answer: '' }, { question: 'Q2', answer: 'A2' }] },
      base({ source: { ...base().source, imageField: 'hero' }, knownFields: ['title', 'slug', 'content', 'publishedAt', 'faq'] }),
    )
    expect(byId(res.checks, 'GEO-AUTHOR')).toMatchObject({ status: 'warning', fieldPath: 'author' })
    expect(byId(res.checks, 'GEO-DATES').status).toBe('error')
    expect(byId(res.checks, 'GEO-FAQ').message).toContain('1 of 2')
    expect(byId(res.checks, 'GEO-FIELDS')).toMatchObject({ status: 'error', fieldPath: 'hero' })
    expect(res.diagnostics.find((d) => d.property === 'author')).toMatchObject({ field: null, fallback: 'organization "Acme"' })
  })

  it('handles nested fields, relative images without mediaURL and unknown rich text', () => {
    const res = inspectDocument(
      { title: 'T', slug: 't', meta: { description: 'nested description that is definitely more than fifty characters' }, content: { weird: true }, image: '/a.png' },
      base({ mediaURL: undefined, siteURL: 'https://site.test' }),
    )
    expect(byId(res.checks, 'GEO-DESCRIPTION')).toMatchObject({ status: 'pass', fieldPath: 'meta.description' })
    expect(byId(res.checks, 'GEO-BODY').message).toContain('converts to empty')
    expect(byId(res.checks, 'GEO-IMAGE').status).toBe('pass')
  })

  it('flags a url() that throws without throwing itself', () => {
    const res = inspectDocument({ title: 'x' }, base({ source: { url: () => { throw new Error('no slug') } } }))
    expect(byId(res.checks, 'GEO-URL')).toMatchObject({ status: 'error', message: 'url() threw: no slug' })
  })

  it('shows "not configured" for sources unless a field is mapped', () => {
    expect(byId(inspectDocument(full, base()).checks, 'GEO-SOURCES')).toMatchObject({ status: 'notApplicable' })
    expect(byId(inspectDocument(full, base({ sourcesField: 'refs' })).checks, 'GEO-SOURCES').status).toBe('warning')
    expect(byId(inspectDocument({ ...full, refs: ['https://x'] }, base({ sourcesField: 'refs' })).checks, 'GEO-SOURCES').status).toBe('pass')
  })

  it('suggests subheadings only for long bodies, as a warning', () => {
    const long = { ...full, content: blocks('x'.repeat(2000)) }
    expect(byId(inspectDocument(long, base()).checks, 'GEO-HEADINGS').status).toBe('warning')
    expect(byId(inspectDocument({ ...full, content: blocks('short') }, base()).checks, 'GEO-HEADINGS').status).toBe('pass')
  })

  it('validates JSON-LD dates and URLs', () => {
    const res = inspectDocument({ ...full, updatedAt: 'bogus' }, base({ siteURL: 'not-a-url' }))
    expect(byId(res.validation, 'LD-URLS').status).toBe('error')
    expect(byId(res.checks, 'GEO-URL').status).toBe('error')
  })

  it('offers external validators only for a URL', () => {
    expect(externalValidators('https://site.test/a')[0]!.url).toContain(encodeURIComponent('https://site.test/a'))
  })
})
