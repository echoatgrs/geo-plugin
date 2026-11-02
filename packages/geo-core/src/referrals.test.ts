import { describe, expect, it } from 'vitest'
import {
  ProbeRegistry,
  ReferralLimiter,
  citationKey,
  classifyReferral,
  ingestReferrals,
  matchReferrerHost,
  summarizeCitations,
  summarizeReferrals,
  type ReferralEvent,
} from './index.js'

function memoryStore() {
  const events: ReferralEvent[] = []
  return { events, save: async (e: ReferralEvent) => void events.push(e) }
}

const SECRET = 's3cret'

describe('classifyReferral', () => {
  it('recognises real referrer samples by host', () => {
    expect(classifyReferral({ referrer: 'https://chatgpt.com/', url: '/blog/a' })).toEqual({ platform: 'OpenAI', source: 'referrer', referrerHost: 'chatgpt.com' })
    expect(classifyReferral({ referrer: 'https://www.perplexity.ai/search?q=secret', url: '/a' })?.platform).toBe('Perplexity')
    expect(classifyReferral({ referrer: 'https://gemini.google.com/app/123', url: '/a' })?.platform).toBe('Google')
    expect(classifyReferral({ referrer: 'https://www.doubao.com/chat/1', url: '/a' })?.platform).toBe('ByteDance')
    expect(classifyReferral({ referrer: 'https://kimi.moonshot.cn/', url: '/a' })?.platform).toBe('Moonshot')
    expect(classifyReferral({ referrer: 'https://alice.yandex.ru/', url: '/a' })?.platform).toBe('Yandex')
    expect(classifyReferral({ referrer: 'https://giga.chat/', url: '/a' })?.platform).toBe('Sber')
  })

  it('never matches by substring', () => {
    expect(matchReferrerHost('chatgpt.com.evil.example')).toBeNull()
    expect(matchReferrerHost('notchatgpt.com')).toBeNull()
    expect(classifyReferral({ referrer: 'https://example.com/chatgpt', url: '/a?chatgpt=1' })).toBeNull()
    expect(classifyReferral({ referrer: null, url: '/a?utm_source=chatgpt' })).toBeNull()
    expect(classifyReferral({ referrer: null, url: '/a?utm_source=my-chatgpt.com' })).toBeNull()
  })

  it('uses utm_source only without a Referer and only for an exact known host', () => {
    expect(classifyReferral({ referrer: null, url: '/a?utm_source=chatgpt.com' })).toEqual({ platform: 'OpenAI', source: 'utm', referrerHost: 'chatgpt.com' })
    // The Referer wins over utm.
    expect(classifyReferral({ referrer: 'https://google.com/', url: '/a?utm_source=chatgpt.com' })).toBeNull()
  })

  it('treats no referrer and garbage as unknown', () => {
    expect(classifyReferral({ url: '/a' })).toBeNull()
    expect(classifyReferral({ referrer: 'not a url', url: '/a' })).toBeNull()
  })

  it('accepts a configurable list', () => {
    const rules = [{ platform: 'Acme AI', hosts: ['ai.acme.test'] }]
    expect(classifyReferral({ referrer: 'https://ai.acme.test/x', url: '/' }, rules)?.platform).toBe('Acme AI')
    expect(classifyReferral({ referrer: 'https://chatgpt.com/', url: '/' }, rules)).toBeNull()
  })
})

describe('ingestReferrals', () => {
  it('requires a configured secret and a matching one', async () => {
    const store = memoryStore()
    expect((await ingestReferrals({ url: '/a', referrer: 'https://chatgpt.com/' }, null, { store })).status).toBe(503)
    expect((await ingestReferrals({ url: '/a', referrer: 'https://chatgpt.com/' }, 'wrong', { secret: SECRET, store })).status).toBe(401)
    expect(store.events).toHaveLength(0)
  })

  it('stores host and path only', async () => {
    const store = memoryStore()
    const res = await ingestReferrals(
      { url: '/blog/a?utm_source=chatgpt.com&email=x@y.z#top', referrer: 'https://chatgpt.com/c/abc-conversation?x=1', host: 'Site.test', ip: '1.2.3.4', userAgent: 'Mozilla/5.0' },
      SECRET,
      { secret: SECRET, store },
    )
    expect(res).toEqual({ status: 200, body: { ok: true, stored: 1, skipped: 0, duplicates: 0, limited: 0 } })
    expect(store.events[0]).toMatchObject({ platform: 'OpenAI', source: 'referrer', referrerHost: 'chatgpt.com', path: '/blog/a', host: 'site.test' })
    expect(JSON.stringify(store.events[0])).not.toMatch(/abc-conversation|1\.2\.3\.4|Mozilla|email/)
  })

  it('skips forged and invalid input', async () => {
    const store = memoryStore()
    const res = await ingestReferrals(
      [
        { url: 'https://other.test/a', referrer: 'https://chatgpt.com/' },
        { url: '/a', referrer: 42 },
        { referrer: 'https://chatgpt.com/' },
        null,
        { url: '/a', referrer: 'https://chatgpt.com.evil.test/' },
      ],
      SECRET,
      { secret: SECRET, store },
    )
    expect(res.body).toMatchObject({ stored: 0, skipped: 5 })
    expect((await ingestReferrals(new Array(51).fill({ url: '/a' }), SECRET, { secret: SECRET, store })).status).toBe(400)
  })

  it('drops unknown referrals unless asked, then stores them as unknown (host only)', async () => {
    const store = memoryStore()
    const body = [
      { url: '/a', referrer: 'https://www.google.com/search?q=private', host: 'site.test' },
      { url: '/a?utm_source=newsletter', host: 'site.test' },
      { url: '/a', host: 'site.test' },
      { url: '/b', referrer: 'https://site.test/a', host: 'site.test' },
    ]
    expect((await ingestReferrals(body, SECRET, { secret: SECRET, store })).body.stored).toBe(0)
    await ingestReferrals(body, SECRET, { secret: SECRET, store, recordUnknown: true })
    expect(store.events.map((e) => [e.platform, e.source, e.referrerHost])).toEqual([
      ['unknown', 'referrer', 'www.google.com'],
      ['unknown', 'utm', ''],
    ])
    expect(summarizeReferrals(store.events).total).toBe(0)
    expect(summarizeReferrals(store.events).unknown).toBe(2)
  })

  it('de-duplicates repeats and rate limits', async () => {
    const store = memoryStore()
    const limiter = new ReferralLimiter({ perClientPerMinute: 3 })
    const visit = { url: '/a', referrer: 'https://chatgpt.com/', host: 'site.test', ip: '1.1.1.1', userAgent: 'UA' }
    const first = await ingestReferrals([visit, visit], SECRET, { secret: SECRET, store, limiter })
    expect(first.body).toMatchObject({ stored: 1, duplicates: 1 })
    const other = await ingestReferrals({ ...visit, url: '/b' }, SECRET, { secret: SECRET, store, limiter })
    expect(other.body.stored).toBe(1)
    const over = await ingestReferrals({ ...visit, url: '/c' }, SECRET, { secret: SECRET, store, limiter })
    expect(over.status).toBe(429)
    // Another client is not limited.
    expect((await ingestReferrals({ ...visit, ip: '2.2.2.2', url: '/c' }, SECRET, { secret: SECRET, store, limiter })).body.stored).toBe(1)
    expect(store.events).toHaveLength(3)
  })

  it('records diagnostic probes as test evidence and never stores them', async () => {
    const store = memoryStore()
    const probes = new ProbeRegistry()
    const token = probes.create()
    const probe = { url: '/a', referrer: 'https://chatgpt.com/', host: 'site.test', userAgent: `Mozilla/5.0 (GeoDiagnostics) GeoProbe/${token}` }
    await ingestReferrals(probe, 'wrong', { secret: SECRET, store, probes })
    expect(probes.result(token)?.outcome).toBe('invalid-secret')
    const token2 = probes.create()
    const res = await ingestReferrals({ ...probe, userAgent: `X GeoProbe/${token2}` }, SECRET, { secret: SECRET, store, probes })
    expect(res.body.stored).toBe(0)
    expect(probes.result(token2)?.outcome).toBe('ok')
    // A made-up token is an ordinary visit.
    await ingestReferrals({ ...probe, userAgent: `X GeoProbe/${'0'.repeat(32)}` }, SECRET, { secret: SECRET, store, probes })
    expect(store.events).toHaveLength(1)
  })
})

describe('summaries', () => {
  it('counts AI referral visits per platform, path and UTC day', () => {
    const now = new Date('2026-11-02T12:00:00Z')
    const s = summarizeReferrals(
      [
        { timestamp: '2026-11-02T01:00:00Z', platform: 'OpenAI', source: 'referrer', path: '/a' },
        { timestamp: '2026-11-01T23:59:00Z', platform: 'OpenAI', source: 'utm', path: '/a' },
        { timestamp: '2026-11-01T10:00:00Z', platform: 'Perplexity', source: 'referrer', path: '/b' },
        { timestamp: '2026-09-01T10:00:00Z', platform: 'Perplexity', source: 'referrer', path: '/b' },
      ],
      { days: 7, now },
    )
    expect(s.total).toBe(3)
    expect(s.byPlatform).toEqual([{ platform: 'OpenAI', total: 2 }, { platform: 'Perplexity', total: 1 }])
    expect(s.bySource).toEqual({ referrer: 2, utm: 1 })
    expect(s.daily.at(-1)).toEqual({ date: '2026-11-02', total: 1 })
    expect(s.topPaths[0]).toEqual({ path: '/a', total: 2 })
  })

  it('summarises recorded citation evidence by status, without providers by default', () => {
    const s = summarizeCitations([
      { platform: 'ChatGPT', status: 'verified' },
      { platform: 'ChatGPT', status: 'pending' },
      { platform: 'Perplexity', status: 'invalid' },
    ])
    expect(s).toEqual({
      total: 3,
      byStatus: { pending: 1, verified: 1, invalid: 1 },
      byPlatform: [{ platform: 'ChatGPT', total: 2, verified: 1 }, { platform: 'Perplexity', total: 1, verified: 0 }],
      providers: [],
    })
  })

  it('builds a duplicate key only with platform, answer id and URL', () => {
    expect(citationKey({ platform: 'ChatGPT', answerId: ' abc ', citedURL: 'https://Site.test/a/' })).toBe('chatgpt|abc|site.test/a')
    expect(citationKey({ platform: 'ChatGPT', answerId: 'abc', citedURL: 'https://site.test/a' })).toBe('chatgpt|abc|site.test/a')
    expect(citationKey({ platform: 'ChatGPT', answerId: '', citedURL: 'https://site.test/a' })).toBeNull()
  })
})
