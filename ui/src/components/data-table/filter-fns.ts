import type { Row } from "@tanstack/react-table"

export function matchesStringFilter<TData>(
  row: Row<TData>,
  columnId: string,
  filterValue: unknown
): boolean {
  if (!filterValue) {
    return true
  }

  return (
    String(row.getValue(columnId)).toLowerCase() ===
    String(filterValue).toLowerCase()
  )
}
