import { defineConfig } from 'vitest/config'

const src = (pkg: string, file: string) => new URL(`./packages/${pkg}/src/${file}`, import.meta.url).pathname

export default defineConfig({
  resolve: {
    alias: {
      '@garus-ltd/geo-core': src('geo-core', 'index.ts'),
      '@garus-ltd/geo-dashboard': src('geo-dashboard', 'index.tsx'),
    },
  },
  test: { include: ['packages/*/src/**/*.test.{ts,tsx}', 'examples/extension/src/**/*.test.ts'] },
})
