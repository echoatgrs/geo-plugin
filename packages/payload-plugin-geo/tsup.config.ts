import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
  },
  {
    // Admin components are referenced by path (`payload-plugin-geo/client#...`) and must be client components.
    entry: ['src/client.tsx'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    external: ['react', 'react/jsx-runtime', '@garus-ltd/geo-dashboard', '@payloadcms/ui', 'payload', 'payload/shared'],
    banner: { js: "'use client'" },
  },
])
