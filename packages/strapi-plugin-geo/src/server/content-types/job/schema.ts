export default {
  kind: 'collectionType',
  collectionName: 'geo_jobs',
  info: {
    singularName: 'job',
    pluralName: 'jobs',
    displayName: 'GEO Data Job',
    description: 'Cleanups and exports of GEO data. Deleting is off unless `retention.allowDelete` is set.',
  },
  options: { draftAndPublish: false },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    kind: { type: 'enumeration', enum: ['cleanup', 'export'], required: true },
    dataset: { type: 'enumeration', enum: ['hits', 'referrals', 'invalidations'], required: true },
    status: { type: 'enumeration', enum: ['running', 'succeeded', 'failed'], required: true },
    before: { type: 'datetime' },
    deleted: { type: 'integer' },
    startedBy: { type: 'string' },
    startedAt: { type: 'datetime', required: true },
    finishedAt: { type: 'datetime' },
    error: { type: 'text' },
  },
} as const
