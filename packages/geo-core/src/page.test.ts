import { describe, expect, it } from 'vitest'
import {
  buildJsonLd,
  buildLlmsTxt,
  documentMarkdown,
  findDocumentByPath,
  markdownSourcePath,
  markdownURL,
  richTextToMarkdown,
  serializeJsonLd,
  toLlmsDocument,
} from './index.js'

const site = { name: 'Acme', url: 'https://site.test', logo: '/logo.png', language: 'en' }

const post = toLlmsDocument(
  {
    title: 'Hello world',
    slug: 'hello',
    excerpt: 'First post',
    content: '## Intro\n\nBody text.',
    publishedAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    author: { name: 'Dana' },
    heroImage: { url: '/media/hero.png' },
    faq: [
      { question: 'Is it free?', answer: 'Yes, **MIT**.' },
      { question: '', answer: 'skipped' },
    ],
  },
  {
    name: 'posts',
    siteURL: 'https://site.test',
    mediaURL: 'https://cms.test',
    source: { url: (d) => `/blog/${d.slug}`, faqField: 'faq', jsonLd: { type: 'BlogPosting', extend: () => ({ keywords: 'geo' }) } },
    markdown: richTextToMarkdown,
  },
)!

describe('per-page Markdown', () => {
  it('renders title, metadata, summary, body and FAQ', () => {
    expect(documentMarkdown(post)).toBe(
      '# Hello world\n\nURL: https://site.test/blog/hello\nPublished: 2026-10-01\nUpdated: 2026-10-02\nAuthor: Dana\n\n> First post\n\n## Intro\n\nBody text.\n\n## FAQ\n\n### Is it free?\n\nYes, **MIT**.\n',
    )
  })

  it('maps .md paths and URLs both ways', () => {
    expect(markdownSourcePath('/blog/hello.md')).toBe('/blog/hello')
    expect(markdownSourcePath('/index.md')).toBe('/')
    expect(markdownSourcePath('/blog/hello')).toBeNull()
    expect(markdownURL('https://site.test/blog/hello/')).toBe('https://site.test/blog/hello.md')
    expect(markdownURL('https://site.test/')).toBe('https://site.test/index.md')
    expect(buildLlmsTxt({ name: 'Acme' }, [post], { markdownLinks: true })).toContain('(https://site.test/blog/hello.md)')
  })

  it('finds a document by path', () => {
    expect(findDocumentByPath([post], '/blog/hello/?utm=x')).toBe(post)
    expect(findDocumentByPath([post], '/blog/other')).toBeUndefined()
  })
})

describe('buildJsonLd', () => {
  it('builds an article node with publisher, author, image and FAQ', () => {
    expect(buildJsonLd(site, post)).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          '@id': 'https://site.test/blog/hello#article',
          headline: 'Hello world',
          url: 'https://site.test/blog/hello',
          description: 'First post',
          mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://site.test/blog/hello' },
          image: ['https://cms.test/media/hero.png'],
          datePublished: '2026-10-01T08:00:00.000Z',
          dateModified: '2026-10-02T09:00:00.000Z',
          author: [{ '@type': 'Person', name: 'Dana' }],
          publisher: {
            '@type': 'Organization',
            name: 'Acme',
            url: 'https://site.test',
            logo: { '@type': 'ImageObject', url: 'https://site.test/logo.png' },
          },
          inLanguage: 'en',
          keywords: 'geo',
        },
        {
          '@type': 'FAQPage',
          '@id': 'https://site.test/blog/hello#faq',
          mainEntity: [{ '@type': 'Question', name: 'Is it free?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, MIT.' } }],
        },
      ],
    })
  })

  it('uses WebPage fields for non-article types and can be turned off', () => {
    const page = (jsonLd: false | { type: string }) =>
      toLlmsDocument({ title: 'About', slug: 'about' }, { name: 'pages', siteURL: 'https://site.test', source: { jsonLd }, markdown: String })!
    const ld = buildJsonLd(site, page({ type: 'WebPage' })) as { '@graph': Record<string, unknown>[] }
    expect(ld['@graph'][0]).toMatchObject({ '@type': 'WebPage', name: 'About', isPartOf: { '@type': 'WebSite' } })
    expect(ld['@graph'][0]).not.toHaveProperty('author')
    expect(buildJsonLd(site, page(false))).toBeNull()
  })

  it('reads Strapi 4 style relations and falls back to the organization as author', () => {
    const doc = toLlmsDocument(
      { title: 'x', slug: 'x', authors: { data: [{ attributes: { name: 'A' } }, { attributes: { name: 'B' } }] } },
      { name: 'a', siteURL: 'https://site.test', source: {}, markdown: String },
    )!
    expect(doc.authors).toEqual(['A', 'B'])
    const anon = toLlmsDocument({ title: 'y', slug: 'y' }, { name: 'a', siteURL: 'https://site.test', source: {}, markdown: String })!
    expect((buildJsonLd(site, anon) as any)['@graph'][0].author).toEqual({ '@type': 'Organization', name: 'Acme', url: 'https://site.test' })
  })

  it('never puts dateModified before datePublished', () => {
    const doc = { ...post, publishedAt: '2026-11-01T16:33:19.074Z', updatedAt: '2026-11-01T16:33:19.065Z' }
    expect((buildJsonLd(site, doc) as any)['@graph'][0].dateModified).toBe('2026-11-01T16:33:19.074Z')
  })

  it('escapes < so content cannot close the script tag', () => {
    expect(serializeJsonLd({ a: '</script><script>' })).toBe('{"a":"\\u003c/script>\\u003cscript>"}')
  })
})
