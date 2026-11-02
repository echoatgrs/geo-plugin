// Only the pieces of the Strapi admin API used here; provided by the host app at runtime.
declare module '@strapi/strapi/admin' {
  export function useFetchClient(): {
    get<T = unknown>(url: string, options?: { signal?: AbortSignal }): Promise<{ data: T }>
    post<T = unknown>(url: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<{ data: T }>
  }
  export function unstable_useContentManagerContext(): { form: unknown; model: string; id?: string }
}
