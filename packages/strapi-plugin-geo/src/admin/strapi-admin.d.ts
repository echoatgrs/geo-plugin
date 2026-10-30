// Only the piece of the Strapi admin API used here; provided by the host app at runtime.
declare module '@strapi/strapi/admin' {
  export function useFetchClient(): {
    get<T = unknown>(url: string): Promise<{ data: T }>
  }
}
