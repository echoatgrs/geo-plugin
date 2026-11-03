import { describe, expect, it } from 'vitest'
import {
  createContentConverter,
  defaultConverter,
  defineBots,
  defineRules,
  detectBot,
  createIPVerifier,
  inspectDocument,
  mapLlmsDocument,
  runRules,
  withRules,
  AI_BOTS,
  PAYLOAD_SEO_PLUGIN,
  type InspectOptions,
} from './index.js'

const t = (text: string, format = 0) => ({ type: 'text', text, format })
const p = (...children: unknown[]) => ({ type: 'paragraph', children })
const lexical = (...children: unknown[]) => ({ root: { type: 'root', children } })

describe('content converter: Payload', () => {
  it('converts nested layout blocks in editing order', () => {
    const layout = [
      { blockType: 'content', id: 'a', columns: [{ size: 'half', richText: lexical(p(t('Left column'))) }, { size: 'half', richText: lexical(p(t('Right column'))) }] },
      { blockType: 'mediaBlock', id: 'b', media: { id: 7, url: '/media/hero.png', alt: 'Hero' } },
      { blockType: 'code', id: 'c', language: 'ts', code: 'const a = 1\n' },
      { blockType: 'banner', id: 'd', style: 'info', content: lexical(p(t('Heads up'))) },
    ]
    const r = defaultConverter.convert(layout, { mediaURL: 'https://cms.test', path: 'layout' })
    expect(r.markdown).toBe('Left column\n\nRight column\n\n![Hero](https://cms.test/media/hero.png)\n\n```ts\nconst a = 1\n```\n\n> Heads up')
    expect(r.warnings).toEqual([])
  })

  it('handles Lexical block nodes, tables, uploads, relationships and internal links', () => {
    const value = lexical(
      { type: 'heading', tag: 'h2', children: [t('Specs')] },
      {
        type: 'table',
        children: [
          { type: 'tablerow', children: [{ type: 'tablecell', headerState: 1, children: [p(t('Name'))] }, { type: 'tablecell', children: [p(t('Value'))] }] },
          { type: 'tablerow', children: [{ type: 'tablecell', children: [p(t('a|b'))] }, { type: 'tablecell', children: [p(t('1'))] }] },
        ],
      },
      { type: 'block', fields: { blockType: 'code', language: 'sh', code: 'echo ```hi```' } },
      { type: 'upload', relationTo: 'media', value: { id: 1, url: '/m/a.png', alt: 'A' } },
      { type: 'relationship', relationTo: 'posts', value: { id: 2, title: 'Other post', slug: 'other' } },
      p({ type: 'link', fields: { linkType: 'internal', doc: { relationTo: 'posts', value: { id: 3, slug: 'x', title: 'X' } } }, children: [t('see X')] }),
    )
    const r = defaultConverter.convert(value, { linkFor: (doc, rel) => (rel === 'posts' ? `https://site.test/blog/${doc.slug}` : null) })
    expect(r.markdown).toBe(
      [
        '## Specs',
        '| Name | Value |\n| --- | --- |\n| a\\|b | 1 |',
        '````sh\necho ```hi```\n````',
        '![A](/m/a.png)',
        '[Other post](https://site.test/blog/other)',
        '[see X](https://site.test/blog/x)',
      ].join('\n\n'),
    )
    expect(r.warnings).toEqual([])
  })

  it('reports relations and uploads the public could not read (left as ids)', () => {
    const r = defaultConverter.convert(lexical({ type: 'upload', relationTo: 'media', value: 12 }, { type: 'relationship', relationTo: 'secret', value: 'abc' }, p(t('after'))))
    expect(r.markdown).toBe('after')
    expect(r.warnings.map((w) => w.code)).toEqual(['relation-unavailable', 'relation-unavailable'])
    expect(r.warnings[0]!.path).toBe('.root.children[0]')
  })

  it('reports unknown blocks with type and path, and skips them only when told to', () => {
    const blocks = [{ blockType: 'pricingTable', plans: [{ secret: 'internal' }] }, { blockType: 'content', richText: 'Kept' }]
    const r = defaultConverter.convert(blocks, { path: 'layout' })
    expect(r.markdown).toBe('Kept')
    expect(r.markdown).not.toContain('internal')
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'unknown-block', type: 'pricingTable', path: 'layout[0]', count: 1 })])
    expect(createContentConverter({ unknown: 'skip' }).convert(blocks).warnings).toEqual([])
    expect(createContentConverter({ blocks: { pricingTable: false } }).convert(blocks).warnings).toEqual([])
  })

  it('uses registered converters before built-ins, without touching the plugin', () => {
    const converter = createContentConverter({
      blocks: {
        pricingTable: (b, ctx) => b.plans.map((plan: any, i: number) => `- ${plan.name}: ${ctx.convert(plan.description, `plans[${i}].description`)}`).join('\n'),
        code: (b) => `CODE:${b.code}`,
      },
      nodes: { mention: (n) => `@${n.user}` },
    })
    const r = converter.convert([
      { blockType: 'pricingTable', plans: [{ name: 'Free', description: 'For **you**' }] },
      { blockType: 'code', code: 'x' },
      { blockType: 'content', richText: lexical(p(t('Hi '), { type: 'mention', user: 'ann' })) },
    ])
    expect(r.markdown).toBe('- Free: For **you**\n\nCODE:x\n\nHi @ann')
  })

  it('isolates converter errors and invalid output, without stacks or source data', () => {
    const converter = createContentConverter({
      blocks: {
        broken: () => {
          throw new Error('boom\n    at secret/file.ts:1')
        },
        weird: () => 42 as unknown as string,
      },
    })
    const r = converter.convert([{ blockType: 'broken', password: 'hunter2' }, { blockType: 'weird' }, { blockType: 'content', richText: 'ok' }], { path: 'layout' })
    expect(r.markdown).toBe('ok')
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'converter-error', type: 'broken', path: 'layout[0]', message: 'Converter for "broken" failed: boom' }),
      expect.objectContaining({ code: 'invalid-output', type: 'weird', path: 'layout[1]' }),
    ])
    expect(JSON.stringify(r.warnings)).not.toContain('hunter2')
    expect(JSON.stringify(r.warnings)).not.toContain('secret/file.ts')
  })

  it('stops reference cycles between related documents', () => {
    const a: any = { id: 1, title: 'A' }
    const b: any = { id: 2, title: 'B', related: a }
    a.related = b
    const converter = createContentConverter({
      blocks: {
        ref: (block, ctx) => {
          const doc = ctx.relation(block.doc, 'doc', 'posts')
          if (!doc) return ''
          const inner = doc.related ? ctx.convert({ blockType: 'ref', doc: doc.related }, 'related') : ''
          return inner ? `${doc.title} > ${inner}` : doc.title
        },
      },
    })
    const r = converter.convert({ blockType: 'ref', doc: a })
    expect(r.markdown).toBe('A > B')
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'cycle', type: 'posts', path: 'related.related.doc' })])
  })

  it('enforces depth, node and output limits with visible warnings', () => {
    let deep: any = { blockType: 'section', blocks: [{ blockType: 'content', richText: 'bottom' }] }
    for (let i = 0; i < 30; i++) deep = { blockType: 'section', blocks: [deep] }
    const depth = defaultConverter.convert(deep)
    expect(depth.truncated).toBe(true)
    expect(depth.warnings[0]!.code).toBe('depth-limit')

    const many = Array.from({ length: 200 }, (_, i) => ({ blockType: 'content', richText: `p${i}` }))
    const nodes = createContentConverter({ limits: { maxNodes: 50 } }).convert(many)
    expect(nodes.truncated).toBe(true)
    expect(nodes.warnings.map((w) => w.code)).toEqual(['node-limit'])

    const out = createContentConverter({ limits: { maxOutputChars: 100 } }).convert('x'.repeat(500))
    expect(out.markdown.length).toBeLessThan(200)
    expect(out.markdown).toContain('truncated')
    expect(out.warnings[0]!.code).toBe('output-limit')
  })

  it('never walks arbitrary keys for text', () => {
    const r = defaultConverter.convert({ title: 'x', internalNotes: 'do not leak', nested: { text: 'nor this' } })
    expect(r.markdown).toBe('')
    expect(r.warnings[0]!.code).toBe('unsupported-value')
  })
})

describe('content converter: Strapi', () => {
  it('converts a dynamic zone with nested components, media and Blocks', () => {
    const dz = [
      { __component: 'shared.rich-text', id: 1, body: '## Intro\n\nMarkdown body.' },
      { __component: 'shared.quote', id: 2, title: 'Ada', body: 'Quote text' },
      { __component: 'shared.media', id: 3, file: { url: '/uploads/a.png', alternativeText: 'Pic' } },
      { __component: 'shared.slider', id: 4, files: [{ url: '/uploads/b.png', alternativeText: 'B' }, { url: '/uploads/c.png' }] },
      {
        __component: 'layout.section',
        id: 5,
        heading: 'Details',
        blocks: [{ __component: 'shared.faq', items: [{ question: 'Q1?', answer: [{ type: 'paragraph', children: [{ type: 'text', text: 'A1', bold: true }] }] }] }],
      },
    ]
    const r = defaultConverter.convert(dz, { mediaURL: 'https://cms.test', path: 'blocks' })
    expect(r.markdown).toBe(
      [
        '## Intro\n\nMarkdown body.',
        '> Quote text\n>\n> — Ada',
        '![Pic](https://cms.test/uploads/a.png)',
        '![B](https://cms.test/uploads/b.png)\n\n![](https://cms.test/uploads/c.png)',
        '## Details\n\n### Q1?\n\n**A1**',
      ].join('\n\n'),
    )
    expect(r.warnings).toEqual([])
  })

  it('matches component converters by full UID first, then by name', () => {
    const converter = createContentConverter({ blocks: { 'marketing.quote': () => 'MARKETING', quote: () => 'ANY QUOTE' } })
    expect(converter.toMarkdown([{ __component: 'marketing.quote' }, { __component: 'shared.quote' }])).toBe('MARKETING\n\nANY QUOTE')
  })

  it('reports media the public role could not read (removed by the sanitizer)', () => {
    const r = defaultConverter.convert([{ __component: 'shared.media', file: 5 }])
    expect(r.markdown).toBe('')
    expect(r.warnings[0]).toEqual(expect.objectContaining({ code: 'relation-unavailable', path: '[0].file' }))
  })
})

describe('field resolution', () => {
  const base = { name: 'posts', siteURL: 'https://site.test' }
  it('prefers explicit GEO fields, then SEO fields, then defaults, and says which was used', () => {
    const doc = { slug: 'a', title: 'Title', geoSummary: 'GEO summary', meta: { title: 'SEO title | Site', description: 'SEO desc', image: { url: '/m.png' } }, excerpt: 'Excerpt' }
    const seoOnly = mapLlmsDocument(doc, { ...base, source: { seo: PAYLOAD_SEO_PLUGIN } })
    expect(seoOnly.document!.title).toBe('SEO title | Site')
    expect(seoOnly.document!.description).toBe('SEO desc')
    expect(seoOnly.sources.origins).toMatchObject({ title: 'seo', description: 'seo', image: 'seo' })
    const explicit = mapLlmsDocument(doc, { ...base, source: { seo: PAYLOAD_SEO_PLUGIN, fields: { title: 'title', description: ['geoSummary'] } } })
    expect(explicit.document!.title).toBe('Title')
    expect(explicit.document!.description).toBe('GEO summary')
    expect(explicit.sources.origins).toMatchObject({ title: 'config', description: 'config' })
    const missingSeo = mapLlmsDocument({ slug: 'a', title: 'T', meta: {} }, { ...base, source: { seo: PAYLOAD_SEO_PLUGIN } })
    expect(missingSeo.document!.title).toBe('T')
    expect(missingSeo.sources.origins.title).toBe('default')
    // Host SEO data is read, never written.
    expect(doc.meta.title).toBe('SEO title | Site')
  })

  it('supports nested paths, resolver functions and fallbacks, and reports resolver errors', () => {
    const resolver = Object.assign((d: any) => d.hero?.headline, { label: 'heroHeadline' })
    const m = mapLlmsDocument({ slug: 'a', hero: { headline: 'From hero' } }, { ...base, source: { fields: { title: [resolver, 'title'] } } })
    expect(m.document!.title).toBe('From hero')
    expect(m.sources.title).toBe('heroHeadline()')
    const broken = mapLlmsDocument({ slug: 'a', title: 'T' }, { ...base, source: { fields: { description: () => { throw new Error('nope') } } } })
    expect(broken.fieldErrors).toEqual({ description: 'nope' })
    expect(() => mapLlmsDocument({ slug: 'a' }, { ...base, source: { fields: { description: () => { throw new Error('nope') } } } }, true)).toThrow('nope')
  })

  it('joins several content fields in order', () => {
    const m = mapLlmsDocument(
      { slug: 'a', title: 'T', intro: 'Intro text', layout: [{ blockType: 'content', richText: 'Layout text' }] },
      { ...base, source: { contentFields: ['intro', 'layout'] }, converter: defaultConverter },
    )
    expect(m.document!.markdown).toBe('Intro text\n\nLayout text')
    expect(m.sources.content).toBe('intro, layout')
  })

  it('uses a canonical from the SEO fields in JSON-LD and Markdown, and warns when it differs', () => {
    const options: InspectOptions = {
      ...base,
      source: { seo: { canonical: 'seo.canonicalURL' } },
      site: { name: 'Site', url: 'https://site.test' },
      state: { saved: true, published: true, publicVisible: true },
    }
    const res = inspectDocument({ slug: 'a', title: 'T', seo: { canonicalURL: 'https://other.test/a' } }, options)
    expect(res.document!.canonical).toBe('https://other.test/a')
    expect(res.markdown).toContain('Canonical: https://other.test/a')
    expect(res.checks.find((c) => c.ruleId === 'GEO-CANONICAL')).toMatchObject({ status: 'warning', fieldPath: 'seo.canonicalURL' })
    const same = inspectDocument({ slug: 'a', title: 'T', seo: { canonicalURL: '/posts/a' } }, options)
    expect(same.checks.find((c) => c.ruleId === 'GEO-CANONICAL')!.status).toBe('pass')
  })
})

describe('inspection with conversion warnings', () => {
  it('shows unknown blocks as GEO-CONVERSION with the block type and location', () => {
    const res = inspectDocument(
      { slug: 'a', title: 'T', layout: [{ blockType: 'hero' }, { blockType: 'content', richText: 'Body' }] },
      {
        name: 'pages',
        siteURL: 'https://site.test',
        source: { contentField: 'layout' },
        converter: defaultConverter,
        site: { name: 'S', url: 'https://site.test' },
        state: { saved: true, published: true, publicVisible: true },
      },
    )
    const check = res.checks.find((c) => c.ruleId === 'GEO-CONVERSION')!
    expect(check.status).toBe('warning')
    expect(check.message).toContain('unknown-block "hero" at layout[0]')
    expect(check.fieldPath).toBe('layout[0]')
    expect(res.conversion.warnings).toHaveLength(1)
  })
})

describe('custom rules', () => {
  const ctx = {
    values: { title: 'Lorem ipsum' },
    document: null,
    markdown: 'Lorem ipsum dolor',
    sources: { url: null, title: 'title', description: null, content: null, image: null, author: null, published: null, updated: null, canonical: null, faq: null, origins: {} },
    state: { saved: true, published: true, publicVisible: true },
    collection: 'posts',
  }

  it('validates ids at config time', () => {
    const ok = { id: 'ACME-NO-LOREM', check: () => null }
    expect(defineRules([ok])).toHaveLength(1)
    expect(() => defineRules([ok, ok])).toThrow(/duplicate/)
    expect(() => defineRules([{ id: 'GEO-TITLE', check: () => null }])).toThrow(/reserved/)
    expect(() => defineRules([{ id: 'LD-MINE', check: () => null }])).toThrow(/reserved/)
    expect(() => defineRules([{ id: 'lowercase', check: () => null }])).toThrow(/invalid rule id/)
    expect(() => defineRules([{ id: 'ACME-X' } as never])).toThrow(/check/)
  })

  it('runs in registration order with params, and isolates throws, timeouts and invalid results', async () => {
    const results = await runRules(
      [
        { id: 'ACME-NO-LOREM', params: { word: 'lorem' }, check: ({ markdown, params }) => (markdown.toLowerCase().includes(params.word as string) ? { status: 'warning', message: 'Placeholder text.', fieldPath: 'content' } : { status: 'pass', message: 'ok' }) },
        { id: 'ACME-THROWS', check: () => { throw new Error('bad rule') } },
        { id: 'ACME-SLOW', check: () => new Promise((r) => setTimeout(() => r({ status: 'pass', message: 'late' }), 500)) },
        { id: 'ACME-INVALID', check: () => ({ status: 'great', message: '' }) as never },
        { id: 'ACME-SKIP', collections: ['pages'], check: () => ({ status: 'error', message: 'never' }) },
        { id: 'ACME-NA', check: () => null },
      ],
      ctx,
      { timeoutMs: 50 },
    )
    expect(results.map((r) => [r.ruleId, r.status])).toEqual([
      ['ACME-NO-LOREM', 'warning'],
      ['ACME-THROWS', 'error'],
      ['ACME-SLOW', 'error'],
      ['ACME-INVALID', 'error'],
    ])
    expect(results[0]!.fieldPath).toBe('content')
    expect(results[2]!.message).toContain('timed out')
  })

  it('appends to an inspection after the built-in checks', async () => {
    const inspection = inspectDocument({ slug: 'a', title: 'T' }, { name: 'p', siteURL: 'https://s.test', source: {}, site: { name: 'S', url: 'https://s.test' }, state: { saved: true, published: true, publicVisible: true } })
    const out = await withRules(inspection, [{ id: 'ACME-ONE', check: () => ({ status: 'pass', message: 'one' }) }], { values: {}, state: inspection.checks as never, collection: 'p' })
    expect(out.checks.at(-1)!.ruleId).toBe('ACME-ONE')
    expect(out.checks.length).toBe(inspection.checks.length + 1)
  })
})

describe('custom bots', () => {
  it('adds validated bots with predictable detection order', () => {
    const bots = defineBots([{ id: 'acme-bot', name: 'AcmeBot', platform: 'Acme', purpose: 'user', uaToken: 'AcmeBot-User', ipRanges: ['203.0.113.0/24'] }])
    expect(detectBot('Mozilla/5.0 AcmeBot-User/1.0', bots)!.id).toBe('acme-bot')
    expect(detectBot('Mozilla/5.0 GPTBot/1.2', bots)!.id).toBe('gptbot')
    expect(bots.length).toBe(AI_BOTS.length + 1)
  })

  it('refuses broad, duplicate or ambiguous tokens', () => {
    const bot = (over: object) => ({ id: 'x-bot', name: 'X', platform: 'X', purpose: 'search' as const, uaToken: 'XCrawler', ...over })
    expect(() => defineBots([bot({ uaToken: 'bot' })])).toThrow(/at least 4|too generic/)
    expect(() => defineBots([bot({ uaToken: 'Crawler' })])).toThrow(/too generic/)
    expect(() => defineBots([bot({ uaToken: 'GPT' })])).toThrow()
    expect(() => defineBots([bot({ uaToken: 'PTBo' })])).toThrow(/part of GPTBot/)
    expect(() => defineBots([bot({ id: 'gptbot' })])).toThrow(/duplicate bot id/)
    expect(() => defineBots([bot({ uaToken: 'gptbot' })])).toThrow(/already uses/)
    expect(() => defineBots([bot({ purpose: 'spy' })])).toThrow(/purpose/)
    expect(defineBots([bot({ id: 'gptbot', uaToken: 'GPTBot-Next' })], { replace: true }).find((b) => b.id === 'gptbot')!.uaToken).toBe('GPTBot-Next')
  })

  it('verifies with static ranges or a custom verifier, with a time limit', async () => {
    const verifier = createIPVerifier({ fetch: async () => new Response('{}', { status: 500 }), verifyTimeoutMs: 30 })
    const ranged = { id: 'r', name: 'R', platform: 'R', purpose: 'search' as const, uaToken: 'RangedBot', ipRanges: ['203.0.113.0/24'] }
    expect(await verifier.verify(ranged, '203.0.113.9')).toBe('verified')
    expect(await verifier.verify(ranged, '198.51.100.1')).toBe('spoofed')
    const custom = { ...ranged, verify: (ip: string) => (ip === '1.1.1.1' ? ('verified' as const) : ('spoofed' as const)) }
    expect(await verifier.verify(custom, '1.1.1.1')).toBe('verified')
    const slow = { ...ranged, verify: () => new Promise<'verified'>((r) => setTimeout(() => r('verified'), 200)) }
    expect(await verifier.verify(slow, '1.1.1.1')).toBe('unverifiable')
    const throws = { ...ranged, verify: () => { throw new Error('dns down') } }
    expect(await verifier.verify(throws, '1.1.1.1')).toBe('unverifiable')
  })
})
