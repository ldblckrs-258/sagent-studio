import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { SpreadsheetApi } from './spreadsheet'
import { workbookToTables } from './spreadsheet'

const api = XLSX as unknown as SpreadsheetApi

describe('workbookToTables', () => {
  it('parses CSV text into a single table', () => {
    const tables = workbookToTables(api, 'name,qty\nwidget,2\n', 'string')
    expect(tables).toHaveLength(1)
    expect(tables[0].rows).toEqual([
      ['name', 'qty'],
      ['widget', '2'],
    ])
  })

  it('keeps a quoted CSV field containing a comma intact', () => {
    const tables = workbookToTables(api, 'label,note\n"a,b",ok\n', 'string')
    expect(tables[0].rows).toEqual([
      ['label', 'note'],
      ['a,b', 'ok'],
    ])
  })

  it('parses a binary workbook into one table per sheet', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'One')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['x']]), 'Two')
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer

    const tables = workbookToTables(api, buffer, 'array')
    expect(tables.map((table) => table.name)).toEqual(['One', 'Two'])
    expect(tables[0].rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(tables[1].rows).toEqual([['x']])
  })
})
