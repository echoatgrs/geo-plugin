import { describe, expect, it, vi } from 'vitest'
import {
  IngestLog,
  ProbeRegistry,
  configChecks,
  evidenceChecks,
  ingestHits,
  isPrivateAddress,
  probeUserAgent,
  runActiveChecks,
  safeFetch,
  summarizeDocumentHits,
  type DocumentHit,
  type SetupFacts,
} from './index.js'

const now = new Date('2026-11-02T12:00:00Z')
const hit = (over: Partial<DocumentHit>): DocumentHit => ({
  platform: 'OpenAI', purpose: 'user', verification: 'verified', path: '/blog/a', timestamp: '2026-11-02T08:00:00Z', botId: 'chatgpt-user', host: 'site.test', ...over,
})

describe('summarizeDocumentHits', () => {
  it('counts one document: .md merged, spoofed excluded, other hosts and other pages left out, UTC days zero-filled', () => {
    const stats = summarizeDocumentHits(
      [
        hit({}),
        hit({ path: '/blog/a.md', purpose: 'training', platform: 'Anthropic', botId: 'claudebot', verification: 'unverifiable' }),
        hit({ path: '/blog/a/?utm=1#x' }),
        hit({ verification: 'spoofed' }),
        hit({ host: 'other.test' }),
        hit({ path: '/blog/ab' }),
        hit({ path: '/en/blog/a' }),
        hit({ timestamp: '2026-11-01T23:59:59Z' }),
        hit({ timestamp: '2026-10-01T00:00:00Z' }),
        hit({ host: null }),
      ],
      { path: '/blog/a', hosts: ['site.test'], days: 7, now },
    )
    expect(stats.total).toBe(5)
    expect(stats.markdownHits).toBe(1)
    expect(stats.byVerification).toEqual({ verified: 4, spoofed: 1, unverifiable: 1 })
    expect(stats.otherHosts).toBe(1)
    expect(stats.byPlatform).toEqual([{ platform: 'OpenAI', total: 4, user: 4 }, { platform: 'Anthropic', total: 1, user: 0 }])
    expect(stats.daily).toHaveLength(7)
    expect(stats.daily.at(-1)).toEqual({ date: '2026-11-02', total: 4, user: 3 })
    expect(stats.daily.at(-2)).toEqual({ date: '2026-11-01', total: 1, user: 1 })
    expect(stats.daily[0]).toEqual({ date: '2026-10-27', total: 0, user: 0 })
    expect(stats.lastSeen).toBe('2026-11-02T08:00:00.000Z')
    expect(stats.recent[0]!.path).toBeDefined()
    expect(stats.recent.some((r) => r.verification === 'spoofed')).toBe(true)
    expect(stats.timeZone).toBe('UTC')
  })
})

describe('probes', () => {
  it('records issued probe tokens as evidence without storing them, and flags a wrong secret', async () => {
    const probes = new ProbeRegistry()
    const log = new IngestLog()
    const token = probes.create()
    const save = vi.fn(async () => {})
    const res = await ingestHits({ path: '/blog/a', userAgent: probeUserAgent(token), host: 'site.test' }, 's', { secret: 's', store: { save }, probes, log })
    expect(res.body).toMatchObject({ stored: 0, skipped: 1 })
    expect(save).not.toHaveBeenCalled()
    expect(probes.result(token)).toMatchObject({ outcome: 'ok', path: '/blog/a' })
    expect(log.lastSuccess).not.toBeNull()

    const other = probes.create()
    const bad = await ingestHits({ path: '/x', userAgent: probeUserAgent(other) }, 'wrong', { secret: 's', store: { save }, probes, log })
    expect(bad.status).toBe(401)
    expect(probes.result(other)?.outcome).toBe('invalid-secret')
    expect(log.recentErrors()[0]).toMatchObject({ status: 401, error: 'invalid secret' })
    expect(JSON.stringify(log.recentErrors())).not.toContain('wrong')
  })

  it('stores a made-up probe token as an ordinary hit', async () => {
    const probes = new ProbeRegistry()
    const save = vi.fn(async () => {})
    await ingestHits({ path: '/', userAgent: probeUserAgent('0'.repeat(32)) }, null, { store: { save }, probes })
    expect(save).toHaveBeenCalledOnce()
  })
})

describe('safeFetch', () => {
  const ok = (body = 'x', headers: Record<string, string> = { 'content-type': 'text/html' }, status = 200) => new Response(body, { status, headers })
  const resolve = async (h: string) => (h === 'site.test' ? ['93.184.216.34'] : h === 'internal.test' ? ['10.0.0.5'] : ['127.0.0.1'])

  it('allows only the configured origin and public addresses', async () => {
    const fetch = vi.fn(async () => ok())
    await expect(safeFetch('https://evil.test/', { allowedOrigins: ['https://site.test'], resolve, fetch })).rejects.toThrow(/not the configured site/)
    await expect(safeFetch('https://internal.test/', { allowedOrigins: ['https://internal.test'], resolve, fetch })).rejects.toThrow(/private/)
    await expect(safeFetch('http://localhost:3000/', { allowedOrigins: ['http://localhost:3000'], resolve, fetch })).rejects.toThrow(/private/)
    expect((await safeFetch('http://localhost:3000/', { allowedOrigins: ['http://localhost:3000'], allowPrivateNetwork: true, fetch })).status).toBe(200)
    expect((await safeFetch('https://site.test/a', { allowedOrigins: ['https://site.test'], resolve, fetch })).status).toBe(200)
    await expect(safeFetch('https://site.test/a', { allowedOrigins: ['https://site.test'], fetch })).rejects.toThrow(/DNS resolver/)
  })

  it('re-checks redirects and caps the body', async () => {
    const fetch = vi.fn(async (url: URL) =>
      url.pathname === '/r' ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) : ok('y'.repeat(1000)),
    )
    await expect(safeFetch('https://site.test/r', { allowedOrigins: ['https://site.test'], resolve, fetch: fetch as never })).rejects.toThrow(/not the configured site/)
    const res = await safeFetch('https://site.test/big', { allowedOrigins: ['https://site.test'], resolve, fetch: fetch as never, maxBytes: 100 })
    expect(res.truncated).toBe(true)
    expect(res.body.length).toBeLessThanOrEqual(100)
  })

  it('times out', async () => {
    const fetch = vi.fn((_u: URL, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))))
    await expect(safeFetch('https://site.test/', { allowedOrigins: ['https://site.test'], resolve, fetch: fetch as never, timeoutMs: 20 })).rejects.toThrow()
  })

  it('knows private addresses, IPv4-mapped included', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', 'nonsense']) expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ['93.184.216.34', '2606:4700::1']) expect(isPrivateAddress(ip)).toBe(false)
  })
})

describe('setup checks', () => {
  const facts: SetupFacts = {
    llmsConfigured: true, siteURL: 'https://site.test', sources: [{ name: 'posts', exists: true, publicDocuments: 2 }], sample: { url: 'https://site.test/blog/a', title: 'A' },
    markdownLinks: false, ingestEnabled: true, secretConfigured: true, verifyIPs: true, latestHit: null, lastIngestSuccess: null, recentIngestErrors: [],
  }
  it('says "no data received yet" instead of failing for a quiet site', () => {
    const ev = evidenceChecks(facts)
    expect(ev[0]).toMatchObject({ id: 'EV-LATEST', status: 'unknown' })
    expect(ev[0]!.detail).toContain('No data received yet')
  })
  it('never shows the secret and reports a disabled ingest', () => {
    const items = configChecks({ ...facts, ingestEnabled: false })
    expect(items.find((i) => i.id === 'CFG-INGEST')!.status).toBe('notEnabled')
    expect(items.find((i) => i.id === 'CFG-SECRET')!.detail).toContain('never shown')
  })

  it('runs active checks: unknown when the proxy never reports, notEnabled when features are missing', async () => {
    const probes = new ProbeRegistry()
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      const h = new Headers(init.headers)
      if (url.pathname === '/blog/a' && h.get('accept') === 'text/html') {
        // Simulate the proxy reporting the probe with a valid secret.
        const token = /GeoProbe\/(\w+)/.exec(h.get('user-agent') ?? '')?.[1]
        if (token) probes.record(token, 'ok', { path: url.pathname, host: url.host })
        return new Response('<html><script type="application/ld+json">{}</script></html>', { headers: { 'content-type': 'text/html' } })
      }
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } })
    })
    const items = await runActiveChecks({ siteURL: 'https://site.test', sample: facts.sample, probes, ingestEnabled: true, fetch: fetch as never, resolve: async () => ['93.184.216.34'], sleep: async () => {} })
    const by = Object.fromEntries(items.map((i) => [i.id, i.status]))
    expect(by).toEqual({ 'ACT-HTML': 'pass', 'ACT-JSONLD': 'pass', 'ACT-MD': 'notEnabled', 'ACT-ACCEPT': 'notEnabled', 'ACT-LLMS': 'notEnabled', 'ACT-PROBE': 'pass' })

    const silent = await runActiveChecks({ siteURL: 'https://site.test', sample: facts.sample, probes: new ProbeRegistry(), ingestEnabled: true, fetch: (async () => new Response('', { status: 404 })) as never, resolve: async () => ['93.184.216.34'], probeWaitMs: 5, sleep: async () => {} })
    expect(silent.find((i) => i.id === 'ACT-HTML')!.status).toBe('error')
    expect(silent.find((i) => i.id === 'ACT-PROBE')!.status).toBe('unknown')

    const down = await runActiveChecks({ siteURL: 'https://site.test', sample: facts.sample, ingestEnabled: true, fetch: (async () => { throw new Error('ECONNREFUSED') }) as never, resolve: async () => ['93.184.216.34'] })
    expect(down.every((i) => i.status === 'unknown')).toBe(true)
  })
})
