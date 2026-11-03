import node from '@astrojs/node'
import { defineConfig } from 'astro/config'

// SSR: the GEO middleware runs on every request, so crawler visits are reported and llms / Markdown are served live.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
})
