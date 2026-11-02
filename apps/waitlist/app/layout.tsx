import type { Metadata } from 'next'
import { site } from '../site.config'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: `${site.name} | AI search visibility for headless sites`,
  description: site.description,
  openGraph: { title: site.name, description: site.description, type: 'website' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
