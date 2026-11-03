import { describe, expect, it } from 'vitest'
import { buildLlmsFullTxt, buildSegment, buildSegmentIndex, parseSegmentFile, segmentKey, type LlmsDocument, type SegmentSource } from './index.js'

const site = { name: 'Acme', description: 'Docs' }
const doc = (i: number): LlmsDocument => ({ title: `Post ${i}`, url: `https://site.test/blog/${i}`, section: 'Blog', description: `About ${i}`, markdown: `Body ${i}` })
const source = (n: number): SegmentSource => {
  const all = Array.from({ length: n }, (_, i) => doc(i + 1))
  return { key: 'posts', section: 'Blog', count: async () => n, page: async (o, l) => all.slice(o, o + l), featured: async () => [all[0]!] }
}
const at = '2026-11-03T00:00:00.000Z'

describe('segments', () => {
  it('parses only well-formed part names', () => {
    expect(parseSegmentFile('posts-2.txt')).toEqual({ key: 'posts', part: 2, full: false })
    expect(parseSegmentFile('posts-2-full.txt')).toEqual({ key: 'posts', part: 2, full: true })
    for (const bad of ['posts-0.txt', '../x-1.txt', 'posts.txt', 'Posts-1.txt', 'posts-1.md']) expect(parseSegmentFile(bad)).toBeNull()
    expect(segmentKey('Blog Posts!')).toBe('blog-posts')
  })

  it('links every part from the index, with featured documents first', async () => {
    const index = await buildSegmentIndex(site, [source(1203)], { enabled: true, size: 500 }, 'https://site.test', { generatedAt: at })
    expect(index).toContain('## Featured')
    expect(index).toContain('[Blog, part 1 (entries 1–500)](https://site.test/llms/posts-1.txt)')
    expect(index).toContain('[Blog, part 3 (entries 1001–1203)](https://site.test/llms/posts-3.txt)')
    expect(index).not.toContain('posts-4.txt')
    expect(index).toContain('llmstxt.org does not define them')
  })

  it('covers every entry exactly once across parts and is deterministic', async () => {
    const s = source(1203)
    const o = { enabled: true, size: 500 }
    const urls: string[] = []
    for (let p = 1; p <= 3; p++) {
      const text = (await buildSegment(site, s, p, false, o, 'https://site.test', { generatedAt: at }))!
      expect(text).toBe(await buildSegment(site, s, p, false, o, 'https://site.test', { generatedAt: at }))
      urls.push(...[...text.matchAll(/\]\((https:\/\/site\.test\/blog\/\d+)\)/g)].map((m) => m[1]!))
    }
    expect(urls).toHaveLength(1203)
    expect(new Set(urls).size).toBe(1203)
    expect(await buildSegment(site, s, 4, false, o, 'https://site.test')).toBeNull()
    expect(await buildSegment(site, s, 0, false, o, 'https://site.test')).toBeNull()
    const p2 = (await buildSegment(site, s, 2, false, o, 'https://site.test'))!
    expect(p2).toContain('Previous: https://site.test/llms/posts-1.txt')
    expect(p2).toContain('Next: https://site.test/llms/posts-3.txt')
  })

  it('caps llms-full by bytes and says what was left out', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ ...doc(i), markdown: 'x'.repeat(2000) }))
    const text = buildLlmsFullTxt(site, big, { maxBytes: 10_000 })
    expect(new TextEncoder().encode(text).length).toBeLessThan(12_000)
    expect(text).toMatch(/not included/i)
  })
})
