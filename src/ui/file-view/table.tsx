import { ViewerNotice } from './feedback'

const CELL = 'border-b border-r border-rule px-2 py-1 align-top font-mono text-xs text-ink'
const HEADER = `${CELL} sticky top-0 bg-paper-sunk text-faint`

export function DataTable({
  rows,
  header,
  rowNumbers = false,
}: {
  rows: string[][]
  header: boolean
  rowNumbers?: boolean
}) {
  if (rows.length === 0) return <ViewerNotice>This sheet is empty.</ViewerNotice>

  const head = header ? rows[0] : null
  const body = header ? rows.slice(1) : rows
  const columns = head
    ? head.length
    : rows.reduce((max, row) => Math.max(max, row.length), 0)

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse">
        {head ? (
          <thead>
            <tr>
              {rowNumbers ? <th className={HEADER} aria-label="Row" /> : null}
              {head.map((cell, index) => (
                <th key={index} scope="col" className={`${HEADER} text-left font-medium`}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-paper-sunk/40">
              {rowNumbers ? (
                <td className={`${CELL} w-8 text-right text-faint`}>{rowIndex + 1}</td>
              ) : null}
              {Array.from({ length: columns }, (_, columnIndex) => (
                <td key={columnIndex} className={CELL}>
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
