import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  // Payload renders admin components as React Server Components by default.
  banner: { js: "'use client'" },
})
