import { describe, expect, it, vi } from 'vitest'
import {
  GEO_EVENT_HEADER,
  GEO_SIGNATURE_HEADER,
  SeenEvents,
  contentChangeEvent,
  deliver,
  notifyChange,
  parseChangeEvent,
  signChange,
  siteChangeEvent,
  validateInvalidationOptions,
  verifyChangeSignature,
  type InvalidationOptions,
} from './index.js'

const site = 'https://site.test'
const target = { name: 'frontend', url: 'https://site.test/api/geo-revalidate', secret: 's'.repeat(32) }
const options: InvalidationOptions = { targets: [target] }
const resolve = async () => ['93.184.216.34']

describe('contentChangeEvent', () => {
  it('classifies publish, update, unpublish and delete, and nothing for draft-only changes', () => {
    const a = { url: `${site}/blog/a` }
    expect(contentChangeEvent({ source: 'posts', before: null, after: a, siteURL: site })!.type).toBe('publish')
    expect(contentChangeEvent({ source: 'posts', before: a, after: a, siteURL: site })!.type).toBe('update')
    expect(contentChangeEvent({ source: 'posts', before: a, after: null, siteURL: site })!.type).toBe('unpublish')
    expect(contentChangeEvent({ source: 'posts', before: a, after: null, deleted: true, siteURL: site })!.type).toBe('delete')
    expect(contentChangeEvent({ source: 'posts', before: null, after: null, siteURL: site })).toBeNull()
  })

  it('invalidates the old and new URL, their .md and the llms files on a URL change', () => {
    const e = contentChangeEvent({ source: 'posts', documentId: 7, before: { url: `${site}/blog/old` }, after: { url: `${site}/blog/new` }, siteURL: site })!
    expect(e.paths).toEqual(['/blog/old', '/blog/old.md', '/blog/new', '/blog/new.md', '/llms.txt', '/llms-full.txt'])
    expect(e).toMatchObject({ previousPath: '/blog/old', path: '/blog/new', documentId: '7' })
    expect(e.tags).toContain('geo:path:/blog/old')
    expect(siteChangeEvent('access', site).tags).toContain('geo:all')
  })
})

describe('signatures', () => {
  it('verifies, rejects a changed body, a wrong secret and an old timestamp', async () => {
    const body = '{"id":"1"}'
    const header = await signChange(target.secret, body)
    expect(await verifyChangeSignature(target.secret, body, header)).toBe(true)
    expect(await verifyChangeSignature(target.secret, body + ' ', header)).toBe(false)
    expect(await verifyChangeSignature('x'.repeat(32), body, header)).toBe(false)
    expect(await verifyChangeSignature(target.secret, body, null)).toBe(false)
    const old = await signChange(target.secret, body, Math.floor(Date.now() / 1000) - 3600)
    expect(await verifyChangeSignature(target.secret, body, old)).toBe(false)
  })
})

describe('deliver', () => {
  const event = siteChangeEvent('config', site)

  it('signs the request, records success and never follows redirects', async () => {
    const save = vi.fn(async () => {})
    const fetch = vi.fn(async (_u: URL, init: RequestInit) => {
      const h = new Headers(init.headers)
      expect(await verifyChangeSignature(target.secret, String(init.body), h.get(GEO_SIGNATURE_HEADER))).toBe(true)
      expect(h.get(GEO_EVENT_HEADER)).toBe(event.id)
      expect(init.redirect).toBe('manual')
      return new Response('ok')
    })
    const r = await deliver(event, target, options, { fetch: fetch as never, resolve, store: { save } })
    expect(r).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null })
    expect(save).toHaveBeenCalledOnce()
    const redirect = await deliver(event, target, options, { fetch: (async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })) as never, resolve, sleep: async () => {} })
    expect(redirect).toMatchObject({ status: 'failed', attempts: 1 })
    expect(redirect.lastError).toContain('redirects are not followed')
  })

  it('retries server errors and timeouts a bounded number of times, but not 401', async () => {
    const fail = vi.fn(async () => new Response('', { status: 503 }))
    const r = await deliver(event, target, { ...options, retries: 2 }, { fetch: fail as never, resolve, sleep: async () => {} })
    expect(fail).toHaveBeenCalledTimes(3)
    expect(r).toMatchObject({ status: 'failed', attempts: 3, lastError: 'HTTP 503' })
    const denied = vi.fn(async () => new Response('', { status: 401 }))
    await deliver(event, target, options, { fetch: denied as never, resolve, sleep: async () => {} })
    expect(denied).toHaveBeenCalledOnce()
    const hang = vi.fn((_u: URL, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))))
    const t = await deliver(event, target, { ...options, timeoutMs: 100, retries: 0 }, { fetch: hang as never, resolve })
    expect(t.lastError).toBe('timed out after 100 ms')
  })

  it('refuses private targets unless allowed, and filters by event type', async () => {
    const fetch = vi.fn(async () => new Response('ok'))
    const local = { ...target, url: 'http://127.0.0.1:3000/x' }
    expect((await deliver(event, local, { targets: [local] }, { fetch: fetch as never })).lastError).toContain('private or loopback')
    expect(fetch).not.toHaveBeenCalled()
    expect((await deliver(event, local, { targets: [local], allowPrivateNetwork: true }, { fetch: fetch as never })).status).toBe('succeeded')
    const records = await notifyChange(event, { targets: [{ ...target, events: ['publish'] }] }, { fetch: fetch as never, resolve })
    expect(records).toEqual([])
  })

  it('validates targets at startup', () => {
    expect(() => validateInvalidationOptions({ targets: [{ ...target, secret: 'short' }] })).toThrow(/16 characters/)
    expect(() => validateInvalidationOptions({ targets: [{ ...target, url: 'ftp://x' }] })).toThrow(/http/)
    expect(() => validateInvalidationOptions({ targets: [{ ...target, url: 'https://u:p@x.test' }] })).toThrow(/credentials/)
    expect(() => validateInvalidationOptions({ targets: [target, target] })).toThrow(/duplicate/)
    expect(() => validateInvalidationOptions({ targets: [{ ...target, events: ['nope' as never] }] })).toThrow(/unknown event/)
    expect(() => validateInvalidationOptions(options)).not.toThrow()
  })
})

describe('receiving', () => {
  it('drops repeated event ids and malformed bodies', () => {
    const seen = new SeenEvents()
    expect(seen.first('a')).toBe(true)
    expect(seen.first('a')).toBe(false)
    expect(parseChangeEvent('nope')).toBeNull()
    expect(parseChangeEvent(JSON.stringify({ id: 'x', type: 'publish', paths: ['https://evil/'], urls: [], tags: [] }))).toBeNull()
    expect(parseChangeEvent(JSON.stringify(siteChangeEvent('config', site)))).not.toBeNull()
  })
})

describe('onChange', () => {
  it('runs the in-process listener first, and its errors never stop the notices', async () => {
    const { invalidationActive } = await import('./index.js')
    const event = siteChangeEvent('config', site)
    const seen: string[] = []
    const fetch = vi.fn(async () => new Response('ok'))
    const records = await notifyChange(event, { targets: [target], onChange: (e) => { seen.push(e.id); throw new Error('boom') } }, { fetch: fetch as never, resolve, log: () => {} })
    expect(seen).toEqual([event.id])
    expect(records[0]!.status).toBe('succeeded')
    expect(invalidationActive({ targets: [], onChange: () => {} })).toBe(true)
    expect(invalidationActive({ targets: [] })).toBe(false)
    expect(() => validateInvalidationOptions({ targets: [], onChange: 'x' as never })).toThrow()
  })
})
