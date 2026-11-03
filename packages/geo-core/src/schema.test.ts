import { describe, expect, it } from 'vitest'
import {
  buildJsonLd,
  buildJsonLdDetailed,
  decimalString,
  extractJsonLdScripts,
  findJsonLdConflicts,
  graphNodes,
  inspectDocument,
  isoDuration,
  mapLlmsDocument,
  omitJsonLdTypes,
  serializeJsonLd,
  type JsonLdSourceConfig,
  type JsonLdSite,
} from './index.js'

const site: JsonLdSite = { name: 'Acme', url: 'https://site.test', logo: '/logo.png' }
const map = (doc: Record<string, any>, jsonLd: JsonLdSourceConfig, extra: object = {}) =>
  mapLlmsDocument({ slug: 'x', ...doc }, { name: 'items', siteURL: 'https://site.test', mediaURL: 'https://cms.test', source: { jsonLd, url: (d) => `/items/${d.slug}`, ...extra } }).document!
const build = (doc: Record<string, any>, jsonLd: JsonLdSourceConfig, s: JsonLdSite = site, extra: object = {}) => buildJsonLdDetailed(s, map(doc, jsonLd, extra))
const node = (data: unknown, type: string) => graphNodes(data).find((n) => n['@type'] === type)
const codes = (issues: { ruleId: string; severity: string }[]) => issues.map((i) => `${i.severity}:${i.ruleId}`)

describe('Product / Offer', () => {
  const full = {
    title: 'Trail Shoe',
    description: 'Light shoe for wet trails.',
    image: { url: '/uploads/shoe.png' },
    sku: 'TS-1',
    gtin: '4006381333931',
    brand: { name: 'Acme' },
    price: '119.90',
    currency: 'EUR',
    stock: 'in_stock',
    priceValidUntil: '2027-01-31',
  }
  const config: JsonLdSourceConfig = { type: 'Product', fields: { availability: 'stock' } }

  it('builds a full product with an offer, exact decimal price and schema.org enums', () => {
    const { data, issues } = build(full, config)
    expect(issues).toEqual([])
    expect(node(data, 'Product')).toEqual({
      '@type': 'Product',
      '@id': 'https://site.test/items/x#product',
      name: 'Trail Shoe',
      url: 'https://site.test/items/x',
      description: 'Light shoe for wet trails.',
      image: ['https://cms.test/uploads/shoe.png'],
      sku: 'TS-1',
      gtin: '4006381333931',
      brand: { '@type': 'Brand', name: 'Acme' },
      offers: {
        '@type': 'Offer',
        price: '119.90',
        priceCurrency: 'EUR',
        availability: 'https://schema.org/InStock',
        priceValidUntil: '2027-01-31',
        url: 'https://site.test/items/x',
      },
    })
    // No article properties leak into a product.
    expect(node(data, 'Product')).not.toHaveProperty('headline')
    expect(node(data, 'Product')).not.toHaveProperty('publisher')
  })

  it('outputs a minimal product without an offer, with a suggestion', () => {
    const { data, issues } = build({ title: 'Thing' }, { type: 'Product' })
    expect(node(data, 'Product')).toMatchObject({ name: 'Thing' })
    expect(codes(issues)).toEqual(['warning:LD-PRODUCT-OFFER'])
  })

  it('drops an invalid offer but keeps the product; never invents a price', () => {
    for (const [price, currency, rule] of [
      ['€19,90', 'EUR', 'LD-PRODUCT-PRICE'],
      [0.1 + 0.2, 'EUR', 'LD-PRODUCT-PRICE'],
      [-5, 'EUR', 'LD-PRODUCT-PRICE'],
      ['19.90', 'euro', 'LD-PRODUCT-CURRENCY'],
      ['19.90', undefined, 'LD-PRODUCT-CURRENCY'],
    ] as const) {
      const { data, issues } = build({ title: 'Thing', price, currency }, { type: 'Product' })
      expect(node(data, 'Product')).not.toHaveProperty('offers')
      expect(codes(issues)).toContain(`error:${rule}`)
    }
    const { issues } = build({ title: 'Thing', price: '5', currency: 'EUR', availability: 'maybe', priceValidUntil: 'soon', gtin: '12' }, { type: 'Product' })
    expect(codes(issues)).toEqual(['warning:LD-PRODUCT-GTIN', 'warning:LD-PRODUCT-AVAILABILITY', 'warning:LD-PRODUCT-VALID-UNTIL'])
  })

  it('leaves the product out without a name, keeping the other nodes', () => {
    const { data, issues } = build({ title: '', name: '', faq: [{ question: 'Q?', answer: 'A' }] }, { type: 'Product' }, site, { faqField: 'faq' })
    expect(node(data, 'Product')).toBeUndefined()
    expect(node(data, 'FAQPage')).toBeDefined()
    expect(codes(issues)).toContain('error:LD-PRODUCT-NAME')
  })

  it('handles several offers and minor-unit prices exactly', () => {
    const doc = { title: 'Thing', variants: [{ price: 1999, priceCurrency: 'USD' }, { price: 500, priceCurrency: 'JPY' }] }
    const { data } = build(doc, { type: 'Product', priceUnit: 'minor', fields: { offers: 'variants' } })
    expect((node(data, 'Product')!.offers as any[]).map((o) => o.price)).toEqual(['19.99', '500'])
    expect(decimalString('100', 'minor', 2)).toBe('1.00')
    expect(decimalString(19.9)).toBe('19.9')
    expect(decimalString(1e21)).toBeNull()
  })

  it('keeps malicious text inert: control characters stripped, `<` escaped in the script', () => {
    const { data } = build({ title: 'Shoe</script><script>alert(1)</script>\u0000', description: '"><img src=x onerror=alert(1)>', price: '1', currency: 'EUR' }, { type: 'Product' })
    const script = serializeJsonLd(data)
    expect(script).not.toContain('</script')
    expect(script).not.toContain('<')
    expect(JSON.parse(script)['@graph'][0].name).toBe('Shoe</script><script>alert(1)</script>')
    const bad = build({ title: 'X', image: 'javascript:alert(1)', price: '1', currency: 'EUR', offerURL: 'javascript:alert(1)' }, { type: 'Product', fields: { offerURL: 'offerURL' } })
    expect(node(bad.data, 'Product')).not.toHaveProperty('image')
    expect((node(bad.data, 'Product')!.offers as any).url).toBeUndefined()
  })
})

describe('HowTo', () => {
  it('builds steps, tools, supplies and duration only from mapped fields', () => {
    const { data, issues } = build(
      {
        title: 'Change a tire',
        steps: [{ name: 'Loosen', text: [{ type: 'paragraph', children: [{ type: 'text', text: 'Loosen the nuts.' }] }], url: '#loosen' }, { text: 'Lift the car.', image: { url: '/u/lift.png' } }],
        tools: ['Wrench', { name: 'Jack' }],
        materials: ['Spare tire'],
        totalTime: 30,
      },
      { type: 'HowTo' },
    )
    expect(issues).toEqual([])
    expect(node(data, 'HowTo')).toEqual({
      '@type': 'HowTo',
      '@id': 'https://site.test/items/x#howto',
      name: 'Change a tire',
      url: 'https://site.test/items/x',
      step: [
        { '@type': 'HowToStep', position: 1, text: 'Loosen the nuts.', name: 'Loosen', url: 'https://site.test/items/x#loosen' },
        { '@type': 'HowToStep', position: 2, text: 'Lift the car.', image: 'https://cms.test/u/lift.png' },
      ],
      tool: [{ '@type': 'HowToTool', name: 'Wrench' }, { '@type': 'HowToTool', name: 'Jack' }],
      supply: [{ '@type': 'HowToSupply', name: 'Spare tire' }],
      totalTime: 'PT30M',
    })
  })

  it('is left out without steps; never guesses them from the body', () => {
    const { data, issues } = build({ title: 'Guide', content: '1. Do this\n2. Do that' }, { type: 'HowTo' })
    expect(data).toBeNull()
    expect(codes(issues)).toEqual(['error:LD-HOWTO-REQUIRED'])
  })

  it('reports invalid durations and empty steps', () => {
    const { data, issues } = build({ title: 'G', steps: [{ text: '' }, 'Only step'], totalTime: '30 minutes' }, { type: 'HowTo' })
    expect((node(data, 'HowTo')!.step as any[]).length).toBe(1)
    expect(codes(issues)).toEqual(['warning:LD-HOWTO-STEP', 'warning:LD-HOWTO-DURATION'])
    expect(isoDuration('PT1H30M')).toBe('PT1H30M')
    expect(isoDuration('P')).toBeNull()
    expect(isoDuration('PT')).toBeNull()
  })
})

describe('LocalBusiness', () => {
  const shop = {
    title: 'Corner Bakery',
    businessType: 'Bakery',
    phone: '+49 30 1234567',
    address: { street: 'Hauptstr. 1', city: 'Berlin', zip: '10115', country: 'DE' },
    openingHours: [{ days: ['Mon', 'Tue'], opens: '07:00', closes: '18:00' }, { days: 'Saturday', opens: '08:00', closes: '13:00' }],
    latitude: 52.52,
    longitude: 13.405,
    priceRange: '€',
  }

  it('builds address, hours and geo with a subtype', () => {
    const { data, issues } = build(shop, { type: 'LocalBusiness' })
    expect(issues).toEqual([])
    expect(node(data, 'Bakery')).toEqual({
      '@type': 'Bakery',
      '@id': 'https://site.test/items/x#business',
      name: 'Corner Bakery',
      address: { '@type': 'PostalAddress', streetAddress: 'Hauptstr. 1', addressLocality: 'Berlin', postalCode: '10115', addressCountry: 'DE' },
      url: 'https://site.test/items/x',
      telephone: '+49 30 1234567',
      priceRange: '€',
      openingHoursSpecification: [
        { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday'], opens: '07:00', closes: '18:00' },
        { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '08:00', closes: '13:00' },
      ],
      geo: { '@type': 'GeoCoordinates', latitude: 52.52, longitude: 13.405 },
    })
  })

  it('is left out without an address, and drops invalid hours, geo and types', () => {
    expect(codes(build({ title: 'Nowhere' }, { type: 'LocalBusiness' }).issues)).toEqual(['error:LD-BUSINESS-REQUIRED'])
    const { data, issues } = build({ ...shop, businessType: 'Spaceport', openingHours: [{ days: ['Funday'], opens: '25:00', closes: '18:00' }], latitude: 200 }, { type: 'LocalBusiness' })
    const n = node(data, 'LocalBusiness')!
    expect(n).not.toHaveProperty('openingHoursSpecification')
    expect(n).not.toHaveProperty('geo')
    expect(codes(issues)).toEqual(['warning:LD-BUSINESS-TYPE', 'warning:LD-BUSINESS-HOURS', 'warning:LD-BUSINESS-GEO'])
  })
})

describe('Organization, Person and links by @id', () => {
  const org = { name: 'Acme Inc.', logo: '/logo.png', sameAs: ['https://github.com/acme', 'javascript:alert(1)'] }

  it('links the article publisher and authors to stable @id nodes', () => {
    const doc = { title: 'Post', author: [{ name: 'Ann Lee', slug: 'ann', avatar: { url: '/u/ann.png' }, links: ['https://x.test/ann'] }, { name: 'Bob' }] }
    const { data, issues } = build(doc, { type: 'BlogPosting', author: { url: (a) => (a.slug ? `/authors/${a.slug}` : null), image: 'avatar', sameAs: 'links' } }, { ...site, organization: org })
    const graph = graphNodes(data)
    const article = graph[0]!
    expect(article.publisher).toEqual({ '@id': 'https://site.test/#organization' })
    expect(article.author).toEqual([{ '@id': 'https://site.test/authors/ann#person' }, { '@id': 'https://site.test/#person-bob' }])
    expect(node(data, 'Organization')).toEqual({
      '@type': 'Organization',
      '@id': 'https://site.test/#organization',
      name: 'Acme Inc.',
      url: 'https://site.test',
      logo: { '@type': 'ImageObject', url: 'https://site.test/logo.png' },
      sameAs: ['https://github.com/acme'],
    })
    expect(graph.filter((n) => n['@type'] === 'Person')).toEqual([
      { '@type': 'Person', '@id': 'https://site.test/authors/ann#person', name: 'Ann Lee', url: 'https://site.test/authors/ann', image: 'https://cms.test/u/ann.png', sameAs: ['https://x.test/ann'] },
      { '@type': 'Person', '@id': 'https://site.test/#person-bob', name: 'Bob' },
    ])
    expect(codes(issues)).toEqual(['warning:LD-URL'])
    // Each @id defined once.
    const ids = graph.map((n) => n['@id'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('builds Person and Organization pages', () => {
    const person = build({ title: 'Ann Lee', role: 'Editor', sameAs: ['https://x.test/ann'] }, { type: 'Person' })
    expect(node(person.data, 'Person')).toMatchObject({ '@id': 'https://site.test/items/x#person', name: 'Ann Lee', jobTitle: 'Editor' })
    const orgPage = build({ title: 'Partner Co', logo: { url: '/u/p.png' } }, { type: 'Organization' })
    expect(node(orgPage.data, 'Organization')).toMatchObject({ name: 'Partner Co', logo: { url: 'https://cms.test/u/p.png' } })
    expect(codes(build({ title: '' , name: ''}, { type: 'Person' }).issues)).toContain('error:LD-PERSON-NAME')
  })

  it('keeps the old inline publisher and author names without the new options', () => {
    const data = buildJsonLd(site, map({ title: 'Post', author: { name: 'Ann' } }, { type: 'BlogPosting' }))
    const article = graphNodes(data)[0]!
    expect(article.publisher).toEqual({ '@type': 'Organization', name: 'Acme', url: 'https://site.test', logo: { '@type': 'ImageObject', url: 'https://site.test/logo.png' } })
    expect(article.author).toEqual([{ '@type': 'Person', name: 'Ann' }])
    expect(graphNodes(data)).toHaveLength(1)
  })
})

describe('BreadcrumbList', () => {
  it('builds home > parents > page with absolute URLs', () => {
    const { data } = build({ title: 'Shoe' }, { type: 'Article', breadcrumb: { parents: [{ name: 'Shop', url: '/shop' }] } })
    expect(node(data, 'BreadcrumbList')).toEqual({
      '@type': 'BreadcrumbList',
      '@id': 'https://site.test/items/x#breadcrumb',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://site.test' },
        { '@type': 'ListItem', position: 2, name: 'Shop', item: 'https://site.test/shop' },
        { '@type': 'ListItem', position: 3, name: 'Shoe', item: 'https://site.test/items/x' },
      ],
    })
  })

  it('drops bad items and needs two levels', () => {
    const { data, issues } = build({ title: 'x' }, { breadcrumb: { items: () => [{ name: 'Only', url: 'javascript:x' }, { name: '', url: '/a' }, { name: 'One', url: '/one' }] } })
    expect(node(data, 'BreadcrumbList')).toBeUndefined()
    expect(codes(issues)).toEqual(['warning:LD-BREADCRUMB-ITEM', 'warning:LD-BREADCRUMB-ITEM', 'warning:LD-BREADCRUMB-ITEM'])
  })
})

describe('preview validation', () => {
  it('lists preset issues next to the plugin checks, with the source field', () => {
    const res = inspectDocument(
      { slug: 'x', title: 'Shoe', cost: 'abc', currency: 'EUR' },
      { name: 'items', siteURL: 'https://site.test', source: { jsonLd: { type: 'Product', fields: { price: 'cost' } } }, site, state: { saved: true, published: true, publicVisible: true } },
    )
    expect(res.validation.find((v) => v.ruleId === 'LD-PRODUCT-PRICE')).toMatchObject({ status: 'error', fieldPath: 'cost' })
    expect(res.validation.find((v) => v.ruleId === 'LD-REQUIRED')!.status).toBe('pass')
    const missing = inspectDocument({ slug: 'x', title: 'G' }, { name: 'items', siteURL: 'https://site.test', source: { jsonLd: { type: 'HowTo' } }, site, state: { saved: true, published: true, publicVisible: true } })
    expect(missing.jsonLd).toBeNull()
    expect(missing.validation.map((v) => `${v.status}:${v.ruleId}`)).toEqual(['error:LD-ENABLED', 'error:LD-HOWTO-REQUIRED'])
  })
})

describe('conflicts with the host site', () => {
  it('finds duplicate @ids with different values, and types both sides output', () => {
    const html = `
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","@id":"https://s.test/a#article","headline":"Host title"}</script>
      <script type="application/ld+json" data-geo-jsonld>{"@context":"https://schema.org","@graph":[{"@type":"Article","@id":"https://s.test/a#article","headline":"GEO title"},{"@type":"FAQPage","@id":"https://s.test/a#faq"}]}</script>
      <script type="application/ld+json">{"@type":"BlogPosting","@id":"https://s.test/a#post","headline":"x"}</script>
      <script type="application/ld+json">{"@type":"Organization","@id":"https://s.test/#org","name":"A"}</script>
      <script type="application/ld+json">{"@type":"Organization","@id":"https://s.test/#org","name":"A"}</script>`
    const scripts = extractJsonLdScripts(html)
    expect(scripts.map((s) => s.source)).toEqual(['host', 'geo', 'host', 'host', 'host'])
    const conflicts = findJsonLdConflicts(scripts)
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: 'duplicate-id', id: 'https://s.test/a#article', properties: ['headline'], severity: 'error' }),
      expect.objectContaining({ kind: 'same-node', id: 'https://s.test/#org', severity: 'warning' }),
    ])
  })

  it('does not flag several different nodes on one page', () => {
    const geo = JSON.stringify({ '@graph': [{ '@type': 'Article', '@id': 'a#article', headline: 'x' }, { '@type': 'FAQPage', '@id': 'a#faq' }, { '@type': 'BreadcrumbList', '@id': 'a#breadcrumb' }] })
    const host = JSON.stringify({ '@type': 'WebSite', '@id': 'site#website', name: 'S' })
    expect(findJsonLdConflicts([{ json: geo, source: 'geo' }, { json: host, source: 'host' }])).toEqual([])
    expect(findJsonLdConflicts([{ json: geo, source: 'geo' }, { json: JSON.stringify({ '@type': 'Article', '@id': 'other', headline: 'y' }), source: 'host' }])).toEqual([
      expect.objectContaining({ kind: 'same-type', nodeType: 'Article' }),
    ])
    expect(findJsonLdConflicts([{ json: '{oops', source: 'host' }])[0]!.kind).toBe('invalid-json')
  })

  it('omits host-managed types and keeps references', () => {
    const data = buildJsonLd({ ...site, organization: { name: 'Acme' } }, map({ title: 'Post', faq: [{ question: 'Q?', answer: 'A' }] }, { type: 'Article' }, { faqField: 'faq' }))
    const trimmed = omitJsonLdTypes(data, ['Article', 'Organization'])
    expect(graphNodes(trimmed).map((n) => n['@type'])).toEqual(['FAQPage'])
    expect(graphNodes(data).map((n) => n['@type'])).toEqual(['Article', 'FAQPage', 'Organization'])
  })
})
