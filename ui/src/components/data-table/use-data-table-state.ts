import {
  functionalUpdate,
  type PaginationState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table"
import {
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryStates,
} from "nuqs"

const sortDirections = ["asc", "desc"] as const

type DataTableStateConfig = {
  defaultPageSize?: number
  defaultSort: {
    desc?: boolean
    id: string
  }
}

function normalizePageSize(pageSize: number, defaultPageSize: number) {
  return pageSize > 0 ? pageSize : defaultPageSize
}

export function useDataTableState({
  defaultPageSize = 25,
  defaultSort,
}: DataTableStateConfig) {
  const defaultDirection = defaultSort.desc ? "desc" : "asc"
  const [queryState, setQueryState] = useQueryStates(
    {
      dir: parseAsStringLiteral(sortDirections).withDefault(defaultDirection),
      page: parseAsInteger.withDefault(1),
      pageSize: parseAsInteger.withDefault(defaultPageSize),
      search: parseAsString.withDefault(""),
      sort: parseAsString.withDefault(defaultSort.id),
    },
    {
      history: "replace",
    }
  )

  const pageSize = normalizePageSize(queryState.pageSize, defaultPageSize)
  const pagination: PaginationState = {
    pageIndex: Math.max(queryState.page - 1, 0),
    pageSize,
  }
  const sorting: SortingState = [
    {
      desc: queryState.dir === "desc",
      id: queryState.sort,
    },
  ]

  const setGlobalFilter = (updater: Updater<string>) => {
    const next = functionalUpdate(updater, queryState.search)

    void setQueryState({
      page: 1,
      search: next || null,
    })
  }

  const setPageIndex = (pageIndex: number) => {
    void setQueryState({
      page: pageIndex + 1,
    })
  }

  const setPagination = (updater: Updater<PaginationState>) => {
    const next = functionalUpdate(updater, pagination)

    void setQueryState({
      page: Math.max(next.pageIndex + 1, 1),
      pageSize: normalizePageSize(next.pageSize, defaultPageSize),
    })
  }

  const setSorting = (updater: Updater<SortingState>) => {
    const next = functionalUpdate(updater, sorting)
    const primarySort = next[0] ?? {
      desc: defaultSort.desc ?? false,
      id: defaultSort.id,
    }

    void setQueryState({
      dir: primarySort.desc ? "desc" : "asc",
      page: 1,
      sort: primarySort.id,
    })
  }

  const resetBaseState = () => {
    void setQueryState({
      dir: null,
      page: null,
      pageSize: null,
      search: null,
      sort: null,
    })
  }

  return {
    globalFilter: queryState.search,
    hasBaseState:
      queryState.dir !== defaultDirection ||
      queryState.page !== 1 ||
      pageSize !== defaultPageSize ||
      queryState.search.length > 0 ||
      queryState.sort !== defaultSort.id,
    pagination,
    resetBaseState,
    setGlobalFilter,
    setPageIndex,
    setPagination,
    setSorting,
    sorting,
  }
}
