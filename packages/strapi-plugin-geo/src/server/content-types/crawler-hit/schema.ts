export default {
  kind: 'collectionType',
  collectionName: 'geo_crawler_hits',
  info: {
    singularName: 'crawler-hit',
    pluralName: 'crawler-hits',
    displayName: 'AI Crawler Hit',
    description: 'Requests from AI crawlers, reported by the @garus-ltd/geo-next proxy.',
  },
  options: { draftAndPublish: false },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    timestamp: { type: 'datetime', required: true },
    botId: { type: 'string', required: true },
    botName: { type: 'string', required: true },
    platform: { type: 'string', required: true },
    purpose: { type: 'enumeration', enum: ['training', 'search', 'user'], required: true },
    verification: { type: 'enumeration', enum: ['verified', 'spoofed', 'unverifiable'], required: true },
    path: { type: 'string', required: true },
    host: { type: 'string' },
    method: { type: 'string' },
    ip: { type: 'string' },
    userAgent: { type: 'text' },
    referer: { type: 'text' },
  },
} as const
