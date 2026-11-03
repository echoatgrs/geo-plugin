<script setup lang="ts">
import { serializeJsonLd } from '@garus-ltd/geo-next'

const route = useRoute()
const { data: jsonLd } = await useFetch('/api/jsonld', { query: { path: route.path } })
if (!jsonLd.value) throw createError({ statusCode: 404, statusMessage: 'Not found' })
const graph = ((jsonLd.value as Record<string, any>)['@graph'] ?? []) as Record<string, any>[]
const main = graph.find((n) => n.headline || n.name) ?? {}
useHead({
  title: main.headline ?? main.name,
  // serializeJsonLd escapes `<`, so CMS content can't close the script tag.
  script: [{ type: 'application/ld+json', 'data-geo-jsonld': '', innerHTML: serializeJsonLd(jsonLd.value) }],
})
</script>

<template>
  <main>
    <h1>{{ main.headline ?? main.name }}</h1>
    <p v-if="main.description">{{ main.description }}</p>
    <p><a :href="`${route.path}.md`">Markdown version</a></p>
  </main>
</template>
