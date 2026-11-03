export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  runtimeConfig: {
    // Server-only, set with NUXT_CMS_URL, NUXT_GEO_SECRET, NUXT_GEO_REVALIDATE_SECRET.
    cmsUrl: 'http://localhost:1337',
    geoSecret: '',
    geoRevalidateSecret: '',
  },
})
