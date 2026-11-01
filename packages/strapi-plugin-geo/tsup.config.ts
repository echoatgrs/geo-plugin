import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Strapi loads the server side with require(), so it is CommonJS.
    entry: { 'server/index': 'src/server/index.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }),
    dts: true,
    sourcemap: true,
  },
  {
    // Bundled by the Strapi admin build (Vite or webpack) of the host app.
    entry: { 'admin/index': 'src/admin/index.tsx' },
    format: ['esm', 'cjs'],
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
    dts: false,
    sourcemap: true,
    external: ['react', 'react/jsx-runtime', '@strapi/strapi/admin', '@garus-ltd/dashboard'],
  },
])
