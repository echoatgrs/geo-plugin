import { site } from '../site.config'
import { WaitlistForm } from './WaitlistForm'

const sampleRows = [
  { bot: 'ChatGPT-User', kind: 'user', page: '/blog/headless-cms-pricing', when: '2 min ago', ok: true },
  { bot: 'PerplexityBot', kind: 'search', page: '/docs/getting-started', when: '9 min ago', ok: true },
  { bot: 'Claude-User', kind: 'user', page: '/blog/payload-vs-strapi', when: '14 min ago', ok: true },
  { bot: 'GPTBot', kind: 'training', page: '/pricing', when: '31 min ago', ok: true },
  { bot: '"GPTBot" (spoofed)', kind: 'unverified', page: '/wp-login.php', when: '40 min ago', ok: false },
]

const cloudFeatures = [
  {
    title: 'Every site in one place',
    body: 'Connect all your sites, or all your clients’ sites, and compare AI crawler and user-fetch activity side by side.',
  },
  {
    title: 'History, trends and weekly reports',
    body: 'Daily rollups kept for months, not just raw hits. A weekly email you can forward to a client or your boss.',
  },
  {
    title: 'Referrals from AI answers',
    body: 'See which visits arrive from ChatGPT, Perplexity, Claude, Gemini and Copilot, and which pages they land on.',
  },
  {
    title: 'Page diagnostics',
    body: 'Find pages no AI has fetched, pages blocked by robots.txt, content that only renders with JavaScript, and missing structured data.',
  },
  {
    title: 'Alerts',
    body: 'Hear about it when a deploy blocks an AI crawler, or when live user fetches for your key pages drop.',
  },
  {
    title: 'Inside your CMS',
    body: 'Editors see the numbers next to the article they are editing, in Payload or Strapi, without opening another tool.',
  },
]

const shipped = [
  'AI crawler logs with IP verification, so spoofed bots are flagged',
  'Training, search and live user visits counted separately',
  'llms.txt and llms-full.txt from your published content',
  'Per-page Markdown (/post.md or Accept: text/markdown)',
  'schema.org JSON-LD for each page',
  'AI visibility dashboard in the Payload and Strapi admin',
]

const faqs = [
  {
    q: 'Is the plugin free?',
    a: 'Yes. The plugin is MIT-licensed and keeps working on its own, with the dashboard inside your CMS. The hosted product adds multi-site views, long history, reports, referrals and alerts on top.',
  },
  {
    q: 'Which stacks does it support?',
    a: 'Payload 3 and Strapi 5 today, with a Next.js frontend reporting crawler visits. Tell us your CMS when you sign up; it decides what we build next.',
  },
  {
    q: 'Will this get me cited by ChatGPT?',
    a: 'Nobody can promise that, and we won’t. What we do is measure what can be measured (which AI agents fetch your pages, how often real users trigger those fetches, and which answers send you visitors) and point out technical problems that keep AI from reading your content.',
  },
  {
    q: 'What data does it collect?',
    a: 'Requests from known AI agents: user agent, IP check result, path and time. It does not set cookies or build profiles of your human visitors.',
  },
  {
    q: 'How much will it cost?',
    a: 'Pricing isn’t set yet. People on the waitlist will see it before anyone is charged, and we’ll ask some of you what it should be.',
  },
]

const kindLabel: Record<string, string> = {
  user: 'Live user',
  search: 'Search index',
  training: 'Training',
  unverified: 'Unverified',
}

export default function Home() {
  return (
    <>
      <header className="nav wrap">
        <span className="logo">
          <span className="logo-mark" aria-hidden="true" />
          {site.name}
        </span>
        <a className="nav-link" href={site.repo}>
          <span className="hide-sm">Open source on </span>GitHub
        </a>
      </header>

      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <p className="eyebrow">Early access · AI search visibility</p>
            <h1>{site.tagline}</h1>
            <p className="lede">
              Track which AI crawlers read your headless site, when real people pull your pages into ChatGPT,
              Claude and Perplexity, and which AI answers send you visitors. Hosted, multi-site, built on an
              open-source plugin you can run today.
            </p>
            <WaitlistForm source="hero" />
            <p className="fine">Free to join. One email when early access opens.</p>
          </div>

          <figure className="panel" aria-label="Example dashboard with sample data">
            <div className="panel-head">
              <span>AI visits · last 24h</span>
              <span className="tag">Sample data</span>
            </div>
            <div className="stats">
              <div><strong>1,284</strong><span>crawler fetches</span></div>
              <div><strong>212</strong><span>live user fetches</span></div>
              <div><strong>37</strong><span>referral visits</span></div>
            </div>
            <ul className="rows">
              {sampleRows.map((r) => (
                <li key={r.bot + r.page}>
                  <span className={`dot ${r.ok ? 'dot-ok' : 'dot-bad'}`} aria-hidden="true" />
                  <span className="row-bot">{r.bot}</span>
                  <span className={`kind kind-${r.kind}`}>{kindLabel[r.kind]}</span>
                  <span className="row-page">{r.page}</span>
                  <span className="row-when">{r.when}</span>
                </li>
              ))}
            </ul>
          </figure>
        </section>

        <section className="band">
          <div className="wrap">
            <h2>Headless sites are invisible in most analytics</h2>
            <p className="section-lede">
              AI crawlers don’t run your analytics script, and your CMS never sees requests to your frontend.
              So the questions that matter for AI search have no answer in the tools you already have.
            </p>
            <div className="questions">
              <p>Is ChatGPT actually reading my new articles?</p>
              <p>Did last week’s deploy block ClaudeBot?</p>
              <p>Which pages do people ask Perplexity about?</p>
              <p>Is that “GPTBot” real, or a scraper using its name?</p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <h2>What the hosted version adds</h2>
          <p className="section-lede">Planned for early access. Waitlist answers decide the order.</p>
          <div className="grid">
            {cloudFeatures.map((f) => (
              <div className="card" key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="wrap section split">
          <div>
            <h2>Built on a plugin you can install now</h2>
            <p className="section-lede">
              The open-source Headless GEO plugin already runs inside Payload and Strapi. The hosted product uses
              the same plugin to send data, so there are no server logs to ship and no tracking script to add.
            </p>
            <ul className="checks">
              {shipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="code">
            <div className="code-head">Available today</div>
            <pre>
              <code>{`npm i payload-plugin-geo @garus-ltd/geo-next
# or
npm i strapi-plugin-geo @garus-ltd/geo-next`}</code>
            </pre>
            <a className="code-link" href={site.repo}>Read the docs on GitHub →</a>
          </div>
        </section>

        <section className="wrap section">
          <h2>Questions</h2>
          <div className="faq">
            {faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="wrap section cta">
          <h2>Get early access</h2>
          <p className="section-lede">We’re letting in a small group first, starting with Payload and Strapi sites.</p>
          <WaitlistForm source="footer" compact />
        </section>
      </main>

      <footer className="wrap footer">
        <span>© {new Date().getFullYear()} {site.shortName}</span>
        <a href={site.repo}>GitHub</a>
      </footer>
    </>
  )
}
