'use client'

import { useState } from 'react'

type State = 'idle' | 'sending' | 'done' | 'error'

export function WaitlistForm({ source, compact = false }: { source: string; compact?: boolean }) {
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    setState('sending')
    setError('')
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...data, source }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || 'Something went wrong. Please try again.')
      }
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setState('error')
    }
  }

  if (state === 'done') {
    return (
      <div className="form-done" role="status">
        <strong>You're on the list.</strong> We'll email you when early access opens. No spam, and you can
        reply to that email to tell us what you want tracked.
      </div>
    )
  }

  return (
    <form className={compact ? 'form form-compact' : 'form'} onSubmit={onSubmit} noValidate={false}>
      <div className="form-row">
        <label className="sr-only" htmlFor={`email-${source}`}>Work email</label>
        <input
          id={`email-${source}`}
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
        />
        <button type="submit" disabled={state === 'sending'}>
          {state === 'sending' ? 'Joining…' : 'Join the waitlist'}
        </button>
      </div>
      {!compact && (
        <div className="form-extra">
          <label>
            <span>Your site (optional)</span>
            <input name="site" type="text" inputMode="url" placeholder="example.com" />
          </label>
          <label>
            <span>CMS</span>
            <select name="cms" defaultValue="">
              <option value="">Choose…</option>
              <option>Payload</option>
              <option>Strapi</option>
              <option>Sanity</option>
              <option>Contentful</option>
              <option>WordPress (headless)</option>
              <option>Other</option>
            </select>
          </label>
          <label>
            <span>You are</span>
            <select name="role" defaultValue="">
              <option value="">Choose…</option>
              <option>Agency</option>
              <option>In-house marketing / SEO</option>
              <option>Developer</option>
              <option>Founder</option>
              <option>Other</option>
            </select>
          </label>
        </div>
      )}
      {/* Honeypot: real people never see or fill this. */}
      <input className="hp" name="company_website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      {state === 'error' && <p className="form-error" role="alert">{error}</p>}
    </form>
  )
}
