// Minimal structural types for the parts of Strapi 5 this plugin touches,
// so the plugin builds without pulling in @strapi/strapi.
export interface DocumentServiceLike {
  create(params: { data: Record<string, unknown> }): Promise<unknown>
  findMany(params?: Record<string, unknown>): Promise<Record<string, any>[]>
}

export interface StrapiLike {
  plugin(name: string): { config<T = unknown>(key: string, defaultValue?: T): T }
  documents(uid: string): DocumentServiceLike
  contentType?(uid: string):
    | { info?: { pluralName?: string }; options?: { draftAndPublish?: boolean }; attributes?: Record<string, unknown> }
    | undefined
  log: { warn(message: string): void; info(message: string): void }
  config?: { get<T = unknown>(key: string, defaultValue?: T): T }
  db?: { query(uid: string): { findOne(params: Record<string, unknown>): Promise<Record<string, any> | null> } }
}

export interface KoaContextLike {
  request: { body?: unknown; get(field: string): string }
  query?: Record<string, unknown>
  status: number
  body: unknown
  set?(field: string, value: string): void
}
