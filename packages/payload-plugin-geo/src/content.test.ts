import { describe, expect, it, vi } from 'vitest'
import type { Config } from 'payload'
import { geoPlugin } from './index.js'
import { hydrate } from './inspect.js'

const page = {
  id: 1,
  title: 'Landing',
  slug: 'landing',
  _status: 'published',
  layout: [
    { id: 'b1', blockType: 'content', columns: [{ richText: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Intro', format: 0 }] }] } } }] },
    { id: 'b2', blockType: 'mediaBlock', media: { id: 9, url: '/api/media/file/hero.png', alt: 'Hero' } },
    { id: 'b3', blockType: 'pricing', plans: [{ name: 'Free', price: '0' }] },
    { id: 'b4', blockType: 'mediaBlock', media: 10 },
  ],
}

function request(user?: object) {
  const find = vi.fn(async () => ({ docs: [page] }))
  const findByID = vi.fn(async () => page)
  return { req: { url: 'http://cms.test/api/geo/llms-full.txt', user, headers: new Headers(), json: async () => ({}), payload: { find, findByID, logger: { warn: vi.fn() } } }, find, findByID }
}

describe('payload complex content', () => {
  const base = {
    serverURL: 'https://cms.test',
    collections: [{ slug: 'pages', fields: [{ name: 'title', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'layout', type: 'blocks', blocks: [] }], versions: { drafts: true } }],
    endpoints: [],
  } as unknown as Config
  const llms = {
    siteURL: 'https://site.test',
    name: 'Acme',
    converters: { blocks: { pricing: (b: any) => b.plans.map((p: any) => `- ${p.name}: ${p.price}`).join('\n') } },
    collections: { pages: { contentField: 'layout', url: (d: any) => `/${d.slug}`, depth: 2 } },
  }
  const config = geoPlugin({ secret: 's', verifyIPs: false, llms })(base)
  const endpoint = (path: string, method = 'get') => config.endpoints!.find((e) => e.path === path && e.method === method)!

  it('uses the same converter for llms-full.txt, Markdown and the editor preview', async () => {
    const { req, find } = request()
    const full = await (await endpoint('/geo/llms-full.txt').handler(req as never)).text()
    expect(full).toContain('Intro\n\n![Hero](https://cms.test/api/media/file/hero.png)\n\n- Free: 0')
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ depth: 2, overrideAccess: false }))

    const md = await (await endpoint('/geo/markdown').handler({ ...req, url: 'http://cms.test/api/geo/markdown?path=/landing' } as never)).text()
    const editor = request({ id: 1 })
    const res = await endpoint('/geo/inspect', 'post').handler({ ...editor.req, json: async () => ({ collection: 'pages', id: 1, data: {} }) } as never)
    const inspection = await res.json()
    expect(inspection.markdown).toBe(md)
    const conversion = inspection.checks.find((c: any) => c.ruleId === 'GEO-CONVERSION')
    expect(conversion.status).toBe('warning')
    expect(conversion.message).toContain('relation-unavailable')
    expect(conversion.fieldPath).toBe('layout[3].media')
  })

  it('validates converters and rules at startup', () => {
    expect(() => geoPlugin({ llms: { ...llms, converters: { blocks: { x: 'nope' as never } } } })(base)).toThrow(/must be a function/)
    expect(() => geoPlugin({ llms: { ...llms, rules: [{ id: 'GEO-TITLE', check: () => null }] } })(base)).toThrow(/reserved/)
  })

  it('runs custom rules in the editor panel after the built-in checks', async () => {
    const withRule = geoPlugin({ llms: { ...llms, rules: [{ id: 'ACME-PRICING', check: ({ markdown }) => ({ status: markdown.includes('Free') ? 'pass' : 'warning', message: 'Pricing block present.' }) }] } })(base)
    const editor = request({ id: 1 })
    const handler = withRule.endpoints!.find((e) => e.path === '/geo/inspect')!.handler
    const body = await (await handler({ ...editor.req, json: async () => ({ collection: 'pages', id: 1, data: {} }) } as never)).json()
    expect(body.checks.at(-1)).toMatchObject({ ruleId: 'ACME-PRICING', status: 'pass' })
  })
})

describe('hydrate', () => {
  it('puts populated relations from the saved document back into form values by id', () => {
    const stored = { layout: [{ id: 'a', blockType: 'mediaBlock', media: { id: 5, url: '/x.png' } }, { id: 'b', blockType: 'content', richText: 'old' }] }
    const form = { layout: [{ id: 'b', blockType: 'content', richText: 'new' }, { id: 'a', blockType: 'mediaBlock', media: 5 }, { id: 'c', blockType: 'mediaBlock', media: 6 }] }
    expect(hydrate(form, stored)).toEqual({
      layout: [{ id: 'b', blockType: 'content', richText: 'new' }, { id: 'a', blockType: 'mediaBlock', media: { id: 5, url: '/x.png' } }, { id: 'c', blockType: 'mediaBlock', media: 6 }],
    })
  })
})
