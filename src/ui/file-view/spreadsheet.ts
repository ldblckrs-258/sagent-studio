export interface SheetTable {
  name: string
  rows: string[][]
}

/**
 * Minimal structural view of the SheetJS API this app uses. Keeping it local
 * makes the pure conversion below testable with the real module or a stub, and
 * keeps the large dependency behind a typed boundary.
 */
export interface SpreadsheetApi {
  read(
    data: ArrayBuffer | string,
    options: { type: 'array' | 'string' },
  ): { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: {
    sheet_to_json(
      sheet: unknown,
      options: { header: 1; raw: false; defval: string; blankrows: boolean },
    ): unknown[][]
  }
}

export function workbookToTables(
  api: SpreadsheetApi,
  data: ArrayBuffer | string,
  type: 'array' | 'string',
): SheetTable[] {
  const workbook = api.read(data, { type })
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    const raw = sheet
      ? api.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
        })
      : []
    const rows = raw.map((row) =>
      Array.isArray(row) ? row.map((cell) => (cell == null ? '' : String(cell))) : [],
    )
    return { name, rows }
  })
}
