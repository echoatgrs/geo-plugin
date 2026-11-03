import { describe, expect, it, vi } from 'vitest'
import { createIPVerifier, detectBot, ingestHits, ipInRanges, parseCIDR, type CrawlerHit } from './index.js'

const UA = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudeSearch: 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
}

describe('detectBot', () => {
  it('classifies training, search and live user fetches', () => {
    expect(detectBot(UA.gptbot)?.purpose).toBe('training')
    expect(detectBot(UA.chatgptUser)?.id).toBe('chatgpt-user')
    expect(detectBot(UA.claudeSearch)?.id).toBe('claude-searchbot')
    expect(detectBot(UA.chrome)).toBeNull()
    expect(detectBot(undefined)).toBeNull()
  })
})

describe('detectBot: Kimi, Yandex and Google user fetchers', () => {
  it('recognises each token and keeps the longer Yandex token distinct', () => {
    const kimi = (name: string) => `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ${name}/1.0; +https://www.kimi.com/policies/kimi-crawlers`
    expect(detectBot(kimi('KimiBot'))?.purpose).toBe('training')
    expect(detectBot(kimi('Kimi-SearchBot'))?.id).toBe('kimi-searchbot')
    expect(detectBot(kimi('Kimi-User'))?.purpose).toBe('user')
    expect(detectBot('Mozilla/5.0 (compatible; YandexAdditionalBot/1.0; +http://yandex.com/bots)')?.id).toBe('yandexadditionalbot')
    expect(detectBot('Mozilla/5.0 (compatible; YandexAdditional/1.0; +http://yandex.com/bots)')?.id).toBe('yandexadditional')
    expect(detectBot('Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)')).toBeNull()
    expect(detectBot('Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0 Safari/537.36 (compatible; Google-GeminiNotebook; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-gemininotebook)')?.id).toBe('google-gemininotebook')
    expect(detectBot('Mozilla/5.0 (compatible; Google-Agent; +https://developers.google.com/crawling/docs/crawlers-fetchers/google-agent)')?.platform).toBe('Google')
  })
})

describe('CIDR', () => {
  it('matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    const ranges = ['20.171.206.0/24', '2600:1f28:3d7::/48'].map((c) => parseCIDR(c)!)
    expect(ipInRanges('20.171.206.15', ranges)).toBe(true)
    expect(ipInRanges('20.171.207.1', ranges)).toBe(false)
    expect(ipInRanges('::ffff:20.171.206.9', ranges)).toBe(true)
    expect(ipInRanges('2600:1f28:3d7:12::1', ranges)).toBe(true)
    expect(ipInRanges('2600:1f28:3d8::1', ranges)).toBe(false)
    expect(ipInRanges('not-an-ip', ranges)).toBe(false)
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('createIPVerifier', () => {
  it('verifies against published ranges, caches them, and falls back to unverifiable', async () => {
    const fetch = vi.fn(async () => jsonResponse({ prefixes: [{ ipv4Prefix: '20.171.206.0/24' }] }))
    const verifier = createIPVerifier({ fetch: fetch as unknown as typeof globalThis.fetch })
    const gptbot = detectBot(UA.gptbot)!
    expect(await verifier.verify(gptbot, '20.171.206.15')).toBe('verified')
    expect(await verifier.verify(gptbot, '1.2.3.4')).toBe('spoofed')
    expect(fetch).toHaveBeenCalledTimes(1)
    // ClaudeBot has no published list
    expect(await verifier.verify(detectBot('ClaudeBot/1.0')!, '1.2.3.4')).toBe('unverifiable')
    expect(await verifier.verify(gptbot, null)).toBe('unverifiable')
  })

  it('reports unverifiable when the list cannot be fetched', async () => {
    const verifier = createIPVerifier({ fetch: (async () => { throw new Error('offline') }) as never })
    expect(await verifier.verify(detectBot(UA.gptbot)!, '20.171.206.15')).toBe('unverifiable')
  })
})

describe('ingestHits', () => {
  const memoryStore = () => {
    const hits: CrawlerHit[] = []
    return { hits, save: async (hit: CrawlerHit) => void hits.push(hit) }
  }

  it('rejects a wrong secret', async () => {
    const store = memoryStore()
    const result = await ingestHits({ path: '/', userAgent: UA.gptbot }, 'nope', { secret: 's3cret', store })
    expect(result.status).toBe(401)
    expect(store.hits).toHaveLength(0)
  })

  it('re-classifies the user agent server-side and skips non-bots', async () => {
    const store = memoryStore()
    const result = await ingestHits(
      { hits: [{ path: '/blog/a', userAgent: UA.chatgptUser, ip: '1.2.3.4' }, { path: '/', userAgent: UA.chrome }] },
      's3cret',
      { secret: 's3cret', store },
    )
    expect(result).toEqual({ status: 200, body: { ok: true, stored: 1, skipped: 1 } })
    expect(store.hits[0]).toMatchObject({ botId: 'chatgpt-user', purpose: 'user', path: '/blog/a', verification: 'unverifiable' })
  })

  it('drops spoofed hits when asked to', async () => {
    const store = memoryStore()
    const verifier = { verify: async () => 'spoofed' as const }
    const result = await ingestHits({ path: '/', userAgent: UA.gptbot }, null, { store, verifier, storeSpoofed: false })
    expect(result.body.skipped).toBe(1)
    expect(store.hits).toHaveLength(0)
  })

  it('rejects malformed payloads', async () => {
    const store = memoryStore()
    expect((await ingestHits({ path: 1 }, null, { store })).status).toBe(400)
    expect((await ingestHits([], null, { store })).status).toBe(400)
  })
})
