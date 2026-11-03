import { describe, expect, it, vi } from 'vitest'
import { CleanupLock, csvCell, exportStream, historyIncomplete, parseCleanupRequest, parseExportRequest, retentionCutoff, runBatchedCleanup, validateRetention } from './index.js'

const now = new Date('2026-11-03T00:00:00Z')

describe('retention', () => {
  it('is off by default and validated', () => {
    expect(retentionCutoff(undefined, 'hits', now)).toBeNull()
    expect(retentionCutoff({ hitsDays: 30 }, 'hits', now)!.toISOString()).toBe('2026-10-04T00:00:00.000Z')
    expect(() => validateRetention({ hitsDays: 0 })).toThrow()
    expect(() => validateRetention({ autoCleanup: true })).toThrow(/allowDelete/)
    expect(() => validateRetention({ hitsDays: 90, allowDelete: true, autoCleanup: true })).not.toThrow()
  })

  it('parses cleanup requests: preview unless confirm is exactly true, never recent data', () => {
    expect(parseCleanupRequest({ dataset: 'hits' }, undefined, now)).toMatchObject({ error: expect.stringContaining('before') })
    expect(parseCleanupRequest({ dataset: 'x' }, undefined, now)).toHaveProperty('error')
    expect(parseCleanupRequest({ dataset: 'hits', before: '2026-11-02T12:00:00Z' }, undefined, now)).toHaveProperty('error')
    expect(parseCleanupRequest({ dataset: 'hits', confirm: 'yes' }, { hitsDays: 30 }, now)).toMatchObject({ dataset: 'hits', confirm: false })
    expect(parseCleanupRequest({ dataset: 'hits', before: '2026-01-01', confirm: true }, undefined, now)).toMatchObject({ confirm: true })
  })

  it('deletes in batches until done and locks per dataset', async () => {
    let left = 1234
    const del = vi.fn(async (n: number) => {
      const d = Math.min(n, left)
      left -= d
      return d
    })
    expect(await runBatchedCleanup(del, { batchSize: 500 })).toBe(1234)
    expect(del).toHaveBeenCalledTimes(3)
    const lock = new CleanupLock()
    expect(lock.acquire('hits')).toBe(true)
    expect(lock.acquire('hits')).toBe(false)
    lock.release('hits')
    expect(lock.acquire('hits')).toBe(true)
  })

  it('flags stats windows that reach before the last cleanup', () => {
    expect(historyIncomplete(new Date('2026-10-01'), '2026-10-04T00:00:00Z')).toBe(true)
    expect(historyIncomplete(new Date('2026-10-10'), '2026-10-04T00:00:00Z')).toBe(false)
    expect(historyIncomplete(new Date('2026-10-01'), null)).toBe(false)
  })
})

describe('export', () => {
  it('escapes formulas and quotes CSV cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    for (const v of ['+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(v).replace(/^"/, '')[0]).toBe("'")
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
  })

  it('leaves sensitive fields out unless asked, refuses unknown ones', () => {
    const r = parseExportRequest(new URLSearchParams('dataset=hits'))
    expect(r).toMatchObject({ format: 'csv' })
    expect((r as { fields: string[] }).fields).not.toContain('ip')
    expect(parseExportRequest(new URLSearchParams('dataset=hits&fields=ip'))).toHaveProperty('error')
    expect((parseExportRequest(new URLSearchParams('dataset=hits&sensitive=1')) as { fields: string[] }).fields).toContain('ip')
    expect(parseExportRequest(new URLSearchParams('dataset=hits&fields=nope'))).toHaveProperty('error')
    expect(parseExportRequest(new URLSearchParams('dataset=hits&from=garbage'))).toHaveProperty('error')
  })

  it('streams CSV and JSON page by page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ timestamp: `t${i}`, path: i === 2 ? '=cmd' : `/p${i}`, ip: '1.2.3.4' }))
    const page = vi.fn(async (o: number, l: number) => rows.slice(o, o + l))
    // Response.text() drops the BOM, so decode the bytes as they are.
    const bytes = new Uint8Array(await new Response(exportStream({ dataset: 'hits', format: 'csv', fields: ['timestamp', 'path'] }, page, 2)).arrayBuffer())
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    expect(csv).toBe("\ufefftimestamp,path\r\nt0,/p0\r\nt1,/p1\r\nt2,'=cmd\r\nt3,/p3\r\nt4,/p4\r\n")
    expect(page).toHaveBeenCalledTimes(3)
    const json = JSON.parse(await new Response(exportStream({ dataset: 'hits', format: 'json', fields: ['path'] }, page, 2)).text())
    expect(json).toHaveLength(5)
    expect(json[0]).toEqual({ path: '/p0' })
    const empty = await new Response(exportStream({ dataset: 'hits', format: 'json', fields: ['path'] }, async () => [], 2)).text()
    expect(JSON.parse(empty)).toEqual([])
  })
})
