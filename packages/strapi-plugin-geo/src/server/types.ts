// Minimal structural types for the parts of Strapi 5 this plugin touches,
// so the plugin builds without pulling in @strapi/strapi.
export interface DocumentServiceLike {
  create(params: { data: Record<string, unknown> }): Promise<unknown>
  findMany(params?: Record<string, unknown>): Promise<Record<string, any>[]>
  findOne?(params: Record<string, unknown>): Promise<Record<string, any> | null>
  count?(params?: Record<string, unknown>): Promise<number>
}

export interface StrapiLike {
  plugin(name: string): { config<T = unknown>(key: string, defaultValue?: T): T; service?(name: string): unknown }
  documents(uid: string): DocumentServiceLike
  contentType?(uid: string):
    | { info?: { pluralName?: string }; options?: { draftAndPublish?: boolean }; attributes?: Record<string, unknown> }
    | undefined
  log: { warn(message: string): void; info(message: string): void }
  config?: { get<T = unknown>(key: string, defaultValue?: T): T }
  db?: { query(uid: string): { findOne(params: Record<string, unknown>): Promise<Record<string, any> | null> } }
  getModel?(uid: string): unknown
  /** Route registries, used to see how a content type's REST routes are guarded. */
  apis?: Record<string, unknown>
  plugins?: Record<string, unknown>
  contentAPI?: {
    permissions?: { engine?: { generateAbility(permissions: unknown[]): Promise<{ can(action: string): boolean }> } }
    sanitize?: { output(data: unknown, schema: unknown, options?: { auth?: unknown }): Promise<unknown> }
  }
}

export interface KoaContextLike {
  request: { body?: unknown; get(field: string): string }
  query?: Record<string, unknown>
  state?: { userAbility?: { can(action: string, subject?: string): boolean } }
  status: number
  body: unknown
  set?(field: string, value: string): void
}
