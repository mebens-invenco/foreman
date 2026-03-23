import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NuqsAdapter } from "nuqs/adapters/react-router/v7"
import { BrowserRouter } from "react-router"

import { AppRoutes } from "@/app/routes"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

export default function App() {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NuqsAdapter>
          <ThemeProvider>
            <TooltipProvider>
              <AppRoutes />
              <Toaster position="bottom-right" richColors closeButton />
            </TooltipProvider>
          </ThemeProvider>
        </NuqsAdapter>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
