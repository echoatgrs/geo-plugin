import { describe, expect, it } from 'vitest'
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  lexicalToMarkdown,
  richTextToMarkdown,
  strapiBlocksToMarkdown,
  summarizeHits,
  toLlmsDocument,
  type StatsHit,
} from './index.js'

const text = (t: string, format = 0) => ({ type: 'text', text: t, format })

describe('lexicalToMarkdown', () => {
  it('converts headings, inline formats, links, lists and code', () => {
    const md = lexicalToMarkdown({
      root: {
        children: [
          { type: 'heading', tag: 'h2', children: [text('Intro')] },
          { type: 'paragraph', children: [text('Hello '), text('world', 1), text(' and '), text('code', 16)] },
          { type: 'paragraph', children: [{ type: 'link', fields: { url: 'https://x.test' }, children: [text('link')] }] },
          {
            type: 'list',
            listType: 'number',
            children: [
              { type: 'listitem', children: [text('one')] },
              { type: 'listitem', children: [text('two'), { type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [text('nested')] }] }] },
            ],
          },
          { type: 'quote', children: [text('quoted')] },
          { type: 'upload', value: { url: '/media/a.png', alt: 'A' } },
        ],
      },
    })
    expect(md).toBe(
      '## Intro\n\nHello **world** and `code`\n\n[link](https://x.test)\n\n1. one\n2. two\n  - nested\n\n> quoted\n\n![A](/media/a.png)',
    )
  })
})

describe('strapiBlocksToMarkdown', () => {
  it('converts Strapi 5 blocks', () => {
    const md = strapiBlocksToMarkdown([
      { type: 'heading', level: 3, children: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'Bold', bold: true }, { type: 'text', text: ' ' }, { type: 'link', url: '/a', children: [{ type: 'text', text: 'go' }] }] },
      { type: 'list', format: 'unordered', children: [{ type: 'list-item', children: [{ type: 'text', text: 'item' }] }] },
      { type: 'code', children: [{ type: 'text', text: 'npm i' }] },
    ])
    expect(md).toBe('### Title\n\n**Bold** [go](/a)\n\n- item\n\n```\nnpm i\n```')
  })

  it('passes Markdown strings through', () => {
    expect(richTextToMarkdown('  # Hi  ')).toBe('# Hi')
    expect(richTextToMarkdown(null)).toBe('')
  })
})

describe('llms.txt', () => {
  const docs = [
    toLlmsDocument(
      { title: 'Pricing [2026]', slug: 'pricing', excerpt: 'Plans\nand prices', content: '# Pricing\n\nFree.' },
      { name: 'pages', siteURL: 'https://site.test/', source: { section: 'Docs' }, markdown: richTextToMarkdown },
    )!,
    toLlmsDocument(
      { name: 'Hello', id: 3 },
      { name: 'posts', siteURL: 'https://site.test', source: { url: (d) => `/blog/${d.id}` }, markdown: richTextToMarkdown },
    )!,
  ]

  it('skips documents without a URL', () => {
    expect(toLlmsDocument({ title: 'x' }, { name: 'p', siteURL: 'https://s', source: {}, markdown: String })).toBeNull()
  })

  it('builds llms.txt grouped by section', () => {
    expect(buildLlmsTxt({ name: 'Acme', description: 'We make things.' }, docs)).toBe(
      '# Acme\n\n> We make things.\n\n## Docs\n\n- [Pricing \\[2026\\]](https://site.test/pages/pricing): Plans and prices\n\n## posts\n\n- [Hello](https://site.test/blog/3)\n',
    )
  })

  it('builds llms-full.txt with each document body', () => {
    const full = buildLlmsFullTxt({ name: 'Acme' }, docs)
    expect(full).toContain('URL: https://site.test/pages/pricing')
    expect(full).toContain('# Pricing\n\nFree.')
  })
})

describe('summarizeHits', () => {
  const now = new Date('2026-10-30T12:00:00Z')
  const hit = (over: Partial<StatsHit>): StatsHit => ({
    botId: 'gptbot',
    platform: 'OpenAI',
    purpose: 'training',
    verification: 'verified',
    path: '/a',
    timestamp: '2026-10-30T08:00:00Z',
    ...over,
  })

  it('aggregates the window and finds content never crawled', () => {
    const stats = summarizeHits(
      [
        hit({}),
        hit({ path: '/a/?ref=x', purpose: 'user', botId: 'chatgpt-user' }),
        hit({ platform: 'Anthropic', path: '/llms.txt', timestamp: '2026-10-28T01:00:00Z', verification: 'unverifiable' }),
        hit({ verification: 'spoofed', path: '/b' }),
        hit({ timestamp: '2026-10-01T00:00:00Z' }), // outside the window
      ],
      { days: 7, now, contentPaths: ['https://site.test/a', '/b', '/c'] },
    )
    expect(stats.total).toBe(3)
    expect(stats.userFetches).toBe(1)
    expect(stats.llmsTxtReads).toBe(1)
    expect(stats.byVerification).toEqual({ verified: 2, spoofed: 1, unverifiable: 1 })
    expect(stats.byPlatform).toEqual([{ platform: 'OpenAI', total: 2, user: 1 }, { platform: 'Anthropic', total: 1, user: 0 }])
    expect(stats.daily).toHaveLength(7)
    expect(stats.daily.at(-1)).toEqual({ date: '2026-10-30', total: 2, user: 1 })
    expect(stats.topPaths[0]).toEqual({ path: '/a', total: 2, user: 1 })
    // spoofed hit on /b does not count as crawled
    expect(stats.neverCrawled).toEqual(['/b', '/c'])
    expect(stats.coverage).toBeCloseTo(1 / 3)
  })

  it('counts a read of the .md version as a read of the page', () => {
    const stats = summarizeHits([hit({ path: '/blog/a.md' })], { days: 7, now, contentPaths: ['https://site.test/blog/a'] })
    expect(stats.topPaths[0]).toMatchObject({ path: '/blog/a' })
    expect(stats.neverCrawled).toEqual([])
  })
})
