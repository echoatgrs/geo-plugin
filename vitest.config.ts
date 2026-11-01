import { defineConfig } from 'vitest/config'

const src = (pkg: string, file: string) => new URL(`./packages/${pkg}/src/${file}`, import.meta.url).pathname

export default defineConfig({
  resolve: {
    alias: {
      '@garus-ltd/core': src('geo-core', 'index.ts'),
      '@garus-ltd/dashboard': src('geo-dashboard', 'index.tsx'),
    },
  },
  test: { include: ['packages/*/src/**/*.test.{ts,tsx}'] },
})
