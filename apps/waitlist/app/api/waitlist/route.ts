import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function clip(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Honeypot filled in: pretend it worked so bots don't retry.
  if (clip(body.company_website)) return Response.json({ ok: true })

  const email = clip(body.email, 254).toLowerCase()
  if (!EMAIL.test(email)) {
    return Response.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  const entry = {
    email,
    site: clip(body.site),
    cms: clip(body.cms, 60),
    role: clip(body.role, 60),
    source: clip(body.source, 40),
    createdAt: new Date().toISOString(),
  }

  const webhook = process.env.WAITLIST_WEBHOOK_URL
  if (webhook) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (process.env.WAITLIST_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.WAITLIST_WEBHOOK_TOKEN}`
    try {
      const res = await fetch(webhook, { method: 'POST', headers, body: JSON.stringify(entry) })
      if (!res.ok) throw new Error(`webhook responded ${res.status}`)
    } catch (err) {
      console.error('[waitlist] could not store sign-up:', err)
      return Response.json({ error: 'Could not save your sign-up right now. Please try again.' }, { status: 502 })
    }
    return Response.json({ ok: true })
  }

  if (process.env.NODE_ENV !== 'production') {
    const dir = path.join(process.cwd(), '.data')
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, 'waitlist.jsonl'), JSON.stringify(entry) + '\n')
    return Response.json({ ok: true })
  }

  console.error('[waitlist] WAITLIST_WEBHOOK_URL is not set; sign-up rejected')
  return Response.json({ error: 'Sign-ups are not open yet. Please try again later.' }, { status: 503 })
}
