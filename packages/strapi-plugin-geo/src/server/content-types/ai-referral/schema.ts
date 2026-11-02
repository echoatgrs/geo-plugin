export default {
  kind: 'collectionType',
  collectionName: 'geo_ai_referrals',
  info: {
    singularName: 'ai-referral',
    pluralName: 'ai-referrals',
    displayName: 'AI Referral Visit',
    description:
      'Browser visits whose Referer is a known AI assistant (only when `referrals.enabled`). Traffic evidence, not proof of every citation; the Referer can be forged. Host and landing path only.',
  },
  options: { draftAndPublish: false },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    timestamp: { type: 'datetime', required: true },
    platform: { type: 'string', required: true },
    source: { type: 'enumeration', enum: ['referrer', 'utm'], required: true },
    referrerHost: { type: 'string' },
    path: { type: 'string', required: true },
    host: { type: 'string' },
  },
} as const
