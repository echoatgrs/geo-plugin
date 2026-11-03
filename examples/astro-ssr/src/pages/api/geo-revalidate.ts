import type { APIRoute } from 'astro'
import { revalidate } from '../../geo'

export const POST: APIRoute = ({ request }) => (revalidate ? revalidate(request) : new Response('not configured', { status: 404 }))
