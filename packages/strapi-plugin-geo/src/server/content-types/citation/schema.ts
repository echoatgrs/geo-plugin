export default {
  kind: 'collectionType',
  collectionName: 'geo_citations',
  info: {
    singularName: 'citation',
    pluralName: 'citations',
    displayName: 'Citation Evidence',
    description:
      'Answers in which you saw a link to this site, recorded by hand (only when `citations.enabled`). “verified” means someone on your team checked it, not that the platform confirmed it. Not automatic monitoring.',
  },
  options: { draftAndPublish: false },
  pluginOptions: {
    'content-manager': { visible: true },
    'content-type-builder': { visible: false },
  },
  attributes: {
    platform: {
      type: 'enumeration',
      enum: ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'Copilot', 'Google_AI_Overviews', 'DeepSeek', 'Doubao', 'Kimi', 'YandexGPT', 'GigaChat', 'Other'],
      required: true,
    },
    question: { type: 'text', required: true },
    observedAt: { type: 'datetime', required: true },
    citedURL: { type: 'string', required: true },
    answerId: { type: 'string' },
    answerURL: { type: 'string' },
    /** Where the screenshot is kept. Strapi's media library serves files publicly, so it is not used here. */
    screenshotRef: { type: 'string' },
    language: { type: 'string' },
    region: { type: 'string' },
    conditions: { type: 'string' },
    // `status` is reserved by Strapi's Document Service (draft / published).
    reviewStatus: { type: 'enumeration', enum: ['pending', 'verified', 'invalid'], default: 'pending', required: true },
    notes: { type: 'text' },
    /** Edit history written by the plugin: who changed which fields when. Client edits to it are ignored. */
    history: { type: 'json' },
    dedupeKey: { type: 'string', private: true, visible: false },
  },
} as const
