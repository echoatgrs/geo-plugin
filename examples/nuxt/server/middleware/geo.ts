// Runs before every page and API route: reports AI crawlers, answers /llms.txt, /llms/<part>.txt and Markdown.
export default defineEventHandler(async (event) => {
  const handled = await geo()(toWebRequest(event), { waitUntil: (p) => event.waitUntil(p) })
  if (handled) return handled
})
