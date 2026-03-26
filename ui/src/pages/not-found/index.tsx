import { Link } from "react-router"

import { defaultRoute } from "@/app/navigation"
import { Button } from "@/components/ui/button"

export function NotFoundPage() {
  return (
    <section className="border border-border/70 bg-card/75 p-6 md:p-8">
      <p className="text-xxs uppercase tracking-[0.32em] text-muted-foreground">
        Not found
      </p>
      <h2 className="mt-4 text-3xl tracking-tight text-foreground">That route is outside Foreman&apos;s current shell.</h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
        The page may have moved during the Svelte-to-React transition, or it may not have
        been rebuilt yet.
      </p>
      <Button asChild className="mt-6">
        <Link to={defaultRoute}>Go to overview</Link>
      </Button>
    </section>
  )
}
