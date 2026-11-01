import type { CollectionConfig } from 'payload'

export const CRAWLER_HITS_SLUG = 'geo-crawler-hits'

export function crawlerHitsCollection(overrides: Partial<CollectionConfig> = {}): CollectionConfig {
  return {
    slug: CRAWLER_HITS_SLUG,
    labels: { singular: 'AI Crawler Hit', plural: 'AI Crawler Hits' },
    admin: {
      group: 'GEO',
      useAsTitle: 'path',
      defaultColumns: ['timestamp', 'botName', 'purpose', 'verification', 'path'],
      description: 'Requests from AI crawlers, reported by the @garus-ltd/next proxy.',
    },
    // Hits are written by the ingest endpoint with overrideAccess, never through the REST API.
    access: {
      read: ({ req }) => Boolean(req.user),
      create: () => false,
      update: () => false,
      delete: ({ req }) => Boolean(req.user),
    },
    timestamps: false,
    fields: [
      { name: 'timestamp', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'botId', type: 'text', required: true, index: true },
      { name: 'botName', type: 'text', required: true },
      { name: 'platform', type: 'text', required: true, index: true },
      {
        name: 'purpose',
        type: 'select',
        required: true,
        index: true,
        options: [
          { label: 'Training', value: 'training' },
          { label: 'Search index', value: 'search' },
          { label: 'Live user fetch', value: 'user' },
        ],
      },
      {
        name: 'verification',
        type: 'select',
        required: true,
        options: [
          { label: 'Verified IP', value: 'verified' },
          { label: 'Spoofed', value: 'spoofed' },
          { label: 'Unverifiable', value: 'unverifiable' },
        ],
      },
      { name: 'path', type: 'text', required: true, index: true },
      { name: 'host', type: 'text' },
      { name: 'method', type: 'text' },
      { name: 'ip', type: 'text' },
      { name: 'userAgent', type: 'text' },
      { name: 'referer', type: 'text' },
    ],
    ...overrides,
  }
}
