export default {
  kind: 'collectionType',
  collectionName: 'geo_invalidations',
  info: {
    singularName: 'invalidation',
    pluralName: 'invalidations',
    displayName: 'Cache Notice',
    description:
      'Cache invalidation notices sent to the configured targets after content changes (only when `invalidation.targets` is set). A failed notice never undoes the save; retry it from the GEO dashboard.',
  },
  options: { draftAndPublish: false },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    eventId: { type: 'string', required: true },
    eventType: { type: 'string', required: true },
    source: { type: 'string' },
    target: { type: 'string', required: true },
    status: { type: 'enumeration', enum: ['pending', 'succeeded', 'failed'], required: true },
    attempts: { type: 'integer' },
    lastError: { type: 'string' },
    lastAttemptAt: { type: 'datetime' },
    event: { type: 'json' },
  },
} as const
