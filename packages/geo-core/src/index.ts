export { AI_BOTS, detectBot, type BotDefinition, type BotPurpose } from './bots.js'
export { ipInRanges, parseCIDR, parseIP, type CIDR } from './cidr.js'
export { createIPVerifier, parseRangeList, type IPVerifier, type IPVerifierOptions, type Verification } from './verify.js'
export {
  GEO_SECRET_HEADER,
  ingestHits,
  type CrawlerHit,
  type HitInput,
  type HitStore,
  type IngestOptions,
  type IngestResult,
} from './ingest.js'
export { lexicalToMarkdown, richTextToMarkdown, strapiBlocksToMarkdown } from './markdown.js'
export {
  buildLlmsFullTxt,
  buildLlmsTxt,
  documentMarkdown,
  getField,
  joinURL,
  markdownSourcePath,
  markdownURL,
  toLlmsDocument,
  type JsonLdSourceConfig,
  type LlmsDocument,
  type LlmsSite,
  type LlmsSourceConfig,
  type LlmsTxtOptions,
} from './llms.js'
export {
  buildJsonLd,
  findDocumentByPath,
  lastSegment,
  serializeJsonLd,
  type JsonLd,
  type JsonLdSite,
} from './jsonld.js'
export {
  KNOWN_PLATFORMS,
  normalizePath,
  summarizeHits,
  windowStart,
  type CrawlerStats,
  type StatsHit,
  type StatsOptions,
} from './stats.js'
