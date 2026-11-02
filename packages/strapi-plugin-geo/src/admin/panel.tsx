import { GeoPanel, type PanelInspection, type PreviewVersion } from '@garus-ltd/geo-dashboard'
import { unstable_useContentManagerContext as useContentManagerContext, useFetchClient } from '@strapi/strapi/admin'
import { useCallback, useEffect, useState } from 'react'

interface PanelProps {
  model: string
  documentId?: string
  collectionType: string
}

let configured: Promise<string[]> | null = null

/** Content types with the GEO panel, fetched once per admin session. */
function useConfiguredTypes(): string[] | null {
  const { get } = useFetchClient()
  const [types, setTypes] = useState<string[] | null>(null)
  useEffect(() => {
    configured ??= get<{ contentTypes: string[] }>('/geo/editor-config')
      .then((r) => r.data.contentTypes)
      .catch(() => {
        configured = null
        return []
      })
    let alive = true
    configured.then((t) => alive && setTypes(t))
    return () => {
      alive = false
    }
  }, [get])
  return types
}

function PanelContent({ model, documentId }: PanelProps) {
  const { post } = useFetchClient()
  const { form } = useContentManagerContext() as { form: { values?: unknown } }
  const values = form?.values ?? {}
  const inspect = useCallback(
    async (data: unknown, signal: AbortSignal, version: PreviewVersion) =>
      (await post<PanelInspection>('/geo/inspect', { model, documentId, data, version }, { signal })).data,
    [post, model, documentId],
  )
  return <GeoPanel documentKey={`${model}:${documentId ?? 'new'}`} values={values} inspect={inspect} bare />
}

/** Content manager side panel. Returns nothing for content types that are not in `llms.contentTypes`. */
export function GeoSidePanel(props: PanelProps) {
  const types = useConfiguredTypes()
  if (!types || !types.includes(props.model)) return null
  return { title: 'GEO', content: <PanelContent {...props} /> }
}
