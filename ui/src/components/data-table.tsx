import type { Row, Table as TanstackTable } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";

import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type DataTableProps<TData> = {
  table: TanstackTable<TData>;
  isLoading?: boolean;
  error?: string | null;
  emptyMessage: string;
  onRowClick?: (row: TData) => void;
  getRowClassName?: (row: Row<TData>) => string | undefined;
  className?: string;
  tableClassName?: string;
};

export function DataTable<TData>({
  table,
  isLoading = false,
  error = null,
  emptyMessage,
  onRowClick,
  getRowClassName,
  className,
  tableClassName,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const columnCount = Math.max(1, table.getVisibleLeafColumns().length);

  return (
    <div className={cn("overflow-hidden border border-border/80 bg-card/70 backdrop-blur-sm", className)}>
      <div className="overflow-x-auto">
        <Table className={cn("min-w-[48rem]", tableClassName)}>
          <TableHeader className="bg-muted/55">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-border/80 hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="h-auto px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {error ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-4">
                  <ErrorState label={error} />
                </TableCell>
              </TableRow>
            ) : isLoading && rows.length === 0 ? (
              Array.from({ length: 6 }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`} className="border-border/70">
                  {Array.from({ length: columnCount }).map((__, columnIndex) => (
                    <TableCell key={`skeleton-${rowIndex}-${columnIndex}`} className="px-4 py-4">
                      <Skeleton className="h-4 w-full max-w-44" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-4">
                  <EmptyState label={emptyMessage} />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(
                    "border-border/70 transition-colors",
                    onRowClick ? "cursor-pointer hover:bg-muted/35" : "hover:bg-transparent",
                    getRowClassName?.(row),
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-4 py-4 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
