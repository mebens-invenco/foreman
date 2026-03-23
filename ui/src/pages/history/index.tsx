export function HistoryPage() {
  return (
    <section className="border border-border/70 bg-card/75 p-6 md:p-8">
      <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
        History
      </p>
      <h2 className="mt-4 text-3xl tracking-tight text-foreground">Run history has a stable route again.</h2>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground">
        The shell, sidebar navigation, and top bar are in place, so the next pass can focus
        on the historical execution list, filters, paging, and result drill-down without
        revisiting app bootstrap concerns.
      </p>
    </section>
  )
}
