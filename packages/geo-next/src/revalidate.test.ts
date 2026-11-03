import { describe, expect, it, vi } from 'vitest'
import { signChange, siteChangeEvent } from '@garus-ltd/geo-core'
import { llmsSegmentRoute, revalidationHandler } from './index.js'

const secret = 'z'.repeat(32)
const post = async (body: string, header?: string) =>
  new Request('https://site.test/api/geo-revalidate', { method: 'POST', body, headers: header ? { 'x-geo-signature': header } : {} })

describe('revalidationHandler', () => {
  it('acts once per event id, refuses bad signatures and malformed events, lets the CMS retry after a failure', async () => {
    const onEvent = vi.fn()
    const handle = revalidationHandler({ secret, onEvent })
    const body = JSON.stringify(siteChangeEvent('config', 'https://site.test'))
    expect((await handle(await post(body, await signChange(secret, body)))).status).toBe(200)
    const again = await handle(await post(body, await signChange(secret, body)))
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    expect(onEvent).toHaveBeenCalledOnce()
    expect((await handle(await post(body, await signChange('w'.repeat(32), body)))).status).toBe(401)
    expect((await handle(await post(body))).status).toBe(401)
    const old = await signChange(secret, body, Math.floor(Date.now() / 1000) - 3600)
    expect((await handle(await post(body, old))).status).toBe(401)
    const bad = '{"id":"x"}'
    expect((await handle(await post(bad, await signChange(secret, bad)))).status).toBe(400)
    expect((await handle(new Request('https://site.test/x'))).status).toBe(405)

    const failing = vi.fn().mockRejectedValueOnce(new Error('cache down')).mockResolvedValue(undefined)
    const h2 = revalidationHandler({ secret, onEvent: failing })
    const e2 = JSON.stringify(siteChangeEvent('access', 'https://site.test'))
    expect((await h2(await post(e2, await signChange(secret, e2)))).status).toBe(500)
    expect((await h2(await post(e2, await signChange(secret, e2)))).status).toBe(200)
    expect(failing).toHaveBeenCalledTimes(2)
    expect(() => revalidationHandler({ secret: 'short', onEvent })).toThrow()
  })
})

describe('llmsSegmentRoute', () => {
  it('forwards only part file names and passes 404s through', async () => {
    const fetch = vi.fn(async (url: URL) => (url.pathname.endsWith('posts-1.txt') ? new Response('# part') : new Response('', { status: 404 })))
    const route = llmsSegmentRoute({ source: 'https://cms.test/api/geo/llms', fetch: fetch as never })
    const ok = await route(new Request('https://site.test/llms/posts-1.txt'), { params: Promise.resolve({ file: 'posts-1.txt' }) })
    expect(await ok.text()).toBe('# part')
    expect(String(fetch.mock.calls[0]![0])).toBe('https://cms.test/api/geo/llms/posts-1.txt')
    expect((await route(new Request('https://site.test/llms/posts-9.txt'))).status).toBe(404)
    const calls = fetch.mock.calls.length
    for (const file of ['..%2Fsetup-1.txt', 'x.txt', '../admin']) expect((await route(new Request('https://site.test/llms/x'), { params: { file } })).status).toBe(404)
    expect(fetch.mock.calls.length).toBe(calls)
  })
})
