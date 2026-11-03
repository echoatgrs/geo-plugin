export default defineEventHandler(async (event) => {
  const handle = revalidator()
  if (!handle) return new Response('not configured', { status: 404 })
  return handle(toWebRequest(event))
})
