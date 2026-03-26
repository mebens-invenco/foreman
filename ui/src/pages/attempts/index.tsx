export function AttemptsPage() {
  return (
    <section className="border border-border/70 bg-card/75 p-6 md:p-8">
      <p className="text-xxs uppercase tracking-[0.32em] text-muted-foreground">
        Attempts
      </p>
      <h2 className="mt-4 text-3xl tracking-tight text-foreground">Execution activity will land here.</h2>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground">
        This route is now mounted inside the shared shell and ready for the live attempt
        table, worker state, and log stream panels. URL state can be layered in with
        `nuqs` once the attempt filters and drawer model are ported.
      </p>
    </section>
  )
}
