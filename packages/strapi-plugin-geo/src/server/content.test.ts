import { describe, expect, it, vi } from 'vitest'
import { populateFor } from './content'
import { controllers } from './index'
import type { KoaContextLike, StrapiLike } from './types'

const ARTICLE = 'api::article.article'
const models: Record<string, { attributes: Record<string, any>; info?: any }> = {
  [ARTICLE]: {
    info: { pluralName: 'articles' },
    attributes: {
      title: { type: 'string' },
      slug: { type: 'uid' },
      cover: { type: 'media' },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author' },
      related: { type: 'relation', relation: 'manyToMany', target: ARTICLE },
      createdBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
      seo: { type: 'component', component: 'shared.seo' },
      blocks: { type: 'dynamiczone', components: ['shared.rich-text', 'shared.media', 'layout.section'] },
    },
  },
  'api::author.author': { attributes: { name: { type: 'string' }, avatar: { type: 'media' }, articles: { type: 'relation', target: ARTICLE } } },
  'shared.seo': { attributes: { metaTitle: { type: 'string' }, shareImage: { type: 'media' } } },
  'shared.rich-text': { attributes: { body: { type: 'richtext' } } },
  'shared.media': { attributes: { file: { type: 'media' } } },
  'layout.section': { attributes: { heading: { type: 'string' }, blocks: { type: 'dynamiczone', components: ['shared.rich-text', 'layout.section'] } } },
}

function fakeStrapi(config: Record<string, unknown>, entries: Record<string, any>[]) {
  const findMany = vi.fn(async (_params: Record<string, unknown>) => entries)
  const strapi: StrapiLike = {
    plugin: () => ({ config: <T,>(key: string, fallback?: T) => (key in config ? config[key] : fallback) as T }),
    documents: () => ({ create: vi.fn(), findMany }),
    contentType: (uid) => (uid === 'plugin::users-permissions.role' ? {} : (models[uid] as never)),
    getModel: (uid) => models[uid],
    log: { warn: vi.fn(), info: vi.fn() },
    db: { query: () => ({ findOne: async () => ({ type: 'public', permissions: [{ action: `${ARTICLE}.find` }] }) }) },
  }
  return { strapi, findMany }
}

function ctx(query: Record<string, unknown> = {}): KoaContextLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return { request: { get: () => '' }, query, status: 404, body: undefined, headers, set: (k, v) => void (headers[k] = v) }
}

describe('strapi complex content', () => {
  it('builds a populate tree from the schema: components, dynamic zones, media, relations one level', () => {
    const { strapi } = fakeStrapi({}, [])
    expect(populateFor(strapi, ARTICLE)).toEqual({
      cover: true,
      author: { populate: { avatar: true } },
      // Self relations are not followed into (titles and slugs are enough for links).
      related: true,
      seo: { populate: { shareImage: true } },
      blocks: {
        on: {
          'shared.rich-text': { populate: '*' },
          'shared.media': { populate: { file: true } },
          'layout.section': { populate: { blocks: { on: { 'shared.rich-text': { populate: '*' }, 'layout.section': { populate: '*' } } } } },
        },
      },
    })
  })

  it('serves dynamic zones in llms-full.txt and reports nothing private', async () => {
    const entry = {
      title: 'Hello',
      slug: 'hello',
      internalNote: 'secret',
      blocks: [
        { __component: 'shared.rich-text', body: 'First **para**' },
        { __component: 'layout.section', heading: 'More', blocks: [{ __component: 'shared.rich-text', body: 'Nested' }] },
        { __component: 'shared.newsletter', title: 'Sign up' },
        { __component: 'shared.media', file: { url: '/uploads/a.png', alternativeText: 'A' } },
      ],
    }
    const llms = { siteURL: 'https://site.test', name: 'Acme', mediaURL: 'https://cms.test', contentTypes: { [ARTICLE]: { contentField: 'blocks' } } }
    const { strapi, findMany } = fakeStrapi({ llms }, [entry])
    const c = ctx()
    await controllers.llms({ strapi }).llmsFullTxt(c)
    expect(c.body).toContain('First **para**\n\n## More\n\nNested\n\n![A](https://cms.test/uploads/a.png)')
    expect(c.body).not.toContain('Sign up')
    expect(c.body).not.toContain('secret')
    expect(findMany.mock.calls[0]![0]).toMatchObject({ status: 'published', populate: expect.objectContaining({ blocks: expect.any(Object) }) })
  })

  it('uses registered component converters and validates them at startup', async () => {
    const entry = { title: 'Hello', slug: 'hello', blocks: [{ __component: 'shared.newsletter', title: 'Sign up' }] }
    const llms = {
      siteURL: 'https://site.test',
      converters: { blocks: { newsletter: (b: any) => `**${b.title}**` } },
      contentTypes: { [ARTICLE]: { contentField: 'blocks' } },
    }
    const { strapi } = fakeStrapi({ llms }, [entry])
    const c = ctx({ path: '/articles/hello' })
    await controllers.page({ strapi }).markdown(c)
    expect(c.body).toContain('**Sign up**')
    const plugin = (await import('./index')).default
    expect(() => plugin.config.validator({ llms: { ...llms, converters: { blocks: { x: 1 as never } } } } as never)).toThrow(/must be a function/)
    expect(() => plugin.config.validator({ llms: { ...llms, rules: [{ id: 'bad id', check: () => null }] } } as never)).toThrow(/invalid rule id/)
  })
})
