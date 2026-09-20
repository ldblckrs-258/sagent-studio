import { useCallback, useState } from 'react'
import type { FileTarget } from '../../session/file-view-state'
import type { WorkspaceFs } from '../../workspace/fs'
import { ViewerError, ViewerLoading, ViewerNotice } from './feedback'
import {
  useAsyncResource,
  useRemoteBlob,
  useRemoteText,
  useWorkspaceBlob,
  useWorkspaceText,
} from './load'
import type { SpreadsheetApi } from './spreadsheet'
import { workbookToTables } from './spreadsheet'
import { DataTable } from './table'

async function loadSpreadsheetApi(): Promise<SpreadsheetApi> {
  const module = await import('xlsx')
  return module as unknown as SpreadsheetApi
}

/**
 * Parses whichever source this sheet viewer loaded. CSV arrives as text and
 * spreadsheets as a binary blob; both go through SheetJS so quoted CSV and TSV
 * are handled by the same parser.
 */
function useWorkbook(csvText: string | null, documentBlob: Blob | null) {
  const load = useCallback(async () => {
    if (documentBlob) {
      const api = await loadSpreadsheetApi()
      return workbookToTables(api, await documentBlob.arrayBuffer(), 'array')
    }
    if (csvText !== null) {
      const api = await loadSpreadsheetApi()
      return workbookToTables(api, csvText, 'string')
    }
    return null
  }, [csvText, documentBlob])
  return useAsyncResource(load)
}

export function SheetView({
  fs,
  target,
  kind,
}: {
  fs: WorkspaceFs | null
  target: FileTarget
  kind: 'csv' | 'spreadsheet'
}) {
  const workspacePath = target.kind === 'workspace' ? target.path : null
  const remoteUrl = target.kind === 'url' ? target.url : null
  const isCsv = kind === 'csv'

  const workspaceText = useWorkspaceText(fs, isCsv ? workspacePath : null)
  const remoteText = useRemoteText(isCsv ? remoteUrl : null)
  const workspaceBlob = useWorkspaceBlob(fs, isCsv ? null : workspacePath)
  const remoteBlob = useRemoteBlob(isCsv ? null : remoteUrl)

  const textResource = workspacePath !== null ? workspaceText : remoteText
  const blobResource = workspacePath !== null ? workspaceBlob : remoteBlob
  const active = isCsv ? textResource : blobResource

  const csvText = isCsv && textResource.status === 'ready' ? textResource.value : null
  const documentBlob = !isCsv && blobResource.status === 'ready' ? blobResource.value : null

  const workbook = useWorkbook(csvText, documentBlob)
  const [activeSheet, setActiveSheet] = useState(0)

  if (active.status === 'error') {
    return <ViewerError message={active.error ?? 'The file could not be loaded.'} />
  }
  if (active.status === 'loading' || active.status === 'idle' || workbook.status === 'loading') {
    return <ViewerLoading label="Parsing sheet…" />
  }
  if (workbook.status === 'error') {
    return <ViewerError message={workbook.error ?? 'The sheet could not be parsed.'} />
  }

  const tables = workbook.value ?? []
  if (tables.length === 0) return <ViewerNotice>This file has no sheets.</ViewerNotice>

  const index = Math.min(activeSheet, tables.length - 1)
  const table = tables[index]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tables.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-rule px-2 py-1">
          {tables.map((sheet, sheetIndex) => (
            <button
              key={sheet.name}
              type="button"
              aria-pressed={sheetIndex === index}
              onClick={() => setActiveSheet(sheetIndex)}
              className={`shrink-0 rounded-sm px-2 py-1 font-mono text-xs transition-colors ${
                sheetIndex === index
                  ? 'bg-accent-soft text-accent'
                  : 'text-muted hover:bg-paper-sunk hover:text-ink'
              }`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <DataTable rows={table.rows} header={isCsv} rowNumbers={!isCsv} />
      </div>
    </div>
  )
}
