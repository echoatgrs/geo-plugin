import type { ComponentType } from 'react'
import { GeoSidePanel } from './panel'

const PLUGIN_ID = 'geo'

function GeoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  )
}

interface StrapiApp {
  addMenuLink(link: {
    to: string
    icon: ComponentType
    intlLabel: { id: string; defaultMessage: string }
    Component: () => Promise<{ default: ComponentType }>
    permissions: unknown[]
  }): void
  registerPlugin(plugin: { id: string; name: string }): void
  getPlugin(id: string): { apis?: { addEditViewSidePanel?(panels: unknown[]): void } } | undefined
}

export default {
  register(app: StrapiApp) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: GeoIcon,
      intlLabel: { id: `${PLUGIN_ID}.plugin.name`, defaultMessage: 'AI Visibility' },
      Component: () => import('./page'),
      permissions: [],
    })
    app.registerPlugin({ id: PLUGIN_ID, name: 'Headless GEO' })
  },
  bootstrap(app: StrapiApp) {
    // Read-only GEO check panel in the edit view; it renders only for content types in `llms.contentTypes`.
    app.getPlugin('content-manager')?.apis?.addEditViewSidePanel?.([GeoSidePanel])
  },
}
