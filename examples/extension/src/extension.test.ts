import { describe, expect, it, vi } from 'vitest'
import { createContentConverter, detectBot, runRules, siteChangeEvent, toLlmsDocument, buildJsonLd } from '@garus-ltd/geo-core'
import { acmeBots, acmeConverters, acmeOnChange, acmePostsSource, acmeRules } from './index'

describe('example extension (public exports only)', () => {
  it('adds a bot without breaking the built-in ones', () => {
    expect(detectBot('Mozilla/5.0 (compatible; AcmeResearchBot/2.1)', acmeBots)?.id).toBe('acme-research')
    expect(detectBot('GPTBot/1.2', acmeBots)?.id).toBe('gptbot')
  })

  it('converts its block and maps fields and JSON-LD', () => {
    const converter = createContentConverter(acmeConverters)
    const out = converter.convert([{ blockType: 'pricingTable', plans: [{ name: 'Pro', price: '$10', features: [{ type: 'text', text: 'All' }] }] }])
    expect(out.markdown).toContain('| Pro | $10 |')
    const source = acmePostsSource()
    const doc = toLlmsDocument({ title: 'Hi', slug: 'hi', intro: 'Short intro.', readingMinutes: 4 }, { name: 'posts', siteURL: 'https://site.test', source })!
    expect(doc.description).toBe('Short intro.')
    expect(JSON.stringify(buildJsonLd({ siteURL: 'https://site.test', name: 'Acme' }, doc))).toContain('"timeRequired":"PT4M"')
  })

  it('runs its rule', async () => {
    const [result] = await runRules(acmeRules, { values: {}, document: null, markdown: 'One two three.', sources: {} as never, state: {} as never, collection: 'posts' } as never)
    expect(result).toMatchObject({ ruleId: 'ACME-TLDR', status: 'pass' })
  })

  it('forwards change events', async () => {
    const purge = vi.fn(async () => {})
    await acmeOnChange(purge)(siteChangeEvent('config', 'https://site.test'))
    expect(purge).toHaveBeenCalledWith(['https://site.test/llms.txt', 'https://site.test/llms-full.txt'])
  })
})
