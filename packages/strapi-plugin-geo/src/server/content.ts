import {
  createContentConverter,
  documentURL,
  mergeConverterOptions,
  type ContentConverter,
  type JsonLdSite,
  type LlmsMappingOptions,
} from '@garus-ltd/geo-core'
import type { StrapiLlmsConfig, StrapiLlmsSource } from './config'
import type { StrapiLike } from './types'

type Attribute = { type?: string; target?: string; relation?: string; component?: string; components?: string[]; private?: boolean }

/** Relations that are never content: admin users, localizations, Strapi's own internals. */
function skipRelation(attr: Attribute, name: string): boolean {
  return name === 'localizations' || !attr.target || attr.target.startsWith('admin::') || attr.target === 'plugin::users-permissions.user' || attr.target.startsWith('plugin::geo.')
}

function attributesOf(strapi: StrapiLike, uid: string): Record<string, Attribute> {
  const model = (strapi.getModel?.(uid) ?? strapi.contentType?.(uid) ?? (strapi as { components?: Record<string, any> }).components?.[uid]) as
    | { attributes?: Record<string, Attribute> }
    | undefined
  return model?.attributes ?? {}
}

/**
 * Populate tree for the Document Service built from the schema: media, components and dynamic zones (with their
 * own media and components, any depth up to `componentDepth`), and relations one level deep (their media and
 * components too, up to `relationDepth`). Admin users and localizations are never populated.
 *
 * Strapi's output sanitizer then drops whatever the Public role can't read, relations and media included, so
 * converters only see public content. One query per content type page: no per-block queries.
 */
export function populateFor(strapi: StrapiLike, uid: string, options: { componentDepth?: number; relationDepth?: number } = {}): Record<string, unknown> | '*' {
  const componentDepth = options.componentDepth ?? 5
  const relationDepth = options.relationDepth ?? 1
  const build = (modelUID: string, depth: number, relations: number, seen: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [name, attr] of Object.entries(attributesOf(strapi, modelUID))) {
      if (attr.type === 'media') out[name] = true
      else if (attr.type === 'component' && attr.component) {
        if (depth <= 0 || seen.includes(attr.component)) continue
        const nested = build(attr.component, depth - 1, relations, [...seen, attr.component])
        out[name] = Object.keys(nested).length ? { populate: nested } : true
      } else if (attr.type === 'dynamiczone' && attr.components?.length) {
        if (depth <= 0) continue
        const on: Record<string, unknown> = {}
        for (const c of attr.components) {
          const nested = seen.includes(c) ? {} : build(c, depth - 1, relations, [...seen, c])
          on[c] = Object.keys(nested).length ? { populate: nested } : { populate: '*' }
        }
        out[name] = { on }
      } else if (attr.type === 'relation') {
        if (skipRelation(attr, name) || relations <= 0) continue
        const nested = seen.includes(attr.target!) ? {} : build(attr.target!, Math.min(depth, 2), relations - 1, [...seen, attr.target!])
        // Only media and components of the related document; its own relations stay out.
        const filtered = Object.fromEntries(Object.entries(nested).filter(([k]) => {
          const a = attributesOf(strapi, attr.target!)[k]
          return a?.type === 'media' || a?.type === 'component' || a?.type === 'dynamiczone'
        }))
        out[name] = Object.keys(filtered).length ? { populate: filtered } : true
      }
    }
    return out
  }
  const tree = build(uid, componentDepth, relationDepth, [uid])
  return Object.keys(tree).length ? tree : '*'
}

const converterCache = new WeakMap<object, { global: unknown; converter: ContentConverter }>()

export function converterFor(llms: StrapiLlmsConfig, source: StrapiLlmsSource): ContentConverter {
  const cached = converterCache.get(source)
  if (cached && cached.global === llms.converters) return cached.converter
  const converter = createContentConverter(mergeConverterOptions(llms.converters, source.converters))
  converterCache.set(source, { global: llms.converters, converter })
  return converter
}

export function pluralName(strapi: StrapiLike, uid: string): string {
  return strapi.contentType?.(uid)?.info?.pluralName ?? uid.split('.').pop() ?? uid
}

/** Options for mapping entries of a content type, shared by the public routes, the editor panel and diagnostics. */
export function mappingOptions(strapi: StrapiLike, llms: StrapiLlmsConfig, uid: string, source: StrapiLlmsSource): LlmsMappingOptions {
  return {
    name: pluralName(strapi, uid),
    siteURL: llms.siteURL,
    source,
    converter: converterFor(llms, source),
    mediaURL: llms.mediaURL ?? (strapi.config?.get<string>('server.url', '') || undefined),
    linkFor: (doc, relationTo) => {
      const target = relationTo && Object.prototype.hasOwnProperty.call(llms.contentTypes, relationTo) ? llms.contentTypes[relationTo] : undefined
      return target ? documentURL(doc, pluralName(strapi, relationTo!), target, llms.siteURL) : null
    },
  }
}

export function jsonLdSite(llms: StrapiLlmsConfig): JsonLdSite {
  return { name: llms.name ?? llms.siteURL, url: llms.siteURL, logo: llms.logo, language: llms.language, organization: llms.organization }
}

/** The populate parameter for a content type: the source's own, else the schema-based tree. */
export function populateOf(strapi: StrapiLike, uid: string, source: StrapiLlmsSource): unknown {
  return source.populate ?? populateFor(strapi, uid, { componentDepth: source.populateDepth })
}
